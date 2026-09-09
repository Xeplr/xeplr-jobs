import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { configure, registerMTs, AccessProvider } from '@xeplr/ui-account';
import App from './App.jsx';
import './index.css';
import '@xeplr/ui-account/src/designs/theme.css';

// Same-origin in dev — vite proxies the API paths (see vite.config.js).
configure('');

// Mirrors whatever the jobs API process registered. Kept in step by hand
// because there is no shared runtime between the two; out of step, every
// request carries a header the server does not read, which reads as "not
// authorized" rather than as a typo.
registerMTs({
  l1: { name: 'companyId', header: 'x-company-id' },
  l2: { name: 'workspaceId', header: 'x-workspace-id' }
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AccessProvider>
        <App />
      </AccessProvider>
    </BrowserRouter>
  </React.StrictMode>
);
