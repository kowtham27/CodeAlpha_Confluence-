// First, before any schema is used: see the file for why.
import './lib/zod-config';
// Applies the saved theme before the first paint.
import './lib/theme';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App';
// Self-hosted (the CSP allows fonts from this origin only). Weight axis, with
// per-script subsets: browsers fetch only the Latin file they need.
import '@fontsource-variable/google-sans-flex';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
