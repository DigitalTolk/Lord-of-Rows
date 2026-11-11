import './boot-check';
import React from 'react';
import ReactDOM from 'react-dom/client';
import './i18n';
import './index.css';
import App from './App';
import { bootTheme } from './lib/theme';
import { ErrorBoundary } from './components/ErrorBoundary';

// Block drag-and-drop navigation (dropping a file would otherwise navigate the webview).
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
// Suppress the webview's browser context menu (Back/Reload/Inspect); the app supplies its own menus.
window.addEventListener('contextmenu', (e) => {
  const el = e.target as HTMLElement;
  if (!el.closest('input, textarea, .monaco-editor')) e.preventDefault();
});

bootTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
