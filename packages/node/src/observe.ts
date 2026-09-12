/** Instrumentation must never change an application response or thrown error. */
export function observe<T>(action: () => T): T | undefined {
  try {
    return action();
  } catch {
    // An optional hook or custom client can fail independently of the application.
  }
}
