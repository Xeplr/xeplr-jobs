// Jobs — instances of a Job Type with user-filled config + runtime metadata.
//   schedule    — cron expression; NULL for reactive or manual-only jobs
//   paramSchema — array of param definitions; present only for reactive jobs
//   running     — lock flag; the scheduler skips rows where running=true
exports.up = function(knex) {
  return knex.schema.createTable('jobs', function(table) {
    table.string('id', 25).primary();
    table.string('jobTypeId', 25).notNullable();
    table.string('name', 255).notNullable();
    table.text('description');
    table.jsonb('jobInputs').notNullable().defaultTo('{}');
    table.string('status', 20).notNullable().defaultTo('ready');
    table.boolean('running').notNullable().defaultTo(false);
    table.string('schedule', 100);
    table.timestamp('nextRunAt');
    table.jsonb('paramSchema');
    table.jsonb('outputSchema').notNullable().defaultTo('{"context":{},"data":{}}');
    table.string('outputSchemaMode', 20).notNullable().defaultTo('learn');
    table.boolean('isActive').defaultTo(true);
    table.timestamp('recordCreatedDate').defaultTo(knex.fn.now());
    table.timestamp('recordModifiedDate').defaultTo(knex.fn.now());
    table.string('recordCreatedBy', 25);
    table.string('recordModifiedBy', 25);

    table.index(['status', 'running', 'nextRunAt'], 'idx_jobs_picker');
    table.index('jobTypeId');
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('jobs');
};
