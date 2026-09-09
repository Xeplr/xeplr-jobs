import { Route } from 'react-router-dom';
import JobsPage from './pages/Jobs.jsx';
import { configureJobsApi, configureOptionSources } from './api/jobs.js';
import { ROUTES } from './routes.js';

/**
 * Register @xeplr/jobs' pages into a host app.
 *
 * THE UI BELONGS TO THIS PACKAGE, not to whoever embeds it. Jobs is a product
 * — a scheduler, an HTTP surface AND the screens for both — and a host that
 * wanted to schedule something used to have to rebuild those screens itself.
 * That is how xeplr-bi ended up with its own copy: a second implementation of
 * one product's UI, free to drift from the backend it talks to and from the
 * next host's copy of the same thing.
 *
 * What a host supplies is only the INFRASTRUCTURE it already has — the
 * router, the auth gate, the layout — never the product. Exactly the split the
 * backend already makes: registerJobs() takes an Express app when there is one
 * and stands up its own when there is not.
 *
 * There is no embedded/standalone branch HERE, and there cannot be: React has
 * no imperative "mount onto an app" call, a subtree IS the mount. So this
 * returns <Route> elements and the difference is who wraps them:
 *
 *   - EMBEDDED: the host renders them inside its own <BrowserRouter>,
 *     <AccessProvider> and shell.
 *   - STANDALONE: this package's own src/main.jsx does that, which is this
 *     package consuming its own public API rather than a special case of it.
 *
 * Usage from a host:
 *
 *   import { registerJobsUI } from 'xeplr-jobs-ui'
 *
 *   <Routes>
 *     ...your routes...
 *     {registerJobsUI({ basePath: '/workspace' }).routes}
 *   </Routes>
 *
 * @param {object} [config]
 * @param {string} [config.basePath=''] - what the host prefixes jobs' paths
 *   with. xeplr-bi passes '/workspace' because a job belongs to a workspace
 *   there; standalone passes nothing.
 * @param {string} [config.apiBase=''] - prefix for the API calls. The jobs
 *   router mounts at the API ROOT ('/jobs', '/job-occurrences', '/actions'),
 *   so this is empty unless a host mounts it somewhere else.
 * @param {object} [config.optionSources] - where a KIND of thing is listed,
 *   for input fields that declare `optionsFrom`. Shaped
 *   { connections: { url: '/connectioninfo', label: 'label' }, ... }.
 *
 *   This package never learns what a connection is, nor which URL serves one
 *   — it knows only "fetch this list, show labels, store ids". A host that
 *   supplies none gets plain text inputs for those fields, which is the
 *   correct answer standalone: an empty dropdown looks broken, a text box is
 *   simply what you have when there is no catalogue to pick from.
 * @param {Function} [config.breadcrumb] - the host's own breadcrumb component,
 *   rendered above the page. Omitted standalone, where there is nothing to
 *   navigate back up to.
 * @param {JSX.Element|string} [config.uploadLink] - a link to wherever the host
 *   loads files, named in the empty state.
 * @param {JSX.Element} [config.connectLink] - a link to the workflow canvas,
 *   for connecting jobs so one starts when another finishes. Supplied by the
 *   host because this package must not import @xeplr/workflow — workflow
 *   already calls jobs over HTTP at run time, and importing its UI here would
 *   close that into a circular dependency between two packages that are
 *   deliberately installable on their own.
 * @returns {{ routes: JSX.Element[], path: string }}
 */
export function registerJobsUI(config) {
  config = config || {};
  if (config.apiBase !== undefined) configureJobsApi({ base: config.apiBase });
  configureOptionSources(config.optionSources);

  var path = ROUTES.jobs(config.basePath);

  return {
    routes: [
      // EVERY PAGE-LEVEL PROP FORWARDED, not a hand-picked subset.
      //
      // This passed `breadcrumb` alone, so `uploadLink` — which xeplr-bi has
      // been supplying all along — was accepted by this function, dropped
      // here, and silently never rendered. Nothing reported it: the page's
      // empty state falls back to the words "the upload screen" when no link
      // is given, so the failure looked exactly like a host that had not
      // configured one.
      //
      // Naming each prop is what caused that, and would cause it again for the
      // next one added to the page. The page's own signature is the list of
      // what it accepts; anything not destructured there is ignored, which is
      // the same outcome as filtering, without the gap.
      <Route key="jobs-list" path={path} element={<JobsPage {...config} />} />
    ],
    // Handed back so a host can point its own nav at the same string instead
    // of writing '/workspace/jobs' a second time and having the two drift.
    path: path
  };
}

export { ROUTES as jobsRoutes } from './routes.js';
