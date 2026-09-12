@testable import AppHealth
import Foundation
import XCTest

private actor GateTransport: AppHealthTransport {
    var bodies: [Data] = []
    var waiting = false
    private var resume: CheckedContinuation<Void, Never>?
    func send(_ request: URLRequest) async throws -> AppHealthResponse {
        bodies.append(request.httpBody!)
        if bodies.count == 1 {
            waiting = true
            await withCheckedContinuation { resume = $0 }
        }
        return AppHealthResponse(statusCode: 202)
    }

    func release() {
        resume?.resume()
        resume = nil
    }
}

private actor Completion {
    var count = 0
    func finish() {
        count += 1
    }
}

private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Int64 = 86_399_000
    func now() -> Int64 {
        lock.withLock { value }
    }

    func advance() {
        lock.withLock { value += 86_400_000 }
    }
}

final class LifecycleTests: XCTestCase {
    func testHeartbeatQueueAndConcurrentCloseKeepAllAdmittedItems() async throws {
        let transport = GateTransport()
        let completed = Completion()
        let client = try AppHealthClient(
            endpoint: XCTUnwrap(URL(string: "https://collector.test")),
            publicKey: "ahk_native_" + String(repeating: "a", count: 64),
            transport: transport
        )
        await client.setActive(true)
        while await !(transport.waiting) {
            await Task.yield()
        }
        for _ in 0 ..< 205 {
            await client.track("checkout")
        }
        let queued = await client.diagnostics()
        XCTAssertEqual(queued.queued, 200)
        XCTAssertEqual(queued.dropped, 5)
        let first = Task { await client.close()
            await completed.finish()
        }
        let second = Task { await client.close()
            await completed.finish()
        }
        for _ in 0 ..< 100 {
            await Task.yield()
        }
        let before = await completed.count
        XCTAssertEqual(
            before,
            0,
            "Both close callers must await the blocked heartbeat and queued work"
        )
        await transport.release()
        await first.value
        await second.value
        let done = await client.diagnostics()
        XCTAssertEqual(done.accepted, 200)
        XCTAssertEqual(done.queued, 0)
        let bodies = await transport.bodies
        XCTAssertEqual(bodies.count, 9, "One heartbeat plus eight 25-item batches")
    }

    func testForegroundSessionsRotateAtUtcDayAndActivationIsIdempotent() async throws {
        let clock = TestClock()
        let transport = GateTransport()
        let client = try AppHealthClient(
            endpoint: XCTUnwrap(URL(string: "https://collector.test")),
            publicKey: "ahk_native_" + String(repeating: "a", count: 64),
            transport: transport,
            now: { clock.now() }
        )
        await client.setActive(true)
        while await !(transport.waiting) {
            await Task.yield()
        }
        await client.setActive(true)
        await transport.release()
        await client.flush()
        clock.advance()
        await client.setActive(false)
        await client.setActive(true)
        await client.flush()
        await client.close()
        let bodies = await transport.bodies
        XCTAssertEqual(bodies.count, 2)
        let first = try XCTUnwrap(try JSONSerialization
            .jsonObject(with: bodies[0]) as? [String: Any])
        let second = try XCTUnwrap(try JSONSerialization
            .jsonObject(with: bodies[1]) as? [String: Any])
        XCTAssertNotEqual(first["session_id"] as? String, second["session_id"] as? String)
        XCTAssertEqual(second["active"] as? Bool, true)
    }
}
