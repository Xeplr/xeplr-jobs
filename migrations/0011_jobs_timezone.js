// THE TIME ZONE A JOB'S SCHEDULE IS READ IN.
//
// "0 9 * * 1" means Mondays at 9:00 — but 9:00 where? Until now, the server's.
// A business that runs its month-end load "at 2 in the morning" means 2 in the
// morning where the business is, and a server in UTC fired it hours off.
//
// An IANA name (Asia/Kolkata, Europe/London). NULL = the server's own zone,
// which is what every job did before this column existed. Read wherever the
// next run is worked out (lib/cron.js computeNextRun): on insert, after a cron
// run, when the reaper moves a stuck job on, and by keepSchedule.
exports.up = function (knex) {
  return knex.schema.alterTable('jobs', function (table) {
    table.string('timezone', 64);
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable('jobs', function (table) {
    table.dropColumn('timezone');
  });
};
