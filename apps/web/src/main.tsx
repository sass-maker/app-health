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
const analyticsReady =
  window.location.pathname === '/live' ? Promise.resolve() : loadProductAnalytics();
document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest('a[data-app-health-event]');
  if (!(link instanceof HTMLAnchorElement)) return;
  const name = link.dataset.appHealthEvent;
  if (!name) return;

  const shouldFlushBeforeNavigation =
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    link.target !== '_blank' &&
    !link.hasAttribute('download') &&
    new URL(link.href).pathname !== window.location.pathname;
  if (shouldFlushBeforeNavigation) event.preventDefault();

  let navigated = false;
  const navigate = () => {
    if (!shouldFlushBeforeNavigation || navigated) return;
    navigated = true;
    window.location.assign(link.href);
  };
  if (shouldFlushBeforeNavigation) window.setTimeout(navigate, 800);
  void analyticsReady
    .then(() => {
      window.appHealth?.track(name);
      return shouldFlushBeforeNavigation ? window.appHealth?.flush?.() : undefined;
    })
    .catch(() => undefined)
    .finally(navigate);
});
document.title =
  RootView === PrivacyPage
    ? 'Privacy — App Health'
    : RootView === Changelog
      ? 'Changelog — App Health'
      : RootView === LandingPage
        ? 'App Health — Web analytics, product events, and app health'
        : 'App Health';
createRoot(root).render(
  <StrictMode>
    <RootView />
  </StrictMode>,
);
