// Job Occurrences — one row per execution attempt of a Job. Retries stay on
// the same row (retryCount bumps). Reactive-fired occurrences carry the
// grouping tag of the reactive chain root, so all occurrences in a chain
// can be queried together.
//   triggeredBy: { type: 'cron'|'reactive'|'manual',
//                   sourceJobId?, sourceOccurrenceId? }
exports.up = function(knex) {
  return knex.schema.createTable('jobOccurrences', function(table) {
    table.string('id', 25).primary();
    table.string('jobId', 25).notNullable();
    table.string('status', 20).notNullable();
    table.timestamp('startedAt').notNullable();
    table.timestamp('endedAt');
    table.jsonb('systemOutput');
    table.jsonb('contextOutput');
    table.jsonb('dataOutput');
    table.jsonb('error');
    table.integer('retryCount').notNullable().defaultTo(0);
    table.jsonb('triggeredBy').notNullable();
    table.string('groupingTag', 25).notNullable();
    table.boolean('isActive').defaultTo(true);
    table.timestamp('recordCreatedDate').defaultTo(knex.fn.now());
    table.timestamp('recordModifiedDate').defaultTo(knex.fn.now());
    table.string('recordCreatedBy', 25);
    table.string('recordModifiedBy', 25);

    table.index(['jobId', 'startedAt']);
    table.index('groupingTag');
    table.index('status');
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('jobOccurrences');
};
