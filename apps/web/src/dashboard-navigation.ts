import type { CapabilityId } from '@app-health/contracts';

const backend = {
  eyebrow: 'Application health',
  title: 'Backend',
  description: 'Monitor requests, failures, latency, and logs for this environment.',
};

export const DASHBOARD_PAGES = {
  overview: {
    eyebrow: 'Workspace',
    title: 'Overview',
    description: 'See traffic and live sessions across your projects and environments.',
  },
  analytics: {
    eyebrow: 'Product',
    title: 'Analytics',
    description: 'See who visits, where they come from, and which pages they use.',
  },
  events: {
    eyebrow: 'Product',
    title: 'Events',
    description: 'Track the actions people take, from signups to downloads.',
  },
  backend,
  'backend/logs': backend,
  'backend/diagnostics': backend,
  'analytics/setup': {
    eyebrow: 'Analytics',
    title: 'Set up analytics',
    description: 'Connect page views, live visitors, and the events you choose to track.',
  },
  settings: {
    eyebrow: 'Project',
    title: 'Settings',
    description: 'Manage environments, data collection, and access keys.',
  },
};

export type DashboardView = keyof typeof DASHBOARD_PAGES;
export type BackendView = Extract<DashboardView, `backend${string}`>;

export function capabilityView(id: CapabilityId): DashboardView {
  return { analytics: 'analytics', endpoints: 'backend', logs: 'backend/logs' }[
    id
  ] as DashboardView;
}
