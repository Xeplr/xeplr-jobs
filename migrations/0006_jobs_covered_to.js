// HOW FAR THE DATA HAS GOT — which is not the same question as when the job
// last ran, and not the same question as when it runs next.
//
// A job that moves a window of rows needs to know where the last one ended.
// Three things already on the row look like they could answer that, and none
// of them can:
//
//   nextRunAt          WHEN TO FIRE. Advances on every cron run whatever the
//                      outcome — a failed 10:00 run still leaves it at 11:00,
//                      which is correct for scheduling and catastrophic for
//                      data. Derive `from` off the schedule and the window the
//                      failed run was supposed to cover is skipped forever,
//                      silently.
//
//   occurrence.endedAt WHEN THE PROCESS STOPPED. A run that fires at 11:00:03
//                      and covers 10:00 → 11:00 has an endedAt of 11:00:07.
//                      Use that as the next `from` and seven seconds are lost
//                      per run, compounding forever.
//
//   the schedule       Only agrees with reality while nothing goes wrong. A
//                      failed run, a run skipped because the previous one was
//                      still holding the lock, a job paused for three days, or
//                      a manual trigger at 10:37 with no slot at all — in
//                      every one of those, cron says one thing and the data
//                      says another.
//
// So it is its own column, and it advances on its own rule: ONLY ON SUCCESS.
// nextRunAt and coveredTo then move independently, which is exactly the
// behaviour wanted — a failed 10:00 run leaves the schedule at 11:00 and the
// coverage at 09:00, so the 11:00 run picks up 09:00 → 11:00 by itself and
// nothing is lost, without anybody rescheduling anything.
//
// ── half-open, so there is no +1 second ──────────────────────────────────
//
// db-move's window is `from <= x < to`. The last run took everything below
// 11:00:00, so this run starting AT 11:00:00 is exact: no gap, no overlap.
// The familiar "+1 second" convention belongs to CLOSED windows, where the
// boundary row would otherwise be read twice. Applied here it opens a hole —
// a row at 11:00:00.4 is below the old `to` and below the new `from`, so
// nothing ever moves it. coveredTo therefore stores the window's own `to`,
// and the next run's `from` is that value unchanged.
//
// ── incrementalMode ──────────────────────────────────────────────────────
//
// The run establishes a period; the JOB decides what to do with it, because
// the right answer differs per job even within one chain:
//
//   null         Not incremental. No window is computed and none is imposed —
//                the job runs on whatever its own inputs say. This is also
//                what "just give me all the data and aggregate it" is: there
//                is no separate 'full' mode because 'full' IS no window.
//
//   'period'     Use the period as given: from = coveredTo, to = now.
//                Deterministic, and the safe default of the two — on a target
//                that already holds those rows it re-moves them, which is a
//                duplicate under `append` and a no-op under `upsert`, and
//                visible either way.
//
//   'watermark'  from = max(column) in the job's OWN target, to = now. For
//                independent jobs sequenced only for ordering, each resolving
//                against its own target. NOT WIRED YET — it needs the action
//                to run a SELECT max against the target it is about to write
//                to, which is the action's business and not this layer's.
//                Refused with a message rather than accepted and ignored:
//                silently skipping rows nobody can see is the one failure
//                mode this whole column exists to prevent.

exports.up = async function (knex) {
  await knex.schema.alterTable('jobs', function (table) {
    // NULL = nothing covered yet. The first run's window is therefore
    // ( -inf, now ) — everything — which is what a first incremental load
    // means and what db-move already does with a null `from`.
    table.timestamp('coveredTo');

    // NULL = not incremental. Deliberately not defaulted to 'period': every
    // job that exists today runs on its own inputs, and imposing a window on
    // them would change what they move.
    table.string('incrementalMode', 20);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('jobs', function (table) {
    table.dropColumn('coveredTo');
    table.dropColumn('incrementalMode');
  });
};
