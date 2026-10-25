/** Global API exposed by the opt-in /tracker.js script. */
export interface AppHealthTracker {
  page(path?: string): void;
  track(name: string, properties?: Record<string, string | number | boolean>, value?: number): void;
  flush(): Promise<void>;
  /** Enable or revoke collection; data-consent="required" starts with collection disabled. */
  consent(granted: boolean): void;
  /** Persist this project's local exclusion preference; false undoes it. */
  ignore(ignored?: boolean): void;
  isIgnored(): boolean;
  /** Explicit checkout metadata: normalized source, entry page and campaign; no identity. */
  checkoutMetadata(): Record<string, string>;
  stop(): void;
  diagnostics(): { accepted: number; dropped: number; retries: number; queued: number };
}
declare global {
  interface Window {
    appHealth?: AppHealthTracker;
  }
}
