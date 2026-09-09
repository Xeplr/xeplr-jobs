// WHERE TO REPORT WHEN THIS RUN ENDS.
//
// A workflow step that starts a job cannot sit and wait for it: a movement
// runs for twenty minutes, and the workflow engine is not going to hold an
// HTTP request or an in-process await open across that. So the step parks on
// its resume key and the job calls back when it is done — the same mechanism
// an emailed approval link uses, and for the same reason: the thing that
// finishes is not the thing that started it, and may finish long afterwards.
//
// ON THE OCCURRENCE, NOT ON THE JOB, and that is the whole reason this is a
// column rather than a variable held in the worker's memory:
//
//   - It is per RUN. The same job can be started by a workflow now and by its
//     cron in ten minutes; only one of those has anybody waiting on it.
//   - THE REAPER HAS TO BE ABLE TO FIND IT. A worker that is SIGKILLed never
//     reports anything. The occurrence is marked timedOut by a different
//     process, possibly on a different machine, and that process must be able
//     to tell the waiting workflow — otherwise the step waits forever with
//     nothing anywhere saying why. An in-memory callback dies with the worker,
//     which is precisely the case it exists to cover.
//
// NULL for the overwhelming majority of runs: a cron tick has nobody waiting.
exports.up = function (knex) {
  return knex.schema.alterTable('jobOccurrences', function (table) {
    table.text('callbackUrl');
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable('jobOccurrences', function (table) {
    table.dropColumn('callbackUrl');
  });
};
