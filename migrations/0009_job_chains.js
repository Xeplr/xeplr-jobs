// WHAT A JOB TAKES FROM THE JOB BEFORE IT, AND WHAT TRAVELS WITH A CHAIN.
//
// Jobs never start each other — the workflow engine does that (one rule for
// every hand-off, jobs and screens alike). These two columns are only what
// that engine needs from this package to carry data between runs.
//
// jobs.acceptsInputs — the input keys THIS job lets a trigger fill, beyond the
//   router's overridableInputs (by default only `window`). The job's author
//   names them, so a chain can pass `region` into a job that asked for it but
//   can never replace a job's SQL or connection: that stays the decision of
//   whoever saved the job. NULL = nothing beyond the default.
//
// jobOccurrences.chain — whatever the trigger handed in to travel with this run
//   (the workflow engine puts its carried values here). Opaque to jobs: stored,
//   and handed back in the finish report, so the next hop can read it. ON THE
//   OCCURRENCE for the same reason callbackUrl is — the reaper reports a run
//   from another process, and must be able to report this too.
exports.up = function (knex) {
  return knex.schema
    .alterTable('jobs', function (table) {
      table.jsonb('acceptsInputs');
    })
    .alterTable('jobOccurrences', function (table) {
      table.jsonb('chain');
    });
};

exports.down = function (knex) {
  return knex.schema
    .alterTable('jobOccurrences', function (table) {
      table.dropColumn('chain');
    })
    .alterTable('jobs', function (table) {
      table.dropColumn('acceptsInputs');
    });
};
