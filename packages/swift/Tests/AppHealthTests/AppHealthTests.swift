@testable import AppHealth
import Foundation
import XCTest

private struct FakeTransport: AppHealthTransport {
    let result: AppHealthResponse
    func send(_: URLRequest) async throws -> AppHealthResponse {
        result
    }
}

final class AppHealthTests: XCTestCase {
    let key = "ahk_native_" + String(repeating: "a", count: 64)

    func testRejectsPrivateKeyAndCredentialEndpoint() throws {
        XCTAssertThrowsError(try AppHealthClient(
            endpoint: XCTUnwrap(URL(string: "https://user:pass@example.com")),
            publicKey: key
        ))
        XCTAssertThrowsError(try AppHealthClient(
            endpoint: XCTUnwrap(URL(string: "https://example.com")),
            publicKey: "private-key"
        ))
    }

    func testCloseDrainsMoreThanOneBatch() async throws {
        let transport = RecordingTransport()
        let client = try AppHealthClient(
            endpoint: XCTUnwrap(URL(string: "https://example.com")),
            publicKey: key,
            transport: transport
        )
        for _ in 0 ..< 75 {
            await client.track("checkout")
        }
        await client.close()
        let d = await client.diagnostics()
        XCTAssertEqual(d.accepted, 75)
        XCTAssertEqual(d.dropped, 0)
        XCTAssertEqual(d.queued, 0)
        let bodyCount = await transport.bodies.count
        XCTAssertGreaterThan(bodyCount, 1)
        XCTAssertLessThanOrEqual(bodyCount, 75)
    }

    func testExplicitFlushUsesNativeRouteAndBody() async throws {
        let transport = RecordingTransport()
        let client = try AppHealthClient(
            endpoint: XCTUnwrap(URL(string: "https://example.com/collector")),
            publicKey: key,
            transport: transport,
            sleep: { _ in }
        )
        await client.track("swift.canary", screen: "checkout")
        await client.flush()
        let path = await transport.paths.last
        let body = await transport.bodies.last
        XCTAssertEqual(path, "/collector/v1/native")
        XCTAssertTrue(body?.contains("\"schema_version\":1") == true)
    }

    func testPermanentRejectionIsDroppedAndNotAccepted() async throws {
        let transport = RecordingTransport(status: 400)
        let client = try AppHealthClient(
            endpoint: XCTUnwrap(URL(string: "https://example.com")),
            publicKey: key,
            transport: transport,
            sleep: { _ in }
        )
        await client.track("checkout")
        await client.flush()
        let d = await client.diagnostics()
        XCTAssertEqual(d.accepted, 0)
        XCTAssertEqual(d.dropped, 1)
    }

    func testInvalidLogPropsAreDropped() async throws {
        let client = try AppHealthClient(
            endpoint: XCTUnwrap(URL(string: "https://example.com")),
            publicKey: key,
            transport: RecordingTransport()
        )
        await client.log("checkout", props: ["bad": .number(.infinity)])
        let diagnostics = await client.diagnostics()
        XCTAssertEqual(diagnostics.dropped, 1)
    }

    func testTransientRetryReusesRequestBody() async throws {
        let transport = RecordingTransport(statuses: [503, 204])
        let client = try AppHealthClient(
            endpoint: XCTUnwrap(URL(string: "https://example.com")),
            publicKey: key,
            transport: transport,
            sleep: { _ in }
        )
        await client.track("checkout")
        await client.flush()
        let bodies = await transport.bodies
        XCTAssertEqual(bodies.count, 2)
        XCTAssertEqual(bodies[0], bodies[1])
        let diagnostics = await client.diagnostics()
        XCTAssertEqual(diagnostics.accepted, 1)
    }

    func testSub25ItemsWaitForFlush() async throws {
        let transport = RecordingTransport()
        let client = try AppHealthClient(
            endpoint: XCTUnwrap(URL(string: "https://example.com")),
            publicKey: key,
            transport: transport,
            sleep: { _ in try? await Task.sleep(nanoseconds: 2_000_000_000) }
        )
        for _ in 0 ..< 24 {
            await client.track("checkout")
        }
        let before = await client.diagnostics()
        XCTAssertEqual(before.queued, 24)
        await client.flush()
        let after = await client.diagnostics()
        XCTAssertEqual(after.accepted, 24)
    }

    func testUTF16AndInvalidScreenAreRejected() async throws {
        let client = try AppHealthClient(
            endpoint: XCTUnwrap(URL(string: "https://example.com")),
            publicKey: key,
            transport: RecordingTransport()
        )
        await client.track("checkout", screen: "Invalid Screen")
        await client.log("checkout", props: ["value": .string(String(repeating: "😀", count: 251))])
        let diagnostics = await client.diagnostics()
        XCTAssertEqual(diagnostics.dropped, 2)
    }

    func testLargeUTF8BatchesSplitUnderWireLimit() async throws {
        let transport = RecordingTransport()
        let client = try AppHealthClient(
            endpoint: XCTUnwrap(URL(string: "https://example.com")),
            publicKey: key,
            transport: transport
        )
        let props = Dictionary(uniqueKeysWithValues: (0 ..< 40).map { (
            "key\($0)",
            AppHealthScalar.string(String(repeating: "é", count: 500))
        ) })
        for _ in 0 ..< 4 {
            await client.log("large", props: props)
        }
        await client.flush()
        for body in await transport.bodies {
            XCTAssertLessThanOrEqual(
                try XCTUnwrap(body.data(using: .utf8)?.count),
                65536
            )
        }
    }

    func testBlockedTransportRepeatedCloseWaitsAndDrains() async throws {
        let transport = BlockingTransport()
        let client = try AppHealthClient(
            endpoint: XCTUnwrap(URL(string: "https://example.com")),
            publicKey: key,
            transport: transport,
            sleep: { _ in }
        )
        await client.track("checkout")
        let first = Task { await client.close() }
        while await !(transport.started) {
            await Task.yield()
        }
        let second = Task { await client.close() }
        XCTAssertFalse(second.isCancelled)
        await transport.release()
        await first.value
        await second.value
        let diagnostics = await client.diagnostics()
        XCTAssertEqual(diagnostics.accepted, 1)
    }
}

private actor RecordingTransport: AppHealthTransport {
    var paths: [String] = [], bodies: [String] = []
    var statuses: [Int]
    init(status: Int = 204) {
        statuses = [status]
    }

    init(statuses: [Int]) {
        self.statuses = statuses
    }

    func send(_ request: URLRequest) async throws -> AppHealthResponse {
        paths.append(request.url?.path ?? "")
        bodies.append(String(data: request.httpBody ?? Data(), encoding: .utf8) ?? "")
        return AppHealthResponse(statusCode: statuses.isEmpty ? 204 : statuses.removeFirst())
    }
}

private actor BlockingTransport: AppHealthTransport {
    var started = false
    private var continuation: CheckedContinuation<AppHealthResponse, Never>?
    func send(_: URLRequest) async throws -> AppHealthResponse {
        started = true
        return await withCheckedContinuation { continuation = $0 }
    }

    func release() {
        continuation?.resume(returning: AppHealthResponse(statusCode: 204))
        continuation = nil
    }
}
