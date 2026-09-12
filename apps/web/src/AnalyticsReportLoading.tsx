import { Card, CardContent } from './components/ui/card.js';
import { Skeleton } from './components/ui/skeleton.js';

export function AnalyticsReportLoading({ label = 'Loading analytics' }: { label?: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-4">
      <span className="sr-only">{label}…</span>
      <div aria-hidden="true" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Card key={i} className="gap-0 py-0 shadow-none">
            <CardContent className="space-y-3 p-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-9 w-16" />
              <Skeleton className="h-3 w-36 max-w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card aria-hidden="true" className="shadow-none">
        <CardContent className="space-y-6 p-6">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-56 w-full" />
        </CardContent>
      </Card>
      <div aria-hidden="true" className="grid gap-4 md:grid-cols-2">
        {[0, 1].map((i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="space-y-5 p-6">
              <Skeleton className="h-4 w-24" />
              {[0, 1, 2].map((row) => (
                <Skeleton key={row} className="h-7 w-full" />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
