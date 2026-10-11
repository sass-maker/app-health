import type { CapabilityId } from '@app-health/contracts';

const backend = {
  eyebrow: 'application health',
  title: 'backend',
  description: 'Monitor requests, failures, latency, and logs for this environment.',
};

export const DASHBOARD_PAGES = {
  overview: {
    eyebrow: 'workspace',
    title: 'daily briefing',
    description: 'Activity, acquisition and meaningful changes across your portfolio.',
  },
  speed: {
    eyebrow: 'workspace',
    title: 'speed',
    description: 'Field Web Vitals and server timings against the fleet performance budgets.',
  },
  analytics: {
    eyebrow: 'product',
    title: 'analytics',
    description: 'See who visits, where they come from, and which pages they use.',
  },
  events: {
    eyebrow: 'product',
    title: 'events',
    description: 'Track the actions people take, from signups to downloads.',
  },
  backend,
  'backend/logs': backend,
  'backend/diagnostics': backend,
  'analytics/setup': {
    eyebrow: 'analytics',
    title: 'set up analytics',
    description: 'Connect page views, live visitors, and the events you choose to track.',
  },
  settings: {
    eyebrow: 'project',
    title: 'settings',
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
