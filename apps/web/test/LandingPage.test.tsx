import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LandingPage } from '../src/LandingPage.js';

beforeEach(() => {
  document.documentElement.classList.add('dark');
  document.documentElement.dataset.theme = 'dark';
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(),
    setItem: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.className = '';
  delete document.documentElement.dataset.theme;
});

it('introduces analytics and event exploration to product people with honest proof', () => {
  render(<LandingPage />);
  expect(screen.getByRole('heading', { name: /See what people do/ })).toBeTruthy();
  expect(screen.getByText('For people shaping digital products')).toBeTruthy();
  expect(screen.getByLabelText('Illustrative web analytics preview')).toBeTruthy();
  expect(screen.queryByText(/funnels/i)).toBeNull();
  expect(screen.getByRole('contentinfo')).toHaveTextContent('A Fleet product');
  expect(
    screen.getAllByRole('link', { name: /Open App Health|Open dashboard/ }).length,
  ).toBeGreaterThan(0);
});

it('offers complete theme control from the landing navigation', () => {
  render(<LandingPage />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
  expect(document.documentElement).not.toHaveClass('dark');
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(localStorage.setItem).toHaveBeenCalledWith('app-health-theme', 'light');
});
