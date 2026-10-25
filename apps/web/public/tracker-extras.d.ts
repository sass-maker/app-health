import type { AppHealthTracker } from './tracker.js';
/** Automatic events are explicitly enabled by the owning script's data attributes. */
export function start(
  tracker: AppHealthTracker,
  script: HTMLScriptElement,
): (() => void) & { page?: () => void };

export function assetURL(script: HTMLScriptElement, filename: string): string | undefined;
