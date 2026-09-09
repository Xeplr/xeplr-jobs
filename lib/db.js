var { getConnection, ensureDatabaseFor } = require('@xeplr/db');
var models = require('../models');

var _conn = null;

/**
 * Bind jobs' own models to a connection.
 *
 * bind:false — A SECONDARY CONNECTION, never the process's global one.
 *
 * @xeplr/db's bindModels does `Model.knex(instance)` on OBJECTION'S BASE
 * CLASS, so it is global: the last getConnection with bind:true wins for every
 * model in the process, whoever declared it. Standalone that is harmless,
 * because jobs is the only thing here. EMBEDDED in a host app it is not —
 * connecting to a jobs database re-points the host's models at it too, and the
 * host's own routes start failing on tables that were never in that database.
 *
 * It has been invisible so far only because the one host embedding jobs points
 * DB_JOBS at its own database, so the binding happened to land in the right
 * place. Point it anywhere else and the host breaks.
 *
 * Same shape as @xeplr/auth's attach() reaching the auth DB from the api
 * process, and @xeplr/actions' attachConfig() for xeplr_configs.
 */
async function connectJobsDb(config) {
  config = config || {};
  // NO 'jobs' FALLBACK. A default database name is the worst possible
  // outcome here: the process starts, migrations create the tables, jobs
  // schedule and run — all in a database nobody meant to use, which then
  // looks empty from the app that was supposed to own them. A host embedding
  // jobs supplies its own store (DB_JOBS=xeplr_bi_jobs), and if it forgot,
  // saying so is far better than guessing.
  var dbName = config.database || process.env.DB_JOBS;
  if (!dbName) {
    throw new Error(
      '@xeplr/jobs: no database. Set DB_JOBS (or pass config.database) — each app ' +
      'embedding jobs owns its own jobs database, so there is no safe default. ' +
      'Spread require("@xeplr/jobs").requiredEnv into your env.required.js to catch ' +
      'this at startup instead of here.');
  }
  // CREATE IT IF IT IS NOT THERE — each app owns its own jobs database
  // (xeplr_bi_jobs), so a name that does not exist yet is the normal first
  // boot rather than an error. Same as @xeplr/email and @xeplr-workflow/api.
  var source = config.connection || config.db;
  var ensured = await ensureDatabaseFor(source, dbName);
  if (ensured.created) console.log('[jobs] created database ' + dbName);

  _conn = await getConnection(dbName, source, {
    bind: false,
    connectionName: config.connectionName || 'jobs'
  });
  return _conn;
}

function conn() {
  if (!_conn) throw new Error('@xeplr/jobs: connection not ready — await init() first');
  return _conn;
}

/**
 * A jobs model BOUND to jobs' own connection.
 *
 * Objection caches per (Model, knex) pair, so this is a map lookup rather than
 * a new class per call.
 */
function model(name) {
  var M = models[name];
  if (!M) throw new Error('@xeplr/jobs: unknown model "' + name + '"');
  return M.bindKnex(conn());
}

/** Both models, bound — the shape the scheduler and executor already expect. */
function boundModels() {
  return { Job: model('Job'), JobOccurrence: model('JobOccurrence') };
}

module.exports = {
  connectJobsDb: connectJobsDb,
  conn: conn,
  model: model,
  boundModels: boundModels
};
