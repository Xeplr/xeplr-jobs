// Job Types — templates that declare the config a Job must fill in when created.
// configSchema is an array of field definitions:
//   [{ name, type, required, default, description, order }]
exports.up = function(knex) {
  return knex.schema.createTable('jobTypes', function(table) {
    table.string('id', 25).primary();
    table.string('name', 100).notNullable().unique();
    table.text('description');
    table.jsonb('configSchema').notNullable().defaultTo('[]');
    table.boolean('isActive').defaultTo(true);
    table.timestamp('recordCreatedDate').defaultTo(knex.fn.now());
    table.timestamp('recordModifiedDate').defaultTo(knex.fn.now());
    table.string('recordCreatedBy', 25);
    table.string('recordModifiedBy', 25);
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('jobTypes');
};
