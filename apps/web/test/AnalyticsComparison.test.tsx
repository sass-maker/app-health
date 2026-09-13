import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { AnalyticsComparison } from '../src/AnalyticsComparison.js';

it.each([
  [20, 10, '+100% vs previous period'],
  [5, 10, '-50% vs previous period'],
  [10, 10, 'No change vs previous period'],
  [0, 0, 'No change vs previous period'],
  [12, 0, 'No activity in the previous period'],
  [0, 10, '-100% vs previous period'],
])('compares %s with %s without inventing zero-baseline growth', (current, previous, expected) => {
  render(<AnalyticsComparison label="Page views" current={current} previous={previous} />);
  expect(screen.getByLabelText('Page views comparison')).toHaveTextContent(expected);
});

it('omits absent baselines and qualifies sampled event totals without comparing sampled unique counts', () => {
  const view = render(<AnalyticsComparison label="Sessions" current={10} />);
  expect(screen.queryByLabelText('Sessions comparison')).toBeNull();
  view.rerender(<AnalyticsComparison label="Sessions" current={10} previous={5} sampled unique />);
  expect(screen.getByLabelText('Sessions comparison')).toHaveTextContent(
    'Comparison unavailable for sampled unique counts',
  );
  expect(screen.queryByText(/100%/)).toBeNull();
  view.rerender(<AnalyticsComparison label="Page views" current={10} previous={5} sampled />);
  expect(screen.getByLabelText('Page views comparison')).toHaveTextContent('Estimated · +100%');
});
