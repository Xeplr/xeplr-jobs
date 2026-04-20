const { getConnection, bindModels } = require('@xeplr/db');
const createApp = require('@xeplr/base-apis/express');
const createJobRouter = require('./lib/jobRouter');

let _initialized = false;

/**
 * Initialize xeplr-jobs.
 *
 * @param {object} config
 * @param {string} config.database - Database name for job tables
 * @param {object} [config.db] - DB connection options { host, user, password, port }
 */
function init(config = {}) {
  const dbName = config.database || process.env.DB_JOBS || 'jobs';
  const dbOptions = Object.assign({ connectionName: config.connectionName || 'jobs' }, config.db || {});
  const connection = getConnection(dbName, dbOptions);
  bindModels(connection);

  _initialized = true;
  return connection;
}

/**
 * Get the Express router for job API endpoints.
 * Must call init() first.
 */
function router(options = {}) {
  return createJobRouter(options);
}

/**
 * Start xeplr-jobs as a standalone Express API server.
 *
 * @param {object} config
 * @param {number|string} config.port - Port to listen on (default: JOBS_PORT env or 19003)
 * @param {string} [config.database] - Database name
 * @param {object} [config.db] - DB connection options
 * @param {object} [config.corsOptions] - CORS options
 * @param {Function[]} [config.middleware] - Additional middleware
 * @returns {{ app, server }}
 */
function start(config = {}) {
  init(config);

  const port = config.port || process.env.JOBS_PORT || 19003;
  const jobRouter = createJobRouter();

  return createApp(port, 'xeplr-jobs', {
    corsOptions: config.corsOptions,
    middleware: config.middleware,
    routes: { '/': jobRouter }
  });
}

module.exports = {
  init,
  router,
  start
};
