import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { PrivacyPage } from '../src/PrivacyPage.js';

it('provides readable public privacy information without a dashboard or footer', () => {
  const { container } = render(<PrivacyPage />);
  expect(screen.getByRole('heading', { name: 'Privacy at App Health' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'sarthakagrawal927@gmail.com' })).toHaveAttribute(
    'href',
    'mailto:sarthakagrawal927@gmail.com',
  );
  expect(screen.getByRole('heading', { name: 'Storage and retention' })).toBeInTheDocument();
  expect(container.querySelector('footer')).toBeNull();
});
