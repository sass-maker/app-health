import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProjectCommandPicker } from '../src/ProjectCommandPicker.js';

const projects = [
  { appId: 'zeta', name: 'Zeta' },
  { appId: 'alpha', name: 'Alpha' },
  { appId: 'beta', name: 'Beta' },
];

describe('ProjectCommandPicker', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('sorts projects and filters names case-insensitively', () => {
    const onSelect = vi.fn();
    render(<ProjectCommandPicker projects={projects} selectedId="alpha" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Project' }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'All projects',
      'Alpha',
      'Beta',
      'Zeta',
    ]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Search projects' }), {
      target: { value: 'bET' },
    });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.click(screen.getByRole('option', { name: 'Beta' }));
    expect(onSelect).toHaveBeenCalledWith('beta');
  });

  it('shows only authorized recent projects and a no-results state', () => {
    window.sessionStorage.setItem(
      'app-health:recent-project-ids:v1',
      JSON.stringify(['foreign', 'zeta']),
    );
    render(<ProjectCommandPicker projects={projects} selectedId={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Project' }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'All projects',
      'Zeta',
      'Alpha',
      'Beta',
    ]);
    expect(screen.queryByRole('option', { name: 'foreign' })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Search projects' }), {
      target: { value: 'missing' },
    });
    expect(screen.getByRole('status')).toHaveTextContent('No projects found');
  });

  it('supports keyboard selection, dismissal, and the shortcut', async () => {
    const onSelect = vi.fn();
    render(<ProjectCommandPicker projects={projects} selectedId="alpha" onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Project' }), { key: 'ArrowDown' });
    const search = screen.getByRole('combobox', { name: 'Search projects' });
    fireEvent.change(search, { target: { value: 'beta' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('beta');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Search projects' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('returns to overview from the pinned choice', () => {
    const onSelect = vi.fn();
    render(<ProjectCommandPicker projects={projects} selectedId="alpha" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Project' }));
    fireEvent.click(screen.getByRole('option', { name: 'All projects' }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('provides a touch-sized close control without changing the project', async () => {
    const onSelect = vi.fn();
    render(<ProjectCommandPicker projects={projects} selectedId="alpha" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close project picker' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('finds a project in a 25-project portfolio and remembers the choice for this session', () => {
    const portfolio = Array.from({ length: 25 }, (_, index) => ({
      appId: `app-${index}`,
      name: `Product ${index + 1}`,
    }));
    const onSelect = vi.fn();
    render(<ProjectCommandPicker projects={portfolio} selectedId={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Project' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Search projects' }), {
      target: { value: 'product 24' },
    });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.click(screen.getByRole('option', { name: 'Product 24' }));
    expect(onSelect).toHaveBeenCalledWith('app-23');
    expect(
      JSON.parse(window.sessionStorage.getItem('app-health:recent-project-ids:v1') ?? '[]'),
    ).toEqual(['app-23']);
    fireEvent.click(screen.getByRole('combobox', { name: 'Project' }));
    expect(screen.getAllByRole('option')[1]).toHaveTextContent('Product 24');
  });
});
