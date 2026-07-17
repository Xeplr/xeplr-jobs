// Jobs — one row per scheduled/manual "run this action" instance.
//   actionName  — name of a registered action (see @xeplr/actions).
//   inputs      — JSON, validated against the action's inputSchema at run time.
//   schedule    — cron expression; NULL for manual-only jobs.
//   running     — lock flag; the scheduler skips rows where running=true.
exports.up = function(knex) {
  return knex.schema.createTable('jobs', function(table) {
    table.string('id', 25).primary();
    table.string('name', 255).notNullable();
    table.text('description');
    table.string('actionName', 100).notNullable();
    table.jsonb('inputs').notNullable().defaultTo('{}');
    table.string('status', 20).notNullable().defaultTo('ready');   // 'ready' | 'pause'
    table.boolean('running').notNullable().defaultTo(false);
    table.string('schedule', 100);
    table.timestamp('nextRunAt');
    table.boolean('isActive').defaultTo(true);
    table.timestamp('recordCreatedDate').defaultTo(knex.fn.now());
    table.timestamp('recordModifiedDate').defaultTo(knex.fn.now());
    table.string('recordCreatedBy', 25);
    table.string('recordModifiedBy', 25);

    table.index(['status', 'running', 'nextRunAt'], 'idx_jobs_picker');
    table.index('actionName');
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('jobs');
};
