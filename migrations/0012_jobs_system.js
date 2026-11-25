// A JOB OF THE INSTALL ITSELF, which nobody changes from the screen.
//
// The workflow engine's "do what is due" job (Wait boxes that time out,
// reminders, escalations, runs whose process died) is the one clock for every
// company on the install. It is written with mtId1..mtId4 = '*', so every
// company's Jobs screen lists it and its runs — and `system = true`, so the
// routes refuse to save, pause, resume or delete it for every caller, Super
// Admin included. Pausing it would stop that work for everyone; only code
// changes it (keepSchedule(..., { system: true })). Running it now is allowed:
// it only does what is already due, once.
//
// Its own column rather than "mtId1 = '*'": jobs from before tenancy were
// moved to '*' by 0003, and they are ordinary jobs somebody may edit.
exports.up = function (knex) {
  return knex.schema.alterTable('jobs', function (table) {
    table.boolean('system').notNullable().defaultTo(false);
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable('jobs', function (table) {
    table.dropColumn('system');
  });
};
