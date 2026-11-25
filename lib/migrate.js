// JOBS' OWN TABLES, brought up to date — for `xeplr-jobs-migrate up` and for
// init({ migrate: true }) alike, so the two can never read the settings two
// different ways.
var path = require('path');
var { up } = require('@xeplr/db').migrator;
var { migrationsFor } = require('@xeplr/db');

var MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

/**
 * options: { db, connectionName, extDir? } — the connection must already be
 * resolved under connectionName. XEPLR_JOBS_MIGRATIONS adds a host's own
 * directories after these.
 */
function migrateUp(options) {
  return up({
    db: options.db,
    dir: MIGRATIONS_DIR,
    extDir: options.extDir || migrationsFor('jobs'),
    type: 'precede',
    connectionName: options.connectionName || 'jobs'
  });
}

module.exports = { migrateUp: migrateUp, MIGRATIONS_DIR: MIGRATIONS_DIR };
