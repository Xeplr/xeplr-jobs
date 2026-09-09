import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { authRoutes, authPath, ProtectedRoute } from '@xeplr/ui-account';
import { registerJobsUI } from './index.js';
import { ROUTES } from './routes.js';

// STANDALONE jobs — this package consuming its own public API.
//
// Everything here is the INFRASTRUCTURE a host would otherwise provide: the
// router (in main.jsx), the auth gate, and a shell to render inside. None of
// it is jobs; jobs is the one line calling registerJobsUI(), the same line a
// host writes. That is the point — running on its own is not a second
// implementation of the product, it is the same one with the scaffolding
// supplied here instead of by someone else.
//
// Deliberately thin. A standalone jobs install is for a team that wants a
// scheduler and nothing else, so there is no company/workspace picker and no
// navigation rail — a host that has those concepts brings them.
function Shell() {
  return (
    <div className="jobs-standalone-shell">
      <header className="jobs-standalone-header">
        <strong>xeplr jobs</strong>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      {/* Login/activate/reset, from @xeplr/ui-account — the same screens every
          xeplr app uses rather than a second set built here. */}
      {authRoutes({}, { layout: <Shell /> })}

      <Route element={<ProtectedRoute redirectTo={authPath('login')} />}>
        <Route element={<Shell />}>
          {/* THE PRODUCT. Identical call to the one a host makes; see
              src/index.js for why there is no embedded/standalone branch. */}
          {registerJobsUI({}).routes}
          <Route path="/" element={<Navigate to={ROUTES.jobs()} replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
