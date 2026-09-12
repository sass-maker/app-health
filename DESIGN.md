---
name: App Health
description: Product analytics connected to application health
colors:
  ink: '#fafafa'
  muted: '#a1a1aa'
  background: '#09090b'
  paper: '#111113'
  line: '#27272a'
  indigo: '#a5b4fc'
  emerald: '#34d399'
---

# App Health design system

## Direction

App Health is an analytics product for product managers and founders. The interface begins with
traffic and named product events, then keeps application health within reach when a change needs
investigation. It should feel calm, exact, and editorial rather than like an infrastructure console.

Use standard shadcn/ui composition, sizing, controls, and semantic theme tokens throughout.
App Health is a flagship product; a custom visual treatment is not justification for departing
from reliable upstream components. The default is dark, with equally complete light mode.
Never mix a newly themed shell with legacy panels or global styles from another visual system.

## Typography

Use the system sans stack for interface and editorial copy. Headlines use restrained weight and
tight tracking. Product event names, routes, and snippets use monospace. Small uppercase labels are
reserved for orientation and proof; they do not replace plain-language headings.

## Layout

The landing page uses clear spacing, a visible product preview, and three evidence-led
feature cards. The dashboard uses a shadcn sidebar, a compact workspace header, a 1280px report
column, and cards that preserve clear relationships between filters, totals, trends, and details.
The footer belongs only to the landing page.

On phones, the sidebar becomes a sheet, dashboard filters stack, metrics become one column, and
secondary table fields yield before the event name or primary action. Every control keeps a
44-pixel touch target where space permits. Tablet layouts preserve the report hierarchy without
forcing desktop density.

## Components

Use the checked-in shadcn components for buttons, cards, badges, selects, tables, sheets, sidebars,
tooltips, skeletons, and charts. Their source URLs, license, and hashes are recorded in
`docs/shadcn-sources.json`. Compose these primitives with product-specific content; do not present a
component catalog.

The shared traffic-and-event area chart is the visual signature across the landing preview and the
authenticated report. Every chart includes a keyboard-accessible value disclosure. Live status is
always paired with text and the 45-second browser-session definition.

## Content rules

- Lead with what people viewed and what they chose to do.
- Say “browser sessions” rather than “people” or “unique visitors” for live counts.
- Label local data, sampling, freshness, and illustrative landing data next to the surface they
  qualify.
- Do not claim funnels, revenue attribution, or hosted production activation before they exist.
- Keep backend terms inside App health, Logs, Data received, and installation details.

## Interaction and accessibility

Focus rings use the semantic ring token in both themes. Navigation, selects, event drill-downs,
chart metric switches, theme controls, and mobile sheets remain keyboard operable. Status never
depends on color alone. Reduced-motion users do not receive sheet transitions or pulsing animations.

## Completion evidence

Review every route and its important states: endpoint tables and mobile cards, retained failure
details, logs and filters, collection details, account onboarding, installation, and key management,
as well as analytics and events. A review of only the newest screens cannot establish full-product
theme quality. Inspect rendered colors, spacing, content wrapping, keyboard focus, and recovery in
both themes at desktop, tablet, and mobile widths. Keep screenshot coverage tied to the exact route
and state; passing unit tests alone is insufficient.
