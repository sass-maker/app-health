import { ProductBrand } from './ProductShell.js';
import { ThemeToggle } from './ThemeToggle.js';
import { Button } from './components/ui/button.js';

const sections = [
  [
    'Your account',
    'Google sign-in provides your name, email address, profile image, and provider identity. App Health stores these with workspace ownership and authentication records. Provider tokens are encrypted at rest by the authentication library. Secure HttpOnly cookies maintain your session; authentication records can also contain IP address and browser information. These account records are separate from your project telemetry.',
  ],
  [
    'Project telemetry',
    'Endpoint measurements contain HTTP method, normalized route, status, duration, timestamp, and optional release. They do not capture request headers, cookies, bodies, or query values. The browser tracker records page paths with query strings and fragments removed, normalizes likely identifiers, and records the referring hostname. By default, a random anonymous visitor identifier stays in first-party local storage for up to 90 days, scoped to a project. Visits expire after 30 minutes without meaningful activity. Integrations can choose session-only tracking, which omits persistent visitor identifiers. Only one-way hashes scoped to each project and environment are archived, never raw visitor or session identifiers. These identifiers describe browsers, not unique people, and do not link unrelated projects or devices. The tracker does not set analytics cookies. Analytics can also include bounded campaign tags, an entry path, referring hostname, and coarse browser, device, and country categories. Raw IP addresses and user-agent strings are not stored in these analytics events. Explicit events and logs contain the fields your integration submits. Do not submit passwords, credentials, payment details, or other sensitive personal information.',
  ],
  [
    'How we use data',
    'We use account information to authenticate you and keep projects scoped to your workspace. Telemetry powers the analytics, logs, and endpoint-health views you enable. App Health also uses its own tracker to understand product usage and records successful signup and project creation as operational milestones without account names, emails, or project details in those log properties.',
  ],
  [
    'Storage and retention',
    'Cloudflare hosts the service, its database, aggregate analytics, and archive storage. Application logs and compressed browser archives have a 30-day retention policy. Expired authentication sessions, verification records, and rate-limit records are cleaned in bounded scheduled batches. Account records, project configuration, and ownership remain while the account is maintained. Aggregate analytics use a separate storage lifecycle; they are not covered by the raw archive expiry promise.',
  ],
  [
    'Sharing and service providers',
    'Workspace authentication protects private project views. If you create a public analytics share link, anyone holding it can read its limited aggregate view until you revoke it. Treat the link as a credential. Google provides sign-in and Cloudflare provides hosting and data processing. Public website pages also use PostHog for page-visit analytics; the changelog uses Microsoft Clarity to understand navigation and rendering. These services have their own privacy notices.',
  ],
  [
    'Your choices',
    'You choose which capabilities to instrument and can revoke integration keys and public share links. Contact the operator to request access, correction, or deletion of account and project information. Do not include credentials or private log contents in your request.',
  ],
];

export function PrivacyPage(): JSX.Element {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex min-h-16 max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <ProductBrand />
          <nav aria-label="Product links" className="flex items-center gap-2">
            <ThemeToggle />
            <Button asChild variant="outline">
              <a href="/">Home</a>
            </Button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <p className="text-sm text-muted-foreground">Updated September 12, 2026</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Privacy at App Health</h1>
        <p className="mt-4 leading-7 text-muted-foreground">
          App Health is a Fleet product operated by Sarthak Agrawal. This notice explains the
          information used to run the service and the choices available to you.
        </p>
        <div className="mt-10 space-y-8">
          {sections.map(([title, description]) => (
            <section key={title}>
              <h2 className="text-lg font-semibold">{title}</h2>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">{description}</p>
            </section>
          ))}
        </div>
        <p className="mt-8 text-sm leading-7">
          Questions or privacy requests:{' '}
          <a className="underline underline-offset-4" href="mailto:sarthakagrawal927@gmail.com">
            sarthakagrawal927@gmail.com
          </a>
        </p>
      </main>
    </div>
  );
}
