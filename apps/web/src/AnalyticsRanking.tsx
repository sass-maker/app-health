import type { ReactElement } from 'react';
import { DataTable, type DataColumn } from './components/ResourceTable.js';
import { EmptyState } from '@saas-maker/ui/components/empty-state';
import { Card, CardContent, CardHeader } from '@saas-maker/ui/components/card';

type RankingRow = { name: string; count: number; value?: string };

export function AnalyticsRanking(props: {
  title: string;
  label: string;
  rows: RankingRow[];
  onSelect?: (value: string) => void;
  total?: number;
  tone?: string;
  description?: string;
}): ReactElement {
  const { title, label, rows, total } = props;
  const max = Math.max(1, ...rows.map((row) => row.count));
  const columns: DataColumn<RankingRow>[] = [
    {
      id: 'name',
      header: title.toLowerCase(),
      value: (row) => row.name,
      sortable: false,
      hideable: false,
      minWidth: '8rem',
      className: 'relative whitespace-normal',
      cell: (row) => (
        <>
          <span
            aria-hidden="true"
            className="absolute inset-y-1 left-0 rounded-r-sm opacity-15"
            style={{
              width: `${(row.count / max) * 100}%`,
              backgroundColor: props.tone ?? 'var(--chart-1)',
            }}
          />
          <span className="relative break-words text-xs" title={row.name}>
            {props.onSelect ? (
              <button
                type="button"
                className="min-h-6 w-full text-left underline-offset-4 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                aria-label={`Filter ${title} by ${row.name}`}
                onClick={() => props.onSelect?.(row.value ?? row.name)}
              >
                {row.name}
              </button>
            ) : (
              row.name
            )}
          </span>
        </>
      ),
    },
    {
      id: 'count',
      header: label.toLowerCase(),
      value: (row) => row.count,
      sortable: false,
      hideable: false,
      align: 'right',
      className: 'text-xs font-medium tabular-nums',
      cell: (row) => (
        <>
          {row.count.toLocaleString()}
          {total !== undefined && total > 0 ? (
            <span className="ml-3 inline-block w-12 text-right font-normal text-muted-foreground">
              {((row.count / total) * 100).toFixed(1)}%
            </span>
          ) : null}
        </>
      ),
    },
  ];
  return (
    <Card className="gap-0 overflow-hidden pb-0 shadow-none">
      <CardHeader className="flex flex-row items-center justify-between border-b pb-4">
        <h2 className="text-sm font-semibold">{title.toLowerCase()}</h2>
        <span className="text-xs text-muted-foreground">{label.toLowerCase()}</span>
      </CardHeader>
      <CardContent className="p-0">
        <DataTable
          data={rows}
          columns={columns}
          getRowId={(row) => row.name}
          label={title}
          pageSize={Math.max(1, rows.length)}
          maxHeight="none"
          className="gap-0 [&>div:first-child]:hidden [&>div[role=region]]:rounded-none [&>div[role=region]]:border-0"
          empty={<EmptyState title="no activity in this period." className="py-8" />}
        />
      </CardContent>
      {props.description ? (
        <p className="border-t px-5 py-3 text-xs leading-5 text-muted-foreground">
          {props.description}
        </p>
      ) : null}
    </Card>
  );
}
