# Native app integration

App Health's Foundation-only Swift package supports iOS 15+ and macOS 12+ with Swift 6. It provides explicit named analytics events, leveled logs and opt-in foreground sessions. It does not intercept URLSession, measure native endpoint requests automatically, or collect HealthKit, App Store Connect, device identifiers or user identities.

Create a project and environment, then open Project settings → Swift apps → Create native public key. This separate `ahk_native_` key is safe to distribute in an app: it authorizes public claims for that environment only. It cannot read analytics, manage projects or submit trusted server measurements. Keep private server keys out of native apps. Five active keys per environment allow rotation; revocation is checked on every batch. Raw keys are shown once and only their SHA-256 verifiers are stored.

Add `packages/swift` as a local Swift package until a release is published:

```swift
import AppHealth
import Foundation

let health = try AppHealthClient(
    endpoint: URL(string: "https://your-collector.example")!,
    publicKey: "ahk_native_REPLACE_WITH_PROJECT_KEY"
)
await health.track("onboarding.completed", screen: "welcome")
await health.log("sync.completed", level: .info, props: ["items": .number(12)])
await health.flush()
```

Pass the collector origin, without `/v1/native`. Forward your app's foreground/background transitions to `setActive(true)` and `setActive(false)`. Activation sends presence immediately, then every 30 seconds while active. Live counts represent sessions, not unique people; inactive sessions expire after 45 seconds. Sessions use random in-memory IDs rotated at UTC day boundaries and after 30 minutes of inactivity. Named native events appear in Events; they do not fabricate web pageviews.

The client batches after 2 seconds or 25 items, holds at most 200 items including in-flight work, and splits UTF-8 payloads below 64 KiB. Delivery retries transient failures twice with a stable batch ID and body. URLSession uses a 2-second request/resource timeout, no cookie storage and no URL cache. `close()` stops admission/timers and awaits the shared drain. Call it for deterministic shutdown where the host allows time; termination delivery is not guaranteed. There is no disk queue or offline replay. Diagnostics distinguish acknowledged items, rejected/dropped items, retries and queued work.

Native keys have a 600-item-per-minute quota, with heartbeats counting as one item. Analytics reuse the bounded Queue → archive pipeline; compressed raw archives expire after 30 days. Logs use the existing 30-day store and carry `source: native`; they do not route to legacy Slack webhooks. Analytics Engine projection remains best-effort; archive replay/reconciliation is a separate outstanding capability.

Local qualification includes Swift actor lifecycle tests, actual Swift executable → collector HTTP, and real workerd/D1/Queue ingestion and revocation tests. Run `scripts/verify-swift-runtime.mjs` after building the Swift package. Provider activation and additive migration `0010_native_keys.sql` have not been applied to production by this work.
