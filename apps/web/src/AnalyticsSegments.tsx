import type { ReactElement } from 'react';
import type { BrowserSegmentFilter } from '@app-health/contracts';
import { FilterBar } from '@saas-maker/ui/blocks/filter-bar';
import { X } from 'lucide-react';
import { Button } from '@saas-maker/ui/components/button';
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
  emptyHint,
}: {
  filters: BrowserSegmentFilter;
  onRemove: (key: keyof BrowserSegmentFilter) => void;
  onClear: () => void;
  emptyHint?: string;
}): ReactElement {
  const entries = Object.entries(filters) as [keyof BrowserSegmentFilter, string][];
  return (
    <section aria-label="Report filters" className="space-y-2">
      {entries.length ? (
        <>
          <FilterBar>
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
                  <span className="min-w-0 break-all">
                    <span>{labels[key].toLowerCase()}: </span>
                    {key === 'country' ? countryName(value) : value}
                  </span>
                  <X className="shrink-0" />
                </Button>
              );
            })}
            <Button variant="ghost" size="sm" onClick={onClear}>
              clear all filters
            </Button>
          </FilterBar>
          <p className="text-xs leading-5 text-muted-foreground">
            showing events matching every filter, including the previous period. live sessions
            remain project-wide. clear filters to see whole-session engagement.
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {emptyHint ?? 'click a country, source, page, or audience value to filter this report.'}
        </p>
      )}
    </section>
  );
}
