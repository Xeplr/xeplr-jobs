const { registerMTs, getMtConfig } = require('@xeplr/db');
const jobsDb = require('./lib/db');
const createApp = require('@xeplr/base-apis/express');
const createJobRouter = require('./lib/jobRouter');
const scheduler = require('./lib/scheduler');
const { initExecutorState } = require('./lib/execute');
const models = require('./models');
const actions = require('@xeplr/actions');

let _schedulerHandle = null;

// ─────────────────────────────────────────────────────────────────────────
// WHICH ACTIONS A JOB MAY NAME, BY DEFAULT
//
// A DENY LIST, not an allow list, and that is the whole point of moving this
// here. Every host was writing out the same allow list of safe builtins, so a
// new one had to be added in each of them to be offered anywhere — and
// `bin/server.js`, the standalone server, had no list at all, which meant a
// standalone jobs process booted with an EMPTY REGISTRY and could run nothing.
//
// Naming only what must not be offered inverts that: a new safe builtin is
// available everywhere the day it exists, and a dangerous one is refused in
// one place instead of being silently absent from every list that forgot it.
//
// spawnProgram runs arbitrary executables. A scheduler that can run arbitrary
// executables on a cron is a remote shell with a nicer UI.
//
// dbMove is excluded for a different reason: it CANNOT BE FILLED IN. It
// requires sourceConnection and targetConnection as objects, plus a column
// mapping and a window — a shape no generic form can collect and no person
// should type. A host that wants scheduled movements registers an action
// taking a saved move's id instead; BI's `move-run` is exactly that, and its
// own comment explains why it exists.
const NEVER_OFFER = ['spawnProgram', 'dbMove'];

/** A module the registry will accept, as opposed to a placeholder. */
function isRunnable(def) {
  return Boolean(def && typeof def.execute === 'function' && def.name);
}

/**
 * Register the safe built-in actions.
 *
 * Called by init() unless `defaultActions: false`. A host adds its OWN actions
 * on top with registerAction() — those are the ones only it can supply,
 * because they reach into its own services.
 *
 * Skips anything not runnable. Several entries in @xeplr/actions are
 * placeholders — a module with a comment saying the implementation is pending
 * and nothing else — and registering one would put a name in the job editor's
 * dropdown, let somebody schedule it, and fail every night at 3am.
 *
 * Skips FACTORY-SHAPED ones too (fileUpload takes a metaStore). They need
 * something only the host has, so the host registers them.
 */
function registerDefaultActions(logger) {
  const log = logger || console;
  const registered = [];
  const skipped = [];

  Object.keys(actions.builtins || {}).forEach((key) => {
    if (NEVER_OFFER.indexOf(key) !== -1) return;
    const def = actions.builtins[key];
    if (!isRunnable(def)) { skipped.push(key); return; }
    actions.register(def);
    registered.push(def.name);
  });

  // Said out loud, once, at startup. A name silently missing from the job
  // editor's dropdown is a bug somebody spends an afternoon on; a line in the
  // boot log is not.
  if (skipped.length && log.info) {
    log.info('[jobs] not offered (not implemented, or needs host wiring): ' + skipped.join(', '));
  }
  return registered;
}

/**
 * Initialize xeplr-jobs — wires the DB connection and binds models.
 * Call once at process startup before creating routers or starting the scheduler.
 */
async function init(config) {
  config = config || {};

  // TENANCY IS PROCESS-LOCAL STATE, and this is where a standalone worker
  // gets it.
  //
  // registerMTs() sets module state in ONE process. An app that calls it in
  // its API server has said nothing about the worker running these jobs on
  // another machine — and a process that never calls it has `enabled: false`,
  // which makes BaseModel's tenant modifier a no-op. Not an error: every job
  // on the install, of every tenant, silently visible to one another. That is
  // the worst possible failure of a tenancy feature, and it happens in exactly
  // the deployment tenancy exists for.
  //
  // So `mts` is accepted here and passed straight through. An app embedding
  // this in a process that already registered its levels omits it; a
  // standalone worker must supply it (JOBS_CONFIG.mts — see bin/server.js).
  if (config.mts) registerMTs(config.mts);

  // HERE, not in startScheduler, because a job is also run by hand.
  //
  // POST /jobs/:id/trigger calls executeJob directly, and an app that serves
  // the UI with JOBS_SCHEDULER=false never starts a scheduler at all — so a
  // resolver registered only alongside the cron loop would be missing in
  // exactly the process a person is clicking Run in. init() always runs.
  //
  // resolveConnection: async (connectionInfoId) => ({ host, port, user,
  // password, database, ... }) — how this host turns a saved connection's id
  // into credentials. Only the host can: the ids belong to its tables and the
  // decryption key is its own. See resolveInputs in lib/execute.js.
  initExecutorState({
    logger: config.logger,
    maxConcurrent: config.maxConcurrent,
    resolveConnection: config.resolveConnection
  });

  if (config.defaultActions !== false) registerDefaultActions(config.logger);

  // A SECONDARY connection, with jobs' own models bound to it — never the
  // process's global Objection binding. See lib/db.js for why that matters
  // the moment jobs is embedded in a host app.
  return jobsDb.connectJobsDb(config);
}

/**
 * Whether this process knows about tenancy — and a warning if it does not.
 *
 * Said out loud rather than assumed, because the failure is invisible: with mt
 * disabled everything works, nothing errors, and every tenant's jobs are in
 * one list. A line in the boot log is the only chance anybody has of noticing
 * before somebody else does.
 */
function warnIfUnscoped(logger) {
  const log = logger || console;
  if (!getMtConfig().enabled) {
    log.warn('[xeplr-jobs] multi-tenancy is NOT registered in this process — ' +
      'every tenant\'s jobs are visible to every other. Pass `mts` to init()/start() ' +
      '(the same registerMTs config the app uses) if this install has more than one tenant.');
    return false;
  }
  return true;
}

function router(options) {
  // Same reasoning as the scheduler's models above — the router's CRUD mounts
  // hand these straight to genericRoute, which queries through them.
  return createJobRouter(Object.assign({ models: jobsDb.boundModels() }, options || {}));
}

/**
 * Start the scheduler loop.
 *
 * config: { intervalMs, maxConcurrent, logger, timeoutMinutes, onTimeout }
 *
 * ── onTimeout(info) ──────────────────────────────────────────────────────
 *
 * Called when the reaper gives up on an occurrence — i.e. when a worker stops
 * reporting and the row is marked 'timedOut'. OPTIONAL, and the scheduler
 * behaves identically without it.
 *
 * It exists because a job is usually the visible half of something the HOST
 * owns. A job running `move-run` has a moveId in its inputs, and that
 * movement has its own run row with its own status — so a killed worker
 * leaves the job timed out AND that movement stuck at 'running' forever, with
 * nothing to connect the two. Only the host knows that connection; this
 * package cannot know what a moveId is. So it reports the fact and lets the
 * host act on it.
 *
 *   startScheduler({
 *     onTimeout: async ({ job, occurrence, toleranceMinutes }) => {
 *       const moveId = job.inputs && job.inputs.moveId
 *       if (moveId) await failStuckMoveRun(moveId, occurrence.id)
 *     }
 *   })
 *
 * info: { job, occurrence, toleranceMinutes, ranForMinutes }
 *
 * Called AFTER the occurrence is marked and the lock released, so the state
 * the callback reads is already the final one. Awaited, so a host that needs
 * to finish writing before the next tick can; and wrapped, so a callback that
 * throws is logged and cannot stop the reaper — a downstream notification
 * failing must not leave every other stuck job unreaped.
 */
function startScheduler(config) {
  config = config || {};
  warnIfUnscoped(config.logger);
  _schedulerHandle = scheduler.startScheduler({
    // BOUND — the raw classes fall back to the global binding, which embedded
    // belongs to the host app and its database.
    models: jobsDb.boundModels(),
    intervalMs: config.intervalMs,
    maxConcurrent: config.maxConcurrent,
    logger: config.logger,
    // How long an occurrence may sit at 'running' before the reaper stops
    // believing it. Per-job `timeoutMinutes` overrides this; 30 if neither.
    timeoutMinutes: config.timeoutMinutes,
    onTimeout: config.onTimeout
  });
  return _schedulerHandle;
}

function stopScheduler() {
  scheduler.stopScheduler();
  _schedulerHandle = null;
}

/**
 * Start as a standalone Express server. Boots the scheduler in the same
 * process by default; set startScheduler:false to run the API only.
 */
async function start(config) {
  config = config || {};

  // AWAITED, and everything below depends on it.
  //
  // The connection has to exist before the router is built, because the CRUD
  // mounts hand a MODEL CLASS to genericRoute at build time and that class has
  // to be bound to jobs' own connection. Since init() no longer sets the
  // process-global Objection binding (bind:false — see lib/db.js), an unbound
  // class now has no knex at all rather than quietly borrowing whatever the
  // process last bound.
  //
  // It was previously called and not awaited, so the first scheduler tick
  // could fire against an unready connection. That failed softly — the tick's
  // own try/catch logged it and the next one five seconds later usually
  // worked — which is exactly why it survived unnoticed.
  await init(config);

  const port = config.port || process.env.JOBS_PORT || 19003;
  const app = createApp(port, 'xeplr-jobs', {
    corsOptions: config.corsOptions,
    middleware: config.middleware,
    routes: { '/': router(config.routerOptions) }
  });

  if (config.startScheduler !== false) {
    startScheduler({
      intervalMs: config.intervalMs,
      maxConcurrent: config.maxConcurrent,
      logger: config.logger,
      timeoutMinutes: config.timeoutMinutes,
      onTimeout: config.onTimeout
    });
  }

  return app;
}

// Env vars this library needs — apps spread this into their env.required.js
// so the names live here (change once, every app picks it up) rather than
// being re-listed per app. Same convention as @xeplr/auth's requiredEnv.
//
// DB_JOBS is the DATABASE, which is a different question from the SERVER: the
// login normally comes from the shared XEPLR_DB_CONNECTION, but every app
// embedding jobs owns its own jobs store and there is no defensible default
// for which one (see lib/db.js, which now refuses rather than guessing).
var requiredEnv = [
  'DB_JOBS'
];

module.exports = {
  requiredEnv,
  init,
  router,
  start,
  models,
  // The BOUND models — Job.bindKnex(conn()) / JobOccurrence.bindKnex(conn()),
  // the same pair router()/startScheduler() already build internally via
  // lib/db.js's boundModels(). `models` above is the raw, unbound export —
  // querying it directly has no connection attached at all (jobs
  // deliberately never does the process-global Model.knex() bind; see
  // lib/db.js's own comment on why). A host app that wants to create/edit
  // Job rows itself (not just through router()'s HTTP surface) needs this,
  // not `models` — call only after init() has resolved.
  boundModels: jobsDb.boundModels,
  startScheduler,
  stopScheduler,
  warnIfUnscoped,
  // init() calls this for you. Exported for a host that passes
  // defaultActions:false and wants to decide when.
  registerDefaultActions,

  // Re-export from @xeplr/actions so consumers who install jobs don't need
  // to install actions separately for the common case (register + run).
  registerAction:          actions.register,
  listActions:             actions.list,
  runAction:               actions.runAction,
  ActionNotRegisteredError: actions.ActionNotRegisteredError,
  TransientError:           actions.TransientError
};
