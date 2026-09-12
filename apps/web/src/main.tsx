import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { LandingPage } from './LandingPage.js';
import { PrivacyPage } from './PrivacyPage.js';
import { Changelog } from './Changelog.js';
import { loadProductAnalytics } from './lib/product-analytics.js';
import './shadcn.css';

try {
  document.documentElement.dataset.theme =
    (window.location.pathname === '/live'
      ? new URLSearchParams(window.location.search).get('theme')
      : localStorage.getItem('app-health-theme')) === 'light'
      ? 'light'
      : 'dark';
} catch {
  document.documentElement.dataset.theme = 'dark';
}

document.documentElement.classList.toggle(
  'dark',
  document.documentElement.dataset.theme !== 'light',
);
const root = document.getElementById('root');
if (!root) throw new Error('root element missing');
const RootView =
  window.location.pathname === '/privacy'
    ? PrivacyPage
    : window.location.pathname === '/changelog'
      ? Changelog
      : window.location.pathname === '/' && !window.location.search.includes('demo=')
        ? LandingPage
        : App;
if (window.location.pathname !== '/live') void loadProductAnalytics();
document.title =
  RootView === PrivacyPage
    ? 'Privacy — App Health'
    : RootView === Changelog
      ? 'Changelog — App Health'
      : RootView === LandingPage
        ? 'App Health — Web analytics, product events, and app health'
        : 'Web analytics — App Health';
createRoot(root).render(
  <StrictMode>
    <RootView />
  </StrictMode>,
);
