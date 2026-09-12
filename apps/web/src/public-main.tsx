import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PublicAnalyticsView } from './PublicAnalyticsView.js';
import './shadcn.css';
const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.dataset.theme = theme;
document.documentElement.classList.toggle('dark', theme === 'dark');
const root = document.getElementById('root');
if (!root) throw new Error('Public analytics root missing');
createRoot(root).render(
  <StrictMode>
    <PublicAnalyticsView />
  </StrictMode>,
);
