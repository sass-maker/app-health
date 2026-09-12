import { Card, CardContent, CardHeader } from './components/ui/card.js';

export function AnalyticsRanking(props: {
  title: string;
  label: string;
  rows: { name: string; count: number }[];
  total?: number;
}): JSX.Element {
  const { title, label, rows, total } = props;
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <Card className="gap-0 overflow-hidden pb-0 shadow-none">
      <CardHeader className="flex flex-row items-center justify-between border-b pb-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-muted-foreground">{label}</span>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length ? (
          <ol>
            {rows.map((row) => (
              <li
                key={row.name}
                className="relative flex items-center gap-4 border-b px-5 py-3.5 last:border-0"
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-y-1 left-0 bg-primary/7"
                  style={{ width: `${(row.count / max) * 100}%` }}
                />
                <span
                  className="relative min-w-0 flex-1 break-all font-mono text-xs"
                  title={row.name}
                >
                  {row.name}
                </span>
                <strong className="relative text-xs font-medium tabular-nums">
                  {row.count.toLocaleString()}
                  {total !== undefined && total > 0 ? (
                    <span className="ml-3 inline-block w-12 text-right font-normal text-muted-foreground">
                      {((row.count / total) * 100).toFixed(1)}%
                    </span>
                  ) : null}
                </strong>
              </li>
            ))}
          </ol>
        ) : (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No activity in this period.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
