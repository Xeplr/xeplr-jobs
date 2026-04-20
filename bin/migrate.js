#!/usr/bin/env node

const path = require('path');
const { up, rollback, status } = require('@xeplr/db').migrator;

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
    db: args.db || process.env.DB_JOBS || process.env.DB_NAME,
    dir: path.join(__dirname, '..', 'migrations')
  };

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
      console.log('  up [--db <name>]       Run pending migrations');
      console.log('  rollback [--db <name>]  Rollback last batch');
      console.log('  status [--db <name>]    Show migration status');
      console.log('');
      console.log('Options:');
      console.log('  --db        Database name (or DB_JOBS env)');
      console.log('  --host      DB host (default: DB_HOST env or localhost)');
      console.log('  --user      DB user (default: DB_USER env or root)');
      console.log('  --password  DB password (default: DB_PASSWORD env)');
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
