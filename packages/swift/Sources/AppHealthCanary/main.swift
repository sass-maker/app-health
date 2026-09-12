import AppHealth
import Foundation

@main struct AppHealthCanary {
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        guard args.count >= 2, let endpoint = URL(string: args[0]) else { exit(2) }
        do { let c = try AppHealthClient(endpoint: endpoint, publicKey: args[1])
            await c.track("swift.canary", screen: "checkout")
            await c.log("swift.canary", props: ["platform": .string("swift")])
            await c.close()
            let d = await c.diagnostics()
            print(
                "accepted=\(d.accepted) dropped=\(d.dropped) retries=\(d.retries) queued=\(d.queued)"
            )
        } catch { print("invalid configuration: \(error)")
            exit(2)
        }
    }
}
