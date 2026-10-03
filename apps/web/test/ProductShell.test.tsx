import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProductShell } from '../src/ProductShell.js';
import type { DashboardView } from '../src/dashboard-navigation.js';

interface Project {
  appId: string;
  environmentId: string;
  name: string;
  environment: string;
}

const appOneStaging: Project = {
  appId: 'app-1',
  environmentId: 'app-1-staging',
  name: 'Product 1',
  environment: 'staging',
};
const appOneProduction: Project = {
  ...appOneStaging,
  environmentId: 'app-1-production',
  environment: 'production',
};
const appTwoStaging: Project = {
  appId: 'app-2',
  environmentId: 'app-2-staging',
  name: 'Product 2',
  environment: 'staging',
};
const appTwoProduction: Project = {
  ...appTwoStaging,
  environmentId: 'app-2-production',
  environment: 'production',
};
const projects: Project[] = [
  appOneStaging,
  appOneProduction,
  appTwoStaging,
  appTwoProduction,
  ...Array.from({ length: 53 }, (_, index) => {
    const number = index + 3;
    return {
      appId: `app-${number}`,
      environmentId: `app-${number}-production`,
      name: `Product ${number}`,
      environment: 'production',
    };
  }),
];

interface ShellOverrides {
  view?: DashboardView;
  project?: Project;
  projects?: Project[];
  onView?: (view: DashboardView) => void;
  onProject?: (project: Project) => void;
}

function renderShell(overrides: ShellOverrides = {}) {
  const onView = overrides.onView ?? vi.fn();
  const onProject = overrides.onProject ?? vi.fn();
  render(
    <ProductShell
      view={overrides.view ?? 'overview'}
      eyebrow="Workspace"
      title="Daily briefing"
      description="Portfolio activity"
      project={overrides.project ?? appOneStaging}
      projects={overrides.projects ?? projects}
      onView={onView}
      onProject={onProject}
      onAdd={vi.fn()}
      onLock={vi.fn()}
      accountSession={false}
    >
      <p>Selected report</p>
    </ProductShell>,
  );
  return { onView, onProject };
}

function projectButtons() {
  return screen
    .getAllByRole('button')
    .filter((button) => button.getAttribute('title')?.startsWith('Product '));
}

describe('ProductShell navigation', () => {
  it('deduplicates all 55 apps and searches project names case-insensitively', () => {
    renderShell();

    const names = projectButtons().map((button) => button.getAttribute('title'));
    expect(names).toHaveLength(55);
    expect(new Set(names).size).toBe(55);

    fireEvent.change(screen.getByRole('textbox', { name: 'Search projects' }), {
      target: { value: 'pRODUCT 42' },
    });
    expect(projectButtons().map((button) => button.getAttribute('title'))).toEqual(['Product 42']);

    fireEvent.change(screen.getByRole('textbox', { name: 'Search projects' }), {
      target: { value: 'missing project' },
    });
    expect(projectButtons()).toHaveLength(0);
    expect(screen.getByText('No projects match your search.')).toBeInTheDocument();
  });

  it('opens another app in production and moves from overview into analytics', () => {
    const { onView, onProject } = renderShell({ view: 'overview' });

    fireEvent.click(screen.getByRole('button', { name: 'Product 2' }));

    expect(onProject).toHaveBeenCalledWith(appTwoProduction);
    expect(onView).toHaveBeenCalledWith('analytics');
  });

  it('preserves the selected app environment when its sidebar item is clicked again', () => {
    const { onView, onProject } = renderShell({
      view: 'analytics',
      project: appTwoStaging,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Product 2' }));

    expect(onProject).toHaveBeenCalledWith(appTwoStaging);
    expect(onView).not.toHaveBeenCalled();
  });

  it('changes the current environment through the header selector', async () => {
    const { onProject } = renderShell({ view: 'analytics' });

    fireEvent.click(screen.getByRole('combobox', { name: 'Environment' }));
    fireEvent.click(await screen.findByRole('option', { name: 'production' }));

    expect(onProject).toHaveBeenCalledWith(appOneProduction);
  });

  it('keeps report tabs local by routing selection through onView', () => {
    const onView = vi.fn();
    renderShell({ view: 'analytics', onView });

    for (const [label, view] of [
      ['Events', 'events'],
      ['Backend', 'backend'],
      ['Settings', 'settings'],
    ] as const) {
      fireEvent.mouseDown(screen.getByRole('tab', { name: label }), {
        button: 0,
        ctrlKey: false,
      });
      expect(onView).toHaveBeenLastCalledWith(view);
    }
    expect(onView).toHaveBeenCalledTimes(3);
  });
});
