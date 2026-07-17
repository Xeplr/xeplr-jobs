// Job Occurrences — one row per execution attempt of a Job.
//   input       — the resolved inputs at run time (snapshot for auditability)
//   output      — whatever the action returned (opaque to the framework)
//   error       — { name, message, stack, details? } when status=failed|skipped
//   triggeredBy — { type: 'cron'|'manual' }
//   durationMs  — from the action runner
exports.up = function(knex) {
  return knex.schema.createTable('jobOccurrences', function(table) {
    table.string('id', 25).primary();
    table.string('jobId', 25).notNullable();
    table.string('status', 20).notNullable();           // 'running'|'success'|'failed'|'skipped'
    table.timestamp('startedAt').notNullable();
    table.timestamp('endedAt');
    table.jsonb('input');
    table.jsonb('output');
    table.jsonb('error');
    table.integer('retryCount').notNullable().defaultTo(0);
    table.jsonb('triggeredBy').notNullable();
    table.integer('durationMs');
    table.boolean('isActive').defaultTo(true);
    table.timestamp('recordCreatedDate').defaultTo(knex.fn.now());
    table.timestamp('recordModifiedDate').defaultTo(knex.fn.now());
    table.string('recordCreatedBy', 25);
    table.string('recordModifiedBy', 25);

    table.index(['jobId', 'startedAt']);
    table.index('status');
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('jobOccurrences');
};
