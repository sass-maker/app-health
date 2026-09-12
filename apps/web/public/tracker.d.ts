/** Global API exposed by the opt-in /tracker.js script. */
export interface AppHealthTracker {
  page(path?: string): void;
  track(name: string): void;
  flush(): Promise<void>;
  stop(): void;
  diagnostics(): { accepted: number; dropped: number; retries: number; queued: number };
}
declare global {
  interface Window {
    appHealth?: AppHealthTracker;
  }
}
