const { getConnection, bindModels } = require('@xeplr/db');
const createApp = require('@xeplr/base-apis/express');
const createJobRouter = require('./lib/jobRouter');
const scheduler = require('./lib/scheduler');
const registry = require('./lib/registry');
const errors = require('./lib/errors');
const models = require('./models');

let _initialized = false;
let _schedulerHandle = null;

/**
 * Initialize xeplr-jobs — wires up the DB connection and binds models.
 * Call once at process startup before creating routers or starting the scheduler.
 */
function init(config) {
  config = config || {};
  const dbName = config.database || process.env.DB_JOBS || 'jobs';
  const dbOptions = Object.assign(
    { connectionName: config.connectionName || 'jobs' },
    config.db || {}
  );
  const connection = getConnection(dbName, dbOptions);
  bindModels(connection);
  _initialized = true;
  return connection;
}

/**
 * Build the Express router (job types, jobs, reactivity, occurrences + actions).
 * Call init() first.
 */
function router(options) {
  return createJobRouter(options || {});
}

/**
 * Start the scheduler loop against the initialized DB connection.
 * config: { intervalMs, maxConcurrent, logger }
 */
function startScheduler(config) {
  config = config || {};
  _schedulerHandle = scheduler.startScheduler({
    models: models,
    intervalMs: config.intervalMs,
    maxConcurrent: config.maxConcurrent,
    logger: config.logger
  });
  return _schedulerHandle;
}

function stopScheduler() {
  scheduler.stopScheduler();
  _schedulerHandle = null;
}

/**
 * Start xeplr-jobs as a standalone Express server. Optionally boots the
 * scheduler in the same process (default: true — set startScheduler:false
 * to run the API only, e.g. when the scheduler is a separate deploy).
 */
function start(config) {
  config = config || {};
  init(config);

  const port = config.port || process.env.JOBS_PORT || 19003;
  const jobRouter = createJobRouter(config.routerOptions);
  const app = createApp(port, 'xeplr-jobs', {
    corsOptions: config.corsOptions,
    middleware: config.middleware,
    routes: { '/': jobRouter }
  });

  if (config.startScheduler !== false) {
    startScheduler({
      intervalMs: config.intervalMs,
      maxConcurrent: config.maxConcurrent,
      logger: config.logger
    });
  }

  return app;
}

module.exports = {
  init,
  router,
  start,
  models,
  startScheduler,
  stopScheduler,
  registerExecutor: registry.registerExecutor,
  getExecutor: registry.getExecutor,
  listRegistered: registry.listRegistered,
  TransientError: errors.TransientError,
  ValidationError: errors.ValidationError,
  ExecutorNotRegisteredError: errors.ExecutorNotRegisteredError
};
