import { ShieldCheck } from 'lucide-react';
import { Button } from './components/ui/button.js';

/** Collection policy, not a query toggle: discarded bot batches have no report rows. */
export function BrowserTrafficPolicy(): JSX.Element {
  return (
    <details className="max-w-sm text-xs">
      <Button asChild variant="outline" className="h-10 cursor-pointer">
        <summary>
          <ShieldCheck className="size-4" />
          Known bots excluded
        </summary>
      </Button>
      <p className="mt-2 leading-5 text-muted-foreground">
        Browser collection excludes Cloudflare verified bots and recognized bot user agents.
        Unrecognized automation can still pass: these counts are not verified humans. Rejected bots
        are not retained, so a Bots total is unavailable. Filtering began October 1, 2026; earlier
        data may include bots. Backend health counts all requests.
      </p>
    </details>
  );
}
