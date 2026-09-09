// Three things a scheduled job needs and did not have: WHEN IT MAY FIRST RUN,
// WHETHER A FAILURE IS RETRIED, and HOW LONG "running" is allowed to mean
// anything.
//
// ── startAt ──────────────────────────────────────────────────────────────
//
// "Every fifteen minutes, but not before 1 Jan 2027."
//
// The obvious shortcut is to write the start date into `nextRunAt` and let the
// existing picker (which already refuses a job whose nextRunAt is in the
// future) do the rest. It does not work: nextRunAt is RECOMPUTED from the cron
// expression on save, so the start date is overwritten and the job fires on
// its next cron tick instead. Verified by saving a paused job and reading the
// row back — it came back with a nextRunAt of its own.
//
// So the two are different facts and need different columns. nextRunAt is
// derived and rewritten constantly; startAt is authored once and never touched
// by the scheduler.
//
// ── retry ────────────────────────────────────────────────────────────────
//
// Whether a FAILED occurrence is tried again, and how many times.
// jobOccurrences.retryCount already exists to count attempts; nothing decided
// whether to make them. Default 0 — an action that failed once will usually
// fail again, and silently re-running something that moves data is worse than
// leaving it failed and visible.
//
// ── timeoutMinutes ───────────────────────────────────────────────────────
//
// `running` is a boolean lock with no expiry (see 0001). A worker that is
// SIGKILLed, OOM-killed or redeployed mid-run never clears it, and that job
// never runs again — silently, forever. Nothing reaps it today.
//
// A process writes its own terminal state for anything it can CATCH; what it
// cannot catch is being killed. So a row still `running` past any plausible
// duration is not a slow job, it is an edge case nobody was told about — and
// that is why the reaper writes 'timedOut' and not 'failed'. `failed` means
// the process reported what went wrong. `timedOut` means nobody came back.
// Collapsing them throws away the only evidence an uncatchable death occurred.
//
// 30 minutes by default, overridable per job. NO HEARTBEAT: a job that
// legitimately runs longer is the user's to configure — they know their job's
// runtime and the system does not.

exports.up = async function (knex) {
  await knex.schema.alterTable('jobs', function (table) {
    // Nullable = "as soon as the schedule says", which is what every existing
    // job means and what a new one means unless told otherwise.
    table.timestamp('startAt');

    // 0 = do not retry. Kept as a count rather than a boolean so "retry twice"
    // does not need a second column later.
    table.integer('retryLimit').notNullable().defaultTo(0);

    // NULL = use the scheduler's default (30). Stored per job so a four-hour
    // build can say so without raising the ceiling for everything else.
    table.integer('timeoutMinutes');
  });

  // The picker gains `startAt` to its WHERE, so it belongs in the covering
  // index next to the columns it is filtered with — otherwise the new
  // condition is the one thing forcing a heap lookup per candidate row.
  await knex.schema.alterTable('jobs', function (table) {
    table.index(['status', 'running', 'startAt', 'nextRunAt'], 'idx_jobs_picker_start');
  });

  // Reaping asks a different question from picking — "what is running, and
  // since when" — and answers it across every tenant at once. Without this it
  // is a full scan on each tick.
  await knex.schema.alterTable('jobOccurrences', function (table) {
    table.index(['status', 'startedAt'], 'idx_occurrences_running');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('jobOccurrences', function (table) {
    table.dropIndex(['status', 'startedAt'], 'idx_occurrences_running');
  });
  await knex.schema.alterTable('jobs', function (table) {
    table.dropIndex(['status', 'running', 'startAt', 'nextRunAt'], 'idx_jobs_picker_start');
    table.dropColumn('startAt');
    table.dropColumn('retryLimit');
    table.dropColumn('timeoutMinutes');
  });
};
