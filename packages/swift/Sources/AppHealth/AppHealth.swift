import Foundation

public enum AppHealthScalar: Codable, Sendable, Equatable {
    case string(String), number(Double), boolean(Bool), null
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let v = try? c.decode(Bool.self) {
            self = .boolean(v)
        } else if let v = try? c.decode(Double.self) {
            self = .number(v)
        } else {
            self = try .string(c.decode(String.self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case let .string(v): try c.encode(v)
        case let .number(v): try c.encode(v)
        case let .boolean(v): try c.encode(v)
        case .null: try c.encodeNil() }
    }
}

public enum AppHealthLogLevel: String, Codable, Sendable { case debug, info, warn, error }
public struct AppHealthDiagnostics: Sendable,
    Equatable
{ public let accepted, dropped, retries, queued: Int
    public init(accepted: Int, dropped: Int, retries: Int, queued: Int) {
        self.accepted = accepted
        self.dropped = dropped
        self.retries = retries
        self.queued = queued
    }
}

public struct AppHealthResponse: Sendable { public let statusCode: Int
    public init(statusCode: Int) {
        self.statusCode = statusCode
    }
}

public protocol AppHealthTransport: Sendable {
    func send(_ request: URLRequest) async throws -> AppHealthResponse
}

public struct AppHealthURLSessionTransport: AppHealthTransport {
    private let session: URLSession
    public init() {
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieStorage = nil
        c.urlCache = nil
        c.timeoutIntervalForRequest = 2
        c.timeoutIntervalForResource = 2
        session = URLSession(configuration: c)
    }

    public func send(_ request: URLRequest) async throws -> AppHealthResponse {
        let (_, r) = try await session.data(for: request)
        return AppHealthResponse(statusCode: (r as? HTTPURLResponse)?.statusCode ?? 0)
    }
}

public enum AppHealthError: Error, Equatable { case invalidEndpoint, invalidPublicKey }

public actor AppHealthClient {
    private struct Event: Codable, Sendable { let event_id: String
        let timestamp: Int64
        let name: String
        let screen: String?
    }

    private struct Log: Codable, Sendable { let log_id: String
        let timestamp: Int64
        let event: String
        let level: AppHealthLogLevel
        let props: [String: AppHealthScalar]
        let title: String?
        let description: String?
        let icon: String?
    }

    private struct Batch: Codable, Sendable { let schema_version: Int
        let public_key: String
        let batch_id: String
        let session_id: String
        let active: Bool
        let events: [Event]
        let logs: [Log]
    }

    private struct Item: Sendable { let event: Event?
        let log: Log?
    }

    private let endpoint: URL
    private let publicKey: String
    private let transport: any AppHealthTransport
    private let now: @Sendable () -> Int64
    private let sleep: @Sendable (UInt64) async -> Void
    private var active = false, closed = false, pending: [Item] = [], inFlight = 0, accepted = 0,
                dropped = 0, retries = 0
    private var drainTask: Task<Void, Never>?, flushTimer: Task<Void, Never>?, heartbeatTimer: Task<
        Void,
        Never
    >?
    private var heartbeatDue = false
    private var sessionID = UUID()
    private var sessionDay: Int64
    private var lastActivity: Int64
    public init(
        endpoint: URL,
        publicKey: String,
        transport: any AppHealthTransport = AppHealthURLSessionTransport(),
        now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        sleep: @escaping @Sendable (UInt64) async
            -> Void = { try? await Task.sleep(nanoseconds: $0) }
    ) throws {
        guard let scheme = endpoint.scheme?.lowercased(), ["http", "https"].contains(scheme),
              endpoint.host != nil, endpoint.user == nil,
              endpoint.password == nil else { throw AppHealthError.invalidEndpoint }
        guard publicKey.range(of: "^ahk_native_[a-f0-9]{64}$", options: .regularExpression) != nil
        else { throw AppHealthError.invalidPublicKey }
        self.endpoint = endpoint.appendingPathComponent("v1/native")
        self.publicKey = publicKey
        self.transport = transport
        self.now = now
        self.sleep = sleep
        lastActivity = now()
        sessionDay = lastActivity / 86_400_000
    }

    public func track(_ name: String, screen: String? = nil) {
        guard !closed, let n = Self.slug(name, "^[a-z][a-z0-9_.:-]*$", 64),
              screen == nil || Self.slug(
                  screen!,
                  "^[a-z][a-z0-9_-]*$",
                  64
              ) != nil
        else { dropped += 1
            return
        }
        enqueue(Item(
            event: Event(
                event_id: UUID().uuidString.lowercased(),
                timestamp: now(),
                name: n,
                screen: screen
            ),
            log: nil
        ))
    }

    public func log(
        _ event: String,
        level: AppHealthLogLevel = .info,
        props: [String: AppHealthScalar] = [:],
        title: String? = nil,
        description: String? = nil,
        icon: String? = nil
    ) {
        guard !closed, let e = Self.slug(event, "^[a-z0-9][a-z0-9_.:-]*$", 64), props.count <= 40,
              props.keys.allSatisfy({ !$0.isEmpty && $0.utf16.count <= 64 }),
              props.values.allSatisfy(Self.validScalar), Self.validText(
                  title,
                  200
              ), Self.validText(description, 2000), Self.validText(icon, 16)
        else { dropped += 1
            return
        }
        enqueue(Item(
            event: nil,
            log: Log(
                log_id: UUID().uuidString.lowercased(),
                timestamp: now(),
                event: e,
                level: level,
                props: props,
                title: title,
                description: description,
                icon: icon
            )
        ))
    }

    public func setActive(_ value: Bool) {
        guard !closed, active != value else { return }
        active = value
        heartbeatTimer?.cancel()
        heartbeatTimer = nil
        if value {
            scheduleHeartbeat()
        }
        heartbeatDue = value
        requestDrain()
    }

    public func flush() async {
        requestDrain()
        await drainTask?.value
    }

    public func diagnostics() -> AppHealthDiagnostics {
        AppHealthDiagnostics(
            accepted: accepted,
            dropped: dropped,
            retries: retries,
            queued: pending.count + inFlight
        )
    }

    public func close() async {
        if closed {
            await drainTask?.value
            return
        }
        closed = true
        active = false
        heartbeatDue = false
        flushTimer?.cancel()
        heartbeatTimer?.cancel()
        flushTimer = nil
        heartbeatTimer = nil
        requestDrain()
        await drainTask?.value
        pending.removeAll()
    }

    private func enqueue(_ item: Item) {
        guard pending.count + inFlight < 200 else { dropped += 1
            return
        }
        refreshSession()
        pending.append(item)
        if pending.count >= 25 {
            requestDrain()
        }
        scheduleFlush()
    }

    private func refreshSession() {
        let current = now()
        if current - lastActivity >= 1_800_000 || current / 86_400_000 != sessionDay {
            sessionID = UUID()
            sessionDay = current / 86_400_000
        }
        lastActivity = current
    }

    private func requestDrain() {
        guard drainTask == nil, !pending.isEmpty || heartbeatDue else { return }
        flushTimer?.cancel()
        flushTimer = nil
        drainTask = Task { [weak self] in await self?.drainLoop() }
    }

    private func drainLoop() async {
        defer { drainTask = nil }
        while !pending.isEmpty || heartbeatDue {
            if pending.isEmpty, heartbeatDue {
                heartbeatDue = false
                await send([])
                continue
            }
            let items = Array(pending.prefix(25))
            heartbeatDue = false
            pending.removeFirst(items.count)
            inFlight += items.count
            await send(items)
            inFlight -= items.count
        }
    }

    private func send(_ items: [Item]) async {
        refreshSession()
        let batch = Batch(
            schema_version: 1,
            public_key: publicKey,
            batch_id: UUID().uuidString.lowercased(),
            session_id: sessionID.uuidString.lowercased(),
            active: active,
            events: items.compactMap(\.event),
            logs: items.compactMap(\.log)
        )
        guard let body = try? JSONEncoder().encode(batch) else { dropped += items.count
            return
        }
        if body.count > 65536 {
            if items.count > 1 {
                let midpoint = items.count / 2
                await send(Array(items[..<midpoint]))
                await send(Array(items[midpoint...]))
            } else {
                dropped += items.count
            }
            return
        }
        var r = URLRequest(url: endpoint)
        r.httpMethod = "POST"
        r.httpBody = body
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        for attempt in 0 ..< 3 {
            do {
                let response = try await transport.send(r)
                if (200 ..< 300).contains(response.statusCode) {
                    accepted += items.count
                    return
                }
                guard response.statusCode == 429 || response.statusCode >= 500,
                      attempt < 2
                else { dropped += items.count
                    return
                }
            } catch { guard attempt < 2 else { dropped += items.count
                return
            } }
            retries += 1
            await sleep(UInt64(100_000_000 * (1 << attempt)))
        }
    }

    private func scheduleFlush() {
        guard flushTimer == nil, drainTask == nil, !pending.isEmpty else { return }
        flushTimer = Task { [weak self] in await self?.sleep(2_000_000_000)
            guard !Task.isCancelled else { return }
            await self?.timerFired()
        }
    }

    private func timerFired() {
        flushTimer = nil
        requestDrain()
    }

    private func scheduleHeartbeat() {
        heartbeatTimer = Task { [weak self] in await self?.sleep(30_000_000_000)
            guard !Task.isCancelled else { return }
            await self?.heartbeat()
        }
    }

    private func heartbeat() {
        heartbeatTimer = nil
        guard active,!closed else { return }
        heartbeatDue = true
        requestDrain()
        scheduleHeartbeat()
    }

    private static func slug(_ v: String, _ p: String, _ m: Int) -> String? {
        v.utf16.count > 0 && v.utf16.count <= m && v
            .range(of: p, options: .regularExpression) != nil ? v : nil
    }

    private static func validText(_ v: String?, _ m: Int) -> Bool {
        guard let v else { return true }
        let trimmed = v.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.utf16.count <= m
    }

    private static func validScalar(_ v: AppHealthScalar) -> Bool {
        if case let .string(value) = v {
            return value.utf16.count <= 500
        }
        if case let .number(n) = v {
            return n.isFinite
        }
        return true
    }
}
