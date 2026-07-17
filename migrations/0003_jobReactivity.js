// Job Reactivity — links a downstream (target) Job to an upstream (source) Job.
// On source success the framework enqueues an occurrence of target, with
// params resolved from source's output via paramMapping:
//   { targetParamName: 'context.fieldPath' | 'data.field.path' }
exports.up = function(knex) {
  return knex.schema.createTable('jobReactivity', function(table) {
    table.string('id', 25).primary();
    table.string('sourceJobId', 25).notNullable();
    table.string('targetJobId', 25).notNullable();
    table.jsonb('paramMapping').notNullable();
    table.boolean('isActive').defaultTo(true);
    table.timestamp('recordCreatedDate').defaultTo(knex.fn.now());
    table.timestamp('recordModifiedDate').defaultTo(knex.fn.now());
    table.string('recordCreatedBy', 25);
    table.string('recordModifiedBy', 25);

    table.unique(['sourceJobId', 'targetJobId']);
    table.index('sourceJobId');
    table.index('targetJobId');
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('jobReactivity');
};
