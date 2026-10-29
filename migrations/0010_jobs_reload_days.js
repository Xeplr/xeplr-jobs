// RE-READ THE LAST N DAYS — for a job whose runs continue from what is
// already loaded (incrementalMode 'watermark').
//
// A source whose rows change after they are first written (a late payment, an
// order edited the next day) is never re-read by "everything past the highest
// value": the edited row is below it. Re-reading the last N days and replacing
// the copy's rows from there picks those up. It is the JOB's decision, like
// the mode itself, because the same movement can be run nightly with a week's
// re-read and by hand with none.
//
// Null = no re-read. Only 'watermark' uses it: a 'period' run already covers
// an exact range.
exports.up = function (knex) {
  return knex.schema.alterTable('jobs', function (table) {
    table.integer('reloadDays');
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable('jobs', function (table) {
    table.dropColumn('reloadDays');
  });
};
