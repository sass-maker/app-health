import type { BrowserSegmentFilter } from '@app-health/contracts';
import { X } from 'lucide-react';
import { Button } from './components/ui/button.js';
import { countryName } from './country-name.js';

const labels: Record<keyof BrowserSegmentFilter, string> = {
  country: 'Country',
  source: 'Source',
  path: 'Page',
  entry_path: 'Entry page',
  device: 'Device',
  browser: 'Browser',
  channel: 'Channel',
  campaign: 'Campaign',
  medium: 'Medium',
  content: 'Campaign content',
  term: 'Campaign term',
};

export function AnalyticsSegments({
  filters,
  onRemove,
  onClear,
}: {
  filters: BrowserSegmentFilter;
  onRemove: (key: keyof BrowserSegmentFilter) => void;
  onClear: () => void;
}): JSX.Element {
  const entries = Object.entries(filters) as [keyof BrowserSegmentFilter, string][];
  return (
    <section aria-label="Report filters" className="space-y-2">
      {entries.length ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {entries.map(([key, value]) => {
              const label = `${labels[key]}: ${key === 'country' ? countryName(value) : value}`;
              return (
                <Button
                  key={key}
                  variant="secondary"
                  size="sm"
                  className="h-auto min-h-9 max-w-full whitespace-normal text-left"
                  aria-label={`Remove ${label} filter`}
                  onClick={() => onRemove(key)}
                >
                  <span className="min-w-0 break-all">{label}</span>
                  <X className="shrink-0" />
                </Button>
              );
            })}
            <Button variant="ghost" size="sm" onClick={onClear}>
              Clear all filters
            </Button>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            Showing events matching every filter, including the previous period. Live sessions
            remain project-wide. Clear filters to see whole-session engagement.
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Click a country, source, page, or audience value to filter this report.
        </p>
      )}
    </section>
  );
}
