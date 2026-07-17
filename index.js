const { getConnection, bindModels } = require('@xeplr/db');
const createApp = require('@xeplr/base-apis/express');
const createJobRouter = require('./lib/jobRouter');
const scheduler = require('./lib/scheduler');
const models = require('./models');
const actions = require('@xeplr/actions');

let _schedulerHandle = null;

/**
 * Initialize xeplr-jobs — wires the DB connection and binds models.
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
  return connection;
}

function router(options) { return createJobRouter(options || {}); }

/**
 * Start the scheduler loop.
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
 * Start as a standalone Express server. Boots the scheduler in the same
 * process by default; set startScheduler:false to run the API only.
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

  // Re-export from @xeplr/actions so consumers who install jobs don't need
  // to install actions separately for the common case (register + run).
  registerAction:          actions.register,
  listActions:             actions.list,
  runAction:               actions.runAction,
  ActionNotRegisteredError: actions.ActionNotRegisteredError,
  TransientError:           actions.TransientError
};
