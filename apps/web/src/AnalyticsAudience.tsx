import { AnalyticsComparison } from './AnalyticsComparison.js';
import type { BrowserReport, BrowserSegmentFilter } from '@app-health/contracts';
import { countryName } from './country-name.js';
import { AnalyticsRanking } from './AnalyticsRanking.js';

export function AnalyticsAudience({
  report,
  breakdown,
  metric = 'pageviews',
  onFilter,
}: {
  report: BrowserReport;
  breakdown: 'audience' | 'acquisition' | 'technology';
  metric?: 'pageviews' | 'events';
  onFilter?: (key: keyof BrowserSegmentFilter, value: string) => void;
}): JSX.Element {
  const audience = report.audience;
  if (!audience)
    return (
      <p className="text-sm text-muted-foreground">
        Audience identity is unavailable for this period.
      </p>
    );
  const total = report.series.reduce((sum, row) => sum + row[metric], 0);
  const previous = report.previous?.visitors;
  const groups = audienceGroups(audience, breakdown);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
        {[
          ['Visitors', audience.visitors],
          ['New sessions', audience.new_sessions],
          ['Returning sessions', audience.returning_sessions],
          ['Unidentified sessions', audience.unidentified_sessions],
        ].map(([label, value]) => (
          <div key={String(label)} className="bg-card p-4">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">
              {Number(value).toLocaleString()}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {report.sampled ? 'Sampled lower bound' : 'Browser-scoped'}
            </p>
            {label === 'Visitors' ? (
              <AnalyticsComparison
                current={audience.visitors}
                previous={previous}
                label="Visitors"
                sampled={report.sampled}
                unique={true}
              />
            ) : null}
          </div>
        ))}
      </div>
      <div className="grid gap-5 xl:grid-cols-3">
        {groups.map(([title, rows]) => (
          <AnalyticsRanking
            key={String(title)}
            title={String(title)}
            label={metric === 'events' ? 'Occurrences' : 'Page views'}
            rows={rows as { name: string; count: number; value?: string }[]}
            total={total}
            tone={String(title) === 'Countries' ? 'var(--chart-3)' : 'var(--chart-2)'}
            description={
              String(title) === 'Countries'
                ? 'Connection location from the edge. Unknown means location was not recorded, including older events. VPNs may change the reported country.'
                : undefined
            }
            onSelect={
              onFilter ? (value) => onFilter(dimensionKeys[String(title)], value) : undefined
            }
          />
        ))}
      </div>
      {breakdown === 'acquisition' ? (
        <p className="text-xs leading-5 text-muted-foreground">
          Campaign details come from UTM tags; referral sources work without them. Percentages
          include untagged traffic in the total.
        </p>
      ) : null}
      <p className="text-xs leading-5 text-muted-foreground">
        Visitors are browser-scoped. Legacy sessions without identity appear as unknown; sampled
        unique counts are lower bounds. Countries describe connection location and may reflect a
        VPN.
      </p>
    </div>
  );
}

const dimensionKeys: Record<string, keyof BrowserSegmentFilter> = {
  Channels: 'channel',
  'Entry pages': 'entry_path',
  Countries: 'country',
  Campaigns: 'campaign',
  Mediums: 'medium',
  'Campaign content': 'content',
  'Campaign terms': 'term',
  Devices: 'device',
  Browsers: 'browser',
};

function audienceGroups(audience: NonNullable<BrowserReport['audience']>, breakdown: string) {
  const groups =
    breakdown === 'audience'
      ? [
          ['Channels', audience.channels],
          ['Entry pages', audience.entry_pages],
          [
            'Countries',
            audience.countries.map((row) => ({
              ...row,
              value: row.name,
              name: countryName(row.name),
            })),
          ],
        ]
      : breakdown === 'acquisition'
        ? [
            ['Campaigns', audience.campaigns],
            ['Channels', audience.channels],
            ['Mediums', audience.mediums ?? []],
            ['Campaign content', audience.contents ?? []],
            ['Campaign terms', audience.terms ?? []],
          ]
        : [
            ['Devices', audience.devices],
            ['Browsers', audience.browsers],
            [
              'Countries',
              audience.countries.map((row) => ({
                ...row,
                value: row.name,
                name: countryName(row.name),
              })),
            ],
          ];
  return groups;
}
