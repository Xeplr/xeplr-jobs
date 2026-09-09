#!/usr/bin/env node

// Reads process.env ONLY. The consuming app loads its .env (e.g. via dotenv-cli
// in the npm script) — @xeplr/* packages never read .env files.

const path = require('path');
const { up, rollback, status } = require('@xeplr/db').migrator;
const { resolveConfig, migrationsFor, ensureDatabaseFor } = require('@xeplr/db');

/**
 * xeplr-jobs-migrate
 *
 * Runs jobs migrations bundled with this package.
 * Reuses xeplr-db's migrator — no duplicated knex logic.
 */

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1] || true;
      i++;
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  const options = {
    ...args,
    // NOT DB_NAME. A migrator that falls back to some other app's database
    // name creates the jobs tables inside it — the one mistake a migration
    // tool must not make quietly. Missing is an error, checked below.
    db: args.db || process.env.DB_JOBS,
    dir: path.join(__dirname, '..', 'migrations'),
    // XEPLR_JOBS_MIGRATIONS — an app extends the jobs schema (extra columns,
    // seed job definitions) from its own directory. Same convention as every
    // other xeplr library; see @xeplr/db's app-migrations.js.
    extDir: args.extDir || args['ext-dir'] || migrationsFor('jobs'),
    type: 'precede',
    connectionName: args['connection-name'] || args.connectionName || 'jobs'
  };

  if (['up', 'rollback', 'status'].indexOf(command) !== -1) {
    if (!options.db) {
      console.error('Missing database: set DB_JOBS or pass --db=<name>. Each app embedding ' +
        '@xeplr/jobs owns its own jobs database, so there is no default to fall back to.');
      process.exit(1);
    }
    var resolved = await resolveConfig(options.connectionName);

    // CREATE THE DATABASE IF IT IS NOT THERE, so this CLI does not depend on
    // the app having been booted first. Each app owns its own jobs database,
    // and the usual order on a clean machine is `migrate:up` BEFORE the first
    // start — which meant migrating a database nothing had created yet.
    // Idempotent, and identical to what init() does on the app side.
    if (command === 'up') {
      var ensured = await ensureDatabaseFor(resolved, options.db);
      if (ensured.created) console.log('Created database ' + options.db);
    }
  }

  switch (command) {
    case 'up': {
      const result = await up(options);
      if (result.migrations.length === 0) {
        console.log('Already up to date');
      } else {
        console.log(`Batch ${result.batch} ran ${result.migrations.length} migrations:`);
        result.migrations.forEach(m => console.log(`  - ${m}`));
      }
      break;
    }
    case 'rollback': {
      const result = await rollback(options);
      if (result.migrations.length === 0) {
        console.log('Nothing to rollback');
      } else {
        console.log(`Rolled back ${result.migrations.length} migrations:`);
        result.migrations.forEach(m => console.log(`  - ${m}`));
      }
      break;
    }
    case 'status': {
      const result = await status(options);
      console.log('Completed migrations:');
      result.completed.forEach(m => console.log(`  ✓ ${m}`));
      if (result.pending.length) {
        console.log('Pending migrations:');
        result.pending.forEach(m => console.log(`  ○ ${m}`));
      } else {
        console.log('No pending migrations');
      }
      break;
    }
    default:
      console.log('xeplr-jobs-migrate - Jobs database migrations');
      console.log('');
      console.log('Commands:');
      console.log('  up [--db <name>]        Run pending migrations');
      console.log('  rollback [--db <name>]  Rollback last batch');
      console.log('  status [--db <name>]    Show migration status');
      console.log('');
      console.log('Options:');
      console.log('  --db        Database name (or DB_JOBS env)');
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
