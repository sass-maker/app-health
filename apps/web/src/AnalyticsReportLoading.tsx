import { Card, CardContent } from '@saas-maker/ui/components/card';
import { DataTableSkeleton } from './components/ResourceTable.js';
import { Skeleton } from '@saas-maker/ui/components/skeleton';
import { StatTileSkeleton } from '@saas-maker/ui/blocks/skeletons';

export function AnalyticsReportLoading({ label = 'Loading analytics' }: { label?: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-4">
      <span className="sr-only">loading</span>
      <div aria-hidden="true" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <StatTileSkeleton key={i} announce={false} className="shadow-none" />
        ))}
      </div>
      <Card aria-hidden="true" className="shadow-none">
        <CardContent className="space-y-6 p-6">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
      <div aria-hidden="true" className="grid gap-4 md:grid-cols-2">
        {[0, 1].map((i) => (
          <DataTableSkeleton
            key={i}
            announce={false}
            rows={3}
            columns={[
              { id: 'name', header: 'name', minWidth: '8rem' },
              { id: 'count', header: 'views', align: 'right' },
            ]}
            className="gap-0 [&>div:first-child]:hidden"
            maxHeight="none"
          />
        ))}
      </div>
    </div>
  );
}
