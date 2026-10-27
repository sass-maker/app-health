import { StrictMode, type ComponentType } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
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

document.documentElement.dataset.mode = document.documentElement.dataset.theme;
document.documentElement.classList.toggle(
  'dark',
  document.documentElement.dataset.theme !== 'light',
);
const root = document.getElementById('root');
if (!root) throw new Error('root element missing');
const path = window.location.pathname;
const isLanding = path === '/' && !window.location.search.includes('demo=');
const view: Promise<{ component: ComponentType; title: string }> =
  path === '/privacy'
    ? import('./PrivacyPage.js').then(({ PrivacyPage }) => ({
        component: PrivacyPage,
        title: 'Privacy — App Health',
      }))
    : path === '/changelog'
      ? import('./Changelog.js').then(({ Changelog }) => ({
          component: Changelog,
          title: 'Changelog — App Health',
        }))
      : isLanding
        ? import('./LandingPage.js').then(({ LandingPage }) => ({
            component: LandingPage,
            title: 'App Health — Web analytics, product events, and app health',
          }))
        : import('./App.js').then(({ App }) => ({ component: App, title: 'App Health' }));
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
void view.then(({ component: RootView, title }) => {
  document.title = title;
  const content = (
    <StrictMode>
      <RootView />
    </StrictMode>
  );
  const prerenderedPage = isLanding
    ? 'landing'
    : path === '/changelog'
      ? 'changelog'
      : path === '/privacy'
        ? 'privacy'
        : null;
  if (prerenderedPage && root.dataset.prerendered === prerenderedPage) hydrateRoot(root, content);
  else createRoot(root).render(content);
});
