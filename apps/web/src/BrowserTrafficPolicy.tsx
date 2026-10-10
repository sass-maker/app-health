import type { ReactElement } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from './components/ui/button.js';

/** Collection policy: known bots never enter browser report rows; only counters are retained. */
export function BrowserTrafficPolicy(): ReactElement {
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
        Unrecognized automation can still pass: these counts are not verified humans. Known bots are
        kept out of browser reports and retained only as pageview counters by source, with no paths,
        sessions or browsers; the Daily briefing can show Bots or All. Bot counts are unknown for
        days before counting covered the whole day. Filtering began October 1, 2026; earlier data
        may include bots. Backend health counts all requests.
      </p>
    </details>
  );
}
