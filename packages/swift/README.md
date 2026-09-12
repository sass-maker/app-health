# AppHealth Swift SDK

Foundation-only Swift Package Manager client for explicit native analytics and application logs. It sends batches to `{endpoint}/v1/native`, keeps at most 200 items in memory, retries transient failures twice, and never installs URL session hooks or collects private device data. Configure an `ahk_native_` public key and an absolute HTTP(S) endpoint.

Requires Swift 6, iOS 15+ or macOS 12+. Add this directory as a local package until publication. See [native integration](../../docs/native-integration.md) for setup, lifecycle, limits and verification. Call `setActive` from your foreground/background lifecycle; `close()` stops timers and drains admitted work. Delivery is bounded and best-effort, with no persistent offline queue.
