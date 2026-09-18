# Account flow review

Lane: preserve. Surface: operate. The existing landing review is archived in
`previous-design-review.json`; its before screenshot is retained as the visual
baseline. No public production capability claim is changed by this local flow.

## Interaction evidence

- Real local API: created Accounts browser canary, viewed SDK setup, saved the
  one-time key, switched between projects, and restored the selection on reload.
  The explicit `demo=populated` route intentionally reopens the demo; restoration
  was checked on `/`. Browser storage contained project metadata and no key.
- Google-enabled entry was inspected in the production build with only config
  and unauthenticated-session responses stubbed. This is UI evidence, not Google
  callback proof. Real D1/Better Auth and workerd tests cover the account boundary.
- Captured entry and project views at 390, 768, and 1440px. No page overflow.
  Project/environment and Google controls have 44px targets. Native project
  selection supports keyboard interaction and visible focus.
- Fixed the narrow-header overlap/truncation and the owner-key autofocus that
  distracted from Google entry. Add Project has a return path; empty workspaces
  retain sign-out. Failed sign-out retains the session and provides retry text.

## Critique: 35/40

| Heuristic         | Score | Evidence                                                                       |
| ----------------- | ----- | ------------------------------------------------------------------------------ |
| Status            | 4     | Pending, empty, error, and project-created states                              |
| Familiar language | 4     | Project, environment, Google sign-in, Sign out                                 |
| Control           | 4     | Back to projects and explicit sign-out                                         |
| Consistency       | 4     | Existing buttons, forms, errors, native selects                                |
| Prevention        | 3     | Required names and one-time-key notice; long project names truncate            |
| Recognition       | 3     | Current project is visible; no full workspace overview in this slice           |
| Efficiency        | 3     | Direct project/environment selection; inventory refresh remains periodic       |
| Minimalism        | 4     | No decorative analytics placeholders                                           |
| Recovery          | 3     | Network/provider errors recover; real provider callback still needs activation |
| Documentation     | 3     | Existing SDK setup and account activation guide                                |

## Technical audit: 18/20

Accessibility 4, performance 3, responsive 4, theming 3, integrity 4. Existing
light-only styling and some legacy hard-coded styles remain. The added account
controls use native keyboard behavior, existing semantic colors, and 44px targets.
The mechanical detector reported no findings on the edited UI. The final header
sizing fix was also inspected at all three widths. No unresolved P0/P1 in the
local account UI. Production OAuth activation is an explicit delivery boundary.

Broader browser analytics, live-viewer portfolio, imports, and DataFast parity
remain in issue #58. This receipt only covers account entry and project controls.
