import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Changelog } from '../src/Changelog.js';
import copy from '../src/public-copy.json';

it('renders every published outcome with its date and public navigation', () => {
  const { container } = render(<Changelog />);
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(copy.changelog.title);
  expect(screen.getByRole('link', { name: copy.changelog.roadmapLabel })).toHaveAttribute(
    'href',
    'https://github.com/sass-maker/app-health/issues',
  );
  expect(screen.getByRole('link', { name: copy.changelog.dashboardLabel })).toHaveAttribute(
    'href',
    '/app',
  );
  for (const entry of copy.entries) {
    expect(container.querySelector(`time[datetime="${entry.date}"]`)).toHaveTextContent(entry.date);
    expect(screen.getByText(entry.title)).toBeInTheDocument();
    for (const outcome of entry.outcomes) expect(screen.getByText(outcome)).toBeInTheDocument();
  }
  expect(screen.getByText(copy.changelog.analyticsDisclosure)).toBeInTheDocument();
});
