var { executeJob, initExecutorState, currentConcurrency, maxConcurrency, mtOf, shutdownInFlight } = require('./execute');
var { computeNextRun } = require('./cron');
var { notifyCallback } = require('./notify');
var { runWithMt } = require('@xeplr/db');

var _timer = null;
var _ticking = false;

/**
 * Start the scheduler loop.
 *
 * config:
 *   models         — { Job, JobOccurrence }
 *   intervalMs     — poll interval (default 5000)
 *   maxConcurrent  — soft cap on scheduled picks per tick (default 20)
 *   logger         — { info(), error() } (default: console)
 */
function startScheduler(config) {
  if (_timer) throw new Error('Scheduler already started');
  if (!config || !config.models) throw new Error('startScheduler requires config.models');

  var models = config.models;
  var interval = config.intervalMs || 5000;
  var log = normalizeLogger(config.logger);

  initExecutorState({ maxConcurrent: config.maxConcurrent || 20, logger: log });

  async function tick() {
    if (_ticking) return;
    _ticking = true;
    try {
      // BEFORE picking, not after: a job whose lock was stranded by a killed
      // worker is invisible to the picker (running = true), so reaping first
      // is what lets it be picked again on this very tick rather than the
      // next one.
      await reapTimedOut(models, config, log);

      var capacity = maxConcurrency() - currentConcurrency();
      if (capacity <= 0) return;

      var nowIso = new Date().toISOString();
      // ACROSS EVERY TENANT, and it has to be.
      //
      // A tick is a timer, not a request: there is no AsyncLocalStorage
      // context and therefore no mtId. BaseModel.query()'s tenant modifier
      // answers that case with `where 1 = 0` — so the ordinary query finds
      // nothing, reports no error, and the scheduler quietly stops running
      // anything at all. That is the failure this exists to avoid.
      //
      // The obligation that comes with it is discharged one line down:
      // executeJob re-establishes each job's OWN context before touching
      // anything. Pick unscoped, run scoped, one tenant at a time.
      var jobs = await models.Job.unscopedQuery()
        .where({ status: 'ready', running: false })
        .whereNotNull('schedule')
        .where(function() {
          this.whereNull('nextRunAt').orWhere('nextRunAt', '<=', nowIso);
        })
        // NOT YET STARTED is a separate question from NOT YET DUE, and it has
        // to be asked separately: nextRunAt is recomputed from the cron
        // expression every time the job is saved or run, so a start date
        // written into it would be overwritten and the job would fire early.
        // startAt is authored once and never touched by this loop.
        .where(function() {
          this.whereNull('startAt').orWhere('startAt', '<=', nowIso);
        })
        .limit(capacity);

      for (var i = 0; i < jobs.length; i++) {
        executeJob(models, jobs[i], { type: 'cron' })
          .catch(function(err) { log.error('executeJob threw:', err); });
      }
    } catch (err) {
      // CRITICAL, and it is the only thing in this package that is.
      //
      // Everything else that fails here costs ONE job: it fails, it times out,
      // its lock sticks until the reaper clears it — all bad, all visible on
      // the error screen, all survivable. If the TICK throws, nothing runs at
      // all: nothing is picked, nothing is reaped, and no job fails to say so.
      // Every schedule in the product silently stops.
      //
      // That is the failure nobody notices until somebody asks why last
      // night's load never happened, which is exactly the case worth an email
      // rather than a row somebody has to go and look at.
      log.critical('Scheduler tick error — NO jobs are being picked or reaped: ' +
        ((err && err.message) || err), { stack: err && err.stack });
    } finally {
      _ticking = false;
    }
  }

  // STOP TAKING WORK, THEN CLOSE OUT WHAT WE HAVE.
  //
  // A deploy is the common case, not an exceptional one: without this, every
  // restart strands its in-flight jobs at 'running' and they look identical to
  // a crashed worker until the reaper's tolerance expires. SIGTERM is
  // catchable, so a planned stop can simply say so.
  //
  // Best effort by design — SIGKILL and OOM cannot be caught, so the reaper
  // remains the backstop for everything this misses. Registered once, and
  // removed on stopScheduler so a host that starts and stops the scheduler
  // repeatedly (tests) does not accumulate listeners.
  if (config.handleSignals !== false) registerShutdownHandlers(models, log);

  _timer = setInterval(tick, interval);
  tick();
  log.info('xeplr-jobs scheduler started (intervalMs=' + interval + ', maxConcurrent=' + (config.maxConcurrent || 20) + ')');
  return { stop: stopScheduler };
}

// How long an occurrence may sit at 'running' before we stop believing it.
var DEFAULT_TIMEOUT_MINUTES = 30;

/**
 * Close out occurrences whose worker is never coming back, and release the
 * job locks they stranded.
 *
 * WHY THIS HAS TO EXIST. `jobs.running` is a boolean lock with no expiry. A
 * process writes its own terminal state for anything it can CATCH — execute.js
 * does exactly that, in a finally block. What it cannot catch is being killed:
 * SIGKILL, an OOM kill, the container going away. No handler runs, the
 * occurrence stays 'running' and the lock stays true, and that job never runs
 * again. Silently, forever.
 *
 * WHY 'timedOut' AND NOT 'failed'. `failed` means the process caught the error
 * and told us what it was. `timedOut` means nobody came back and we are
 * inferring. They are different facts, and writing the second as the first
 * discards the only evidence that an uncatchable death happened — which is
 * precisely the thing worth being able to count.
 *
 * NO HEARTBEAT. A job that legitimately runs longer than its tolerance is a
 * configuration the user sets: they know their job's runtime and this does
 * not. The default is generous; a job that needs four hours says so.
 *
 * Unscoped, for the same reason the picker is — a timer has no tenant context,
 * and BaseModel's tenant modifier answers that with `where 1 = 0`.
 */
async function reapTimedOut(models, config, log) {
  var defaultMinutes = config.timeoutMinutes || DEFAULT_TIMEOUT_MINUTES;

  // Every in-flight occurrence, not just the old ones: the tolerance is
  // per-job and can be SHORTER than the default, so a cutoff computed from
  // the default would skip exactly those. There are only ever as many rows
  // here as there are jobs actually running.
  var running = await models.JobOccurrence.unscopedQuery()
    .where({ status: 'running' })
    .limit(500);
  if (!running.length) return;

  var now = Date.now();

  for (var i = 0; i < running.length; i++) {
    var occ = running[i];
    var job = await models.Job.unscopedQuery().findById(occ.jobId).catch(function() { return null; });

    var tolerance = (job && job.timeoutMinutes) || defaultMinutes;
    var startedMs = new Date(occ.startedAt).getTime();
    if (!startedMs || (now - startedMs) < tolerance * 60 * 1000) continue;

    var minutes = Math.round((now - startedMs) / 60000);
    var endedAt = new Date().toISOString();

    try {
      // Conditional on still being 'running' — if the worker came back in the
      // meantime and wrote its own result, that result is the true one and
      // this must not overwrite it.
      var closed = await models.JobOccurrence.unscopedQuery()
        .patch({
          status: 'timedOut',
          endedAt: endedAt,
          durationMs: now - startedMs,
          error: {
            name: 'TimedOut',
            message: 'Still running after ' + minutes + ' minutes (tolerance ' + tolerance + '). ' +
              'The worker never reported a result — it was most likely killed mid-run.'
          }
        })
        .where({ id: occ.id, status: 'running' });
      if (!closed) continue;

      // Release the lock the dead worker stranded, and move the job on to its
      // next slot so it does not immediately re-fire for the window that has
      // already passed.
      var releasePatch = { running: false };
      if (job && job.schedule) {
        try { releasePatch.nextRunAt = computeNextRun(job.schedule).toISOString(); }
        catch (e) { /* an invalid cron is already reported by execute.js */ }
      }
      await models.Job.unscopedQuery().patch(releasePatch).where({ id: occ.jobId });

      // NOT error level, by the rule this codebase keeps: an error is
      // something a CATCH BLOCK caught, or the global handler picked up
      // unexpectedly. This is neither — it is a condition the reaper goes
      // looking for on purpose and handles completely, on its expected path.
      //
      // That does not make it unimportant. A host that wants a timed-out job
      // on the error screen has onTimeout for exactly that, and is better
      // placed to judge: it knows whether this job mattered, and what else
      // downstream is now stuck. The package reports the fact; the host
      // decides how loud it is.
      log.important('Job ' + occ.jobId + ' occurrence ' + occ.id + ' timed out after ' +
        minutes + ' minutes (tolerance ' + tolerance + ') — lock released.');

      // TELL THE HOST, if it asked to be told.
      //
      // A job is usually the visible half of something the host owns: a job
      // running `move-run` carries a moveId, and that movement has its own run
      // row with its own status. A killed worker leaves BOTH stuck, and only
      // the host knows they are the same piece of work — this package cannot
      // know what a moveId is. So it reports the fact and lets the host act.
      //
      // AFTER the writes above, so what the callback reads is already final.
      // Awaited, so a host that must finish writing before the next tick can.
      // Wrapped, because a downstream notification failing must not stop the
      // reaper — the other stuck jobs still need clearing.
      //
      // Inside the job's OWN tenant context: the callback will almost
      // certainly query the host's tables, and this loop has no context of its
      // own (it reads unscoped on purpose). Without this the host's very first
      // BaseModel query would answer `where 1 = 0` and find nothing.
      // AND TELL WHOEVER IS WAITING ON THIS RUN.
      //
      // Distinct from onTimeout above, which is the HOST's hook. This is the
      // one caller who asked, at trigger time, to be told how this particular
      // occurrence ended — a parked workflow step, most likely.
      //
      // THIS PATH IS THE WHOLE REASON callbackUrl is a column rather than
      // something the worker holds in memory: the worker that was going to
      // send this is dead. If only the success and failure paths reported,
      // a SIGKILL would leave the step waiting forever with nothing anywhere
      // saying why — which is the failure mode the timedOut status exists to
      // make visible in the first place.
      //
      // Reading the row back rather than using `occ`: the patch above set
      // status, endedAt, durationMs and error, and `occ` still holds the
      // pre-patch values.
      if (occ.callbackUrl) {
        try {
          var finished = await models.JobOccurrence.unscopedQuery().findById(occ.id);
          await notifyCallback(finished, log);
        } catch (cbErr) {
          log.error('Could not deliver the timeout callback for occurrence ' + occ.id + ':', cbErr);
        }
      }

      if (typeof config.onTimeout === 'function') {
        try {
          await runWithMt(mtOf(occ), function() {
            return config.onTimeout({
              job: job,
              occurrence: occ,
              toleranceMinutes: tolerance,
              ranForMinutes: minutes
            });
          });
        } catch (hookErr) {
          log.error('onTimeout hook threw for occurrence ' + occ.id + ':', hookErr);
        }
      }
    } catch (err) {
      log.error('Failed to reap occurrence ' + occ.id + ':', err);
    }
  }
}

var _signalHandlers = null;

function registerShutdownHandlers(models, log) {
  if (_signalHandlers) return;
  var shuttingDown = false;

  var handler = function(signal) {
    return async function() {
      if (shuttingDown) return;      // a second Ctrl-C must not re-enter
      shuttingDown = true;
      log.info('xeplr-jobs: ' + signal + ' received — no new work will be picked.');
      if (_timer) { clearInterval(_timer); _timer = null; }
      try { await shutdownInFlight(models); }
      catch (err) { log.error('xeplr-jobs: shutdown failed:', err); }

      // NOT process.exit() — this package is usually EMBEDDED, and exiting
      // here would take the host down before it had closed its own server,
      // finished its own writes, or run its own handlers. Stopping cleanly is
      // this package's business; when the process ends is the host's.
      //
      // BUT: attaching a listener to SIGTERM/SIGINT REPLACES Node's default,
      // which is to terminate. So "leave exiting to the host" silently became
      // "nothing exits" in every host that has no handler of its own — the
      // API ignored SIGTERM completely, Ctrl-C did nothing, and stopping it
      // needed kill -9. In production that turns every deploy into a hard
      // kill after the orchestrator's grace period, which loses exactly the
      // in-flight bookkeeping the handler above exists to do.
      //
      // So: if the host DOES have its own handler, stay out of the way and
      // let it decide. If this package is the only listener, restore the
      // default and re-send the signal — the process then dies the way it
      // would have if we had never been here, only after our cleanup.
      if (process.listenerCount(signal) <= 1) {
        process.removeListener(signal, _signalHandlers[signal]);
        process.kill(process.pid, signal);
      }
    };
  };

  _signalHandlers = { SIGTERM: handler('SIGTERM'), SIGINT: handler('SIGINT') };
  process.on('SIGTERM', _signalHandlers.SIGTERM);
  process.on('SIGINT', _signalHandlers.SIGINT);
}

function stopScheduler() {
  if (_signalHandlers) {
    process.removeListener('SIGTERM', _signalHandlers.SIGTERM);
    process.removeListener('SIGINT', _signalHandlers.SIGINT);
    _signalHandlers = null;
  }
  if (_timer) { clearInterval(_timer); _timer = null; }
}

// PREFER @xeplr/logs OVER console, because the difference is not cosmetic.
//
// console.error writes a line and stops. @xeplr/logs calls its host's
// `onError` sink for anything at error level or above, and that sink is what
// turns a failure into a ROW on the universal error screen — something you can
// list newest-first, count, and mark as dealt with. A job that times out, is
// interrupted or fails is exactly what that screen exists to show, so falling
// back to console means the one destination that matters never hears about it.
//
// Resolved lazily and optionally: @xeplr/logs is not a dependency of this
// package (it stays dependency-light), so an install without it still works —
// it just falls back to console, as before.
function normalizeLogger(logger) {
  if (logger && typeof logger.error === 'function') return logger;
  try {
    return require('@xeplr/logs').createLogger('jobs');
  } catch (e) {
    return {
      info:      function() { console.log.apply(console, arguments); },
      // 'important' is a real level in @xeplr/logs (3) and sits BELOW the
      // error sink's threshold — which is the whole point of using it for
      // warnings. The console fallback has no such notion, so it maps to
      // console.log rather than console.error.
      important: function() { console.log.apply(console, arguments); },
      error:     function() { console.error.apply(console, arguments); },
      critical:  function() { console.error.apply(console, arguments); }
    };
  }
}

module.exports = { startScheduler, stopScheduler };
