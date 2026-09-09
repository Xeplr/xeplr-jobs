// A run that was declared dead and then came back.
//
// The reaper marks an occurrence 'timedOut' when nobody has reported for
// longer than the job's tolerance. Usually that means the worker was killed.
// Sometimes it means the tolerance is simply lower than the job needs — and
// those two look identical from the outside, which makes "should I raise the
// timeout?" unanswerable.
//
// This is what tells them apart. When a worker finishes work that has already
// been timed out, it cannot overwrite the verdict (something else may have
// started in the meantime, so 'success' would be a claim nothing checked) —
// it records what actually happened here instead:
//
//   { status, durationMs, ranForMinutes, finishedAt, note }
//
// So: an occurrence with lateFinish set is a job whose "give up after" is too
// low, and ranForMinutes says what to raise it to. An occurrence that is
// timedOut with NO lateFinish is a worker that really did die.
exports.up = function (knex) {
  return knex.schema.alterTable('jobOccurrences', function (table) {
    table.jsonb('lateFinish');
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable('jobOccurrences', function (table) {
    table.dropColumn('lateFinish');
  });
};
