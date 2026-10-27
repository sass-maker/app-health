# privacy at App Health

> App Health is a Fleet product operated by Sarthak Agrawal. This notice explains the information used to run the service and the choices available to you.

Canonical: https://health.sassmaker.com/privacy

Updated September 18, 2026

## your account

Google sign-in provides your name, email address, profile image, and provider identity. App Health stores these with workspace ownership and authentication records. Provider tokens are encrypted at rest by the authentication library. Secure HttpOnly cookies maintain your session; authentication records can also contain IP address and browser information. These account records are separate from your project telemetry.

## project telemetry

Endpoint measurements contain HTTP method, normalized route, status, duration, timestamp, and optional release. They do not capture request headers, cookies, bodies, or query values. The browser tracker records page paths with query strings and fragments removed, normalizes likely identifiers, and records the referring hostname. By default, a random anonymous visitor identifier stays in first-party local storage for up to 90 days, scoped to a project. Visits expire after 30 minutes without meaningful activity. Integrations can choose session-only tracking, which omits persistent visitor identifiers. Only one-way hashes scoped to each project and environment are archived, never raw visitor or session identifiers. These identifiers describe browsers, not unique people, and do not link unrelated projects or devices. The tracker does not set analytics cookies. Analytics can also include bounded campaign tags, an entry path, referring hostname, and coarse browser, device, and country categories. Raw IP addresses and user-agent strings are not stored in these analytics events. Explicit events and logs contain the fields your integration submits. Do not submit passwords, credentials, payment details, or other sensitive personal information.

## how we use data

We use account information to authenticate you and keep projects scoped to your workspace. Telemetry powers the analytics, logs, and endpoint-health views you enable. App Health also uses its own tracker to understand product usage and records successful signup and project creation as operational milestones without account names, emails, or project details in those log properties.

## storage and retention

Cloudflare hosts the service, its database, aggregate analytics, and archive storage. The application currently authorizes no age-based deletion of compressed analytics facts, but the deployed R2 provider lifecycle may still expire older physical archive objects until that lifecycle is removed and independently verified. Future physical replacement requires cryptographic and content-equivalence verification; equal counts alone are not sufficient. Application logs retain their full details for 30 days, while long-term log rollups can retain aggregate counts without message properties. Endpoint failure details retain 24 hours; endpoint counters and latency histograms use separate aggregate storage. Expired authentication sessions, verification records, and rate-limit records are cleaned in bounded scheduled batches. Account records, project configuration, and ownership remain while the account is maintained.

## sharing and service providers

Workspace authentication protects private project views. If you create a public analytics share link, anyone holding it can read its limited aggregate view until you revoke it. Treat the link as a credential. Google provides sign-in and Cloudflare provides hosting and data processing. Public website pages also use PostHog for page-visit analytics; the changelog uses Microsoft Clarity to understand navigation and rendering. These services have their own privacy notices.

## your choices

You choose which capabilities to instrument and can revoke integration keys and public share links. Contact the operator to request access, correction, or deletion of account and project information. Do not include credentials or private log contents in your request.

Questions or privacy requests: [sarthakagrawal927@gmail.com](mailto:sarthakagrawal927@gmail.com)

## Related

[App Health](https://health.sassmaker.com/) · [Changelog](https://health.sassmaker.com/changelog) · [Source and roadmap](https://github.com/sass-maker/app-health/issues)
