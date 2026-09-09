// WHAT A LONG RUN IS DOING WHILE IT IS DOING IT.
//
// Until now a running occurrence carried `status` and `retryCount` and
// nothing else, so a movement of four hundred thousand rows said "running"
// for twenty minutes and then jumped to done. There was no number to show,
// which is why the only way to learn anything was to reload the page — and
// reloading told you the same nothing, just more expensively.
//
// The number already existed at every layer but this one. uploader's
// onProgress fires per batch with { rowsRead, batches }, and db-move already
// forwards `system.onProgress` to it. Nothing ever passed one in.
//
// ROWS READ, NOT ROWS LANDED — that is the uploader's own choice and it is
// the honest one: the write queue drains behind the read, so waiting for
// confirmation would report zero for minutes on end. And there is no total,
// because a query source has no count without running it twice. A caller
// wanting a percentage supplies its own denominator.
//
// jsonb rather than an integer column, because "progress" means different
// things to different actions — rows for a movement, files for an import,
// steps for something else — and the shape is the action's to decide.
//
// THROTTLED AT THE WRITER, not here. At 5000 rows a batch a 40M-row move
// fires 8000 times; every one of those becoming an UPDATE would cost more
// than the movement. See makeProgressReporter in lib/execute.js.
exports.up = function (knex) {
  return knex.schema.alterTable('jobOccurrences', function (table) {
    table.jsonb('progress');
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable('jobOccurrences', function (table) {
    table.dropColumn('progress');
  });
};
