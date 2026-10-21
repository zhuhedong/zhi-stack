import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './maintenance.css';
import App from './App.tsx';
import { ConfirmationProvider } from './components/ConfirmationProvider';
import { WindowControls } from './components/WindowControls';
import { isDesktop, isMac } from './lib/platform';
import { applyReadingWidth } from './lib/readingWidth';
import { applyTheme } from './lib/theme';
import { registerServiceWorker } from './lib/offline';

applyTheme();
registerServiceWorker();
applyReadingWidth();

if (isDesktop) {
  document.documentElement.classList.add('desktop-shell', isMac ? 'desktop-mac' : 'desktop-frameless');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfirmationProvider>
      <App />
      <WindowControls />
    </ConfirmationProvider>
  </StrictMode>,
);
