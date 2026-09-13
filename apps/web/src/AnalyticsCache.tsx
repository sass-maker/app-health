import { createContext, useContext, useState, type ReactNode } from 'react';
import type { BrowserReport } from '@app-health/contracts';

interface Entry {
  report: BrowserReport;
  expires: number;
}
const ReportCache = createContext<Map<string, Entry> | null>(null);

/** Dashboard-lifetime only: no storage, credentials, or data survive sign-out. */
export function AnalyticsCacheProvider({ children }: { children: ReactNode }) {
  const [cache] = useState(() => new Map<string, Entry>());
  return <ReportCache.Provider value={cache}>{children}</ReportCache.Provider>;
}

export function useReportCache() {
  const cache = useContext(ReportCache);
  return {
    read(scope: string) {
      const entry = cache?.get(scope);
      if (!entry || entry.expires <= Date.now()) return null;
      return entry.report;
    },
    write(scope: string, report: BrowserReport) {
      if (!cache) return;
      cache.delete(scope);
      if (cache.size >= 12) cache.delete(cache.keys().next().value!);
      cache.set(scope, { report, expires: Date.now() + 60_000 });
    },
  };
}
