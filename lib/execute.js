var { generateId } = require('@xeplr/utils/lib/helpers');
var { runAction } = require('@xeplr/actions');
var { runWithMt } = require('@xeplr/db');
var { computeNextRun } = require('./cron');
var { notifyCallback } = require('./notify');

/**
 * The tenant a job belongs to, as a context object.
 *
 * Copied off the row rather than derived, and all four levels regardless of
 * how many the app registered — a level the app does not enforce is simply
 * never read, and hardcoding a count here would break every consumer who
 * chose a different one.
 */
function mtOf(job) {
  var ctx = {};
  for (var n = 1; n <= 4; n++) {
    var key = 'mtId' + n;
    if (job && job[key]) ctx[key] = job[key];
  }
  return ctx;
}

// In-memory runtime state for this worker process.
// WHAT THIS PROCESS IS RUNNING RIGHT NOW.
//
// A count was enough for the concurrency cap, but not for shutdown: to close
// out in-flight work on the way down we have to know WHICH occurrences are
// ours. Nothing else can work it out — an occurrence row says 'running' but
// not which process is running it, and in a multi-instance deployment the
// others' rows look identical.
var _state = {
  concurrent: 0,
  maxConcurrent: 20,
  // A WORKING LOGGER BEFORE ANYBODY CONFIGURES ONE.
  //
  // This was null until initExecutorState ran, and initExecutorState only ran
  // from startScheduler — so with JOBS_SCHEDULER=false (the documented way to
  // serve the UI from one process and run jobs from another) a manually
  // triggered job reached `log.error(...)` on a null and threw a TypeError
  // INSIDE the catch block whose job was to record the failure. The occurrence
  // would have been left saying 'running' forever, by the error handler.
  logger: normalizeLogger(null),
  inFlight: new Map(),
  // Host-supplied: (connectionInfoId) → credentials. See resolveInputs.
  resolveConnection: null
};

function initExecutorState(opts) {
  _state.maxConcurrent = (opts && opts.maxConcurrent) || 20;
  _state.logger = normalizeLogger(opts && opts.logger);
  if (opts && opts.resolveConnection !== undefined) {
    _state.resolveConnection = opts.resolveConnection;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// CONNECTION IDS BECOME CONNECTIONS HERE, AND NOWHERE ELSE
//
// An action like db-fetch takes `connection: { host, port, user, password,
// database }`. A job cannot store that, and a person cannot type it:
//
//   - The browser must never see it. ConnectionInfo seals credentials with
//     ENCRYPTION_KEY and decrypts "only at point-of-use, never in responses",
//     so /connectioninfo hands back labels and ids and nothing else.
//   - job.inputs must never hold it. That column is snapshotted into
//     jobOccurrences.input on EVERY run for auditability, so one password in
//     a job row becomes one password in a hundred occurrence rows.
//
// So the job stores `connectionInfoId` — an id, safe everywhere — and the id
// is exchanged for real credentials HERE, on the server, moments before the
// action is called, and only in the object handed to that call.
//
// ONE HOOK, not one per action. The host says once how an id becomes a
// connection; every action taking a connection benefits, including ones
// written later that this file has never heard of.
//
// The convention is the field NAME:
//
//   connectionInfoId        → connection
//   sourceConnectionInfoId  → sourceConnection
//   targetConnectionInfoId  → targetConnection
//
// so an action with two connections needs no configuration to get both.
// ─────────────────────────────────────────────────────────────────────────

var CONNECTION_ID_SUFFIX = /ConnectionInfoId$/;

function connectionFieldFor(key) {
  if (key === 'connectionInfoId') return 'connection';
  if (!CONNECTION_ID_SUFFIX.test(key)) return null;
  // sourceConnectionInfoId → sourceConnection
  return key.slice(0, -'ConnectionInfoId'.length) + 'Connection';
}

/**
 * Swap every *ConnectionInfoId in `inputs` for the credentials it names.
 *
 * Returns a NEW object — the caller's `job.inputs` is left untouched, which is
 * what keeps the occurrence snapshot free of secrets.
 *
 * A MISSING RESOLUTION IS FATAL, deliberately. If a job says "use connection
 * X" and X has been deleted, belongs to another tenant, or cannot be decrypted
 * because the key was rotated, the only safe answer is to stop. Falling back
 * to whatever literal `connection` happens to sit in inputs would connect to
 * something the author did not ask for — and it would work, and nobody would
 * find out. A literal connection is honoured only when no id was given at all.
 *
 * Runs inside the job's tenant context (see executeJob's runWithMt), because
 * ConnectionInfo is a BaseModel: resolving from a scheduler tick with no
 * context produces `where 1 = 0` and finds nothing, which is how a background
 * loop elsewhere in this codebase silently never claimed any work.
 */
async function resolveInputs(inputs) {
  var raw = inputs || {};
  var ids = Object.keys(raw).filter(function(k) { return connectionFieldFor(k) && raw[k]; });
  if (!ids.length) return raw;

  if (typeof _state.resolveConnection !== 'function') {
    throw new Error('This job names a saved connection (' + ids.join(', ') +
      '), but no connection resolver is configured. Pass resolveConnection to ' +
      'jobs.init() — see @xeplr/jobs README.');
  }

  var out = Object.assign({}, raw);
  for (var i = 0; i < ids.length; i++) {
    var key = ids[i];
    var target = connectionFieldFor(key);

    // THE WHOLE INPUTS OBJECT goes to the resolver, not just the one id.
    //
    // A saved connection is not always one id. BI's own resolveDbConnection
    // takes (connectionId, dbInfoId) — the server, and then WHICH DATABASE on
    // it — and a host with a different model will have its own companions. So
    // the hook is handed everything and picks what it needs, rather than this
    // file inventing a naming rule for every id a host might pair up.
    var resolved = await _state.resolveConnection(raw[key], { field: key, inputs: raw });
    if (!resolved) {
      throw new Error('Connection "' + raw[key] + '" (' + key + ') could not be resolved — ' +
        'it may have been deleted, or belong to another company. Refusing to run ' +
        'rather than fall back to a different connection.');
    }

    // Two accepted shapes. A bare login object, or { dbType, connection } —
    // which is what BI returns, and it matters: the connection ALREADY KNOWS
    // whether it is postgres, mysql or mssql, so making somebody choose that
    // separately is asking a question whose answer is already on file and
    // whose wrong answer routes to the wrong driver.
    if (resolved.connection) {
      out[target] = resolved.connection;
      var typeField = target === 'connection' ? 'dbType' : target + 'DbType';
      if (resolved.dbType) out[typeField] = resolved.dbType;
    } else {
      out[target] = resolved;
    }

    // The id goes no further. The action was never given one to interpret.
    delete out[key];
  }
  return out;
}


// ─────────────────────────────────────────────────────────────────────────
// LIVE PROGRESS, WITHOUT ONE UPDATE PER BATCH
//
// The uploader calls onProgress every batch — 8000 times for a 40M-row move
// at the default batch size. Writing each one would cost more than the
// movement it is reporting on, and nobody can read 8000 updates anyway.
//
// So: COALESCE, don't queue. Every call overwrites the pending numbers, and a
// write goes out at most once every PROGRESS_MIN_MS. Intermediate values are
// dropped on purpose — progress is a gauge, not a log, and the only value
// worth writing is the newest one.
//
// No timer, deliberately. The next batch is what triggers the next write, so
// there is nothing to unref and nothing left running if the process goes
// down mid-move. The consequence is that the final numbers may go unwritten
// if batches stop arriving — which does not matter, because the terminal
// patch overwrites status/output a moment later anyway.
//
// FIRE AND FORGET, and never allowed to throw. A movement must not fail
// because a progress update did — the whole point of this column is that it
// is disposable. `inFlight` also keeps a slow write from stacking up behind
// itself when the database is the thing that is busy.
//
// Guarded on `status = 'running'`: an occurrence the reaper has already given
// up on must not gain fresh progress, or a timedOut row starts looking alive.
// ─────────────────────────────────────────────────────────────────────────

var PROGRESS_MIN_MS = 2000;

function makeProgressReporter(JobOccurrence, occurrenceId) {
  var lastWriteAt = 0;
  var inFlight = false;

  return function onProgress(p) {
    if (!p || inFlight) return;
    var now = Date.now();
    if (now - lastWriteAt < PROGRESS_MIN_MS) return;
    lastWriteAt = now;
    inFlight = true;

    JobOccurrence.query()
      .patch({
        progress: {
          rowsRead: p.rowsRead != null ? p.rowsRead : null,
          batches:  p.batches  != null ? p.batches  : null,
          // So a reader can tell "still going" from "stopped reporting nine
          // minutes ago", which is the difference between a slow job and a
          // dead one and is not visible from the numbers alone.
          at: new Date(now).toISOString()
        }
      })
      .where({ id: occurrenceId, status: 'running' })
      .then(function() { inFlight = false; })
      .catch(function() { inFlight = false; });
  };
}

function currentConcurrency() { return _state.concurrent; }
function maxConcurrency() { return _state.maxConcurrent; }

/**
 * Execute a single occurrence of a Job. Fire-and-forget from the caller.
 * Never throws — all failures are recorded on the occurrence row.
 *
 * triggerCtx: { type: 'cron' | 'manual' }
 *
 * INSIDE THE JOB'S OWN TENANT CONTEXT, always — whether it arrived from a
 * scheduler tick (no context at all) or from an HTTP trigger (the caller's
 * context, which is the same one, because the router found the job through a
 * tenant-filtered query to begin with).
 *
 * Always the JOB's rather than the caller's, so there is one rule instead of
 * two. It is what every write below depends on: the occurrence rows pick their
 * mtIds up from $beforeInsert without being told, and — the part that matters
 * more — the ACTION runs inside it too, so anything it reads or writes through
 * a BaseModel is scoped to the tenant whose job it is. Without this an action
 * on a cron would run with no context and see nothing, or worse, run with
 * whichever context happened to be on the stack.
 */
function executeJob(models, job, triggerCtx, opts) {
  return runWithMt(mtOf(job), function() {
    return executeJobScoped(models, job, triggerCtx, opts || {});
  });
}

// ─────────────────────────────────────────────────────────────────────────
// INPUTS THIS ONE RUN USES: the job's own, with the caller's on top.
//
// SHALLOW, one level, and that is the decision rather than an omission. A
// caller sending `{ window: { from: '2026-08-01' } }` means THIS window, not
// last run's window with one field edited — and half-merging a `window`, a
// `columns` mapping or a connection object produces a shape nobody authored
// and nobody can read back off the occurrence row. Replacing per top-level
// key is also why there is no second "replace" flag: sending a key already
// replaces it outright, and sending none leaves the job exactly as saved.
//
// Undefined values are dropped, so `{ table: undefined }` cannot blank a
// field the job depends on by accident. Null is NOT dropped — clearing a key
// is a thing a caller may legitimately mean, and it is visible in the
// occurrence's `input` snapshot when they did.
// ─────────────────────────────────────────────────────────────────────────
function mergeInputs(jobInputs, overrides) {
  var base = jobInputs || {};
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return base;
  var out = Object.assign({}, base);
  Object.keys(overrides).forEach(function(k) {
    if (overrides[k] !== undefined) out[k] = overrides[k];
  });
  return out;
}

/**
 * The period THIS run covers, or null if the job is not incremental.
 *
 *   from = coveredTo   where the last successful run stopped. Null on a job
 *                      that has never run — an unbounded lower edge, which is
 *                      what a first incremental load means.
 *   to   = now         pinned once, here, and reused everywhere afterwards.
 *
 * `to` is passed down rather than each consumer asking for the time itself,
 * and that is the point of computing it in one place: a chain where every
 * step reads its own clock has each step covering a slightly wider period
 * than the one that fed it, so a deletion or an aggregation keyed to "the
 * period" no longer describes the same rows the movement brought in.
 *
 * The job's own `window` is kept and only its edges are filled — `column`,
 * `fromParam`, `columns` and anything else the author configured survive.
 */
function buildWindow(job, nowIso) {
  var mode = job && job.incrementalMode;
  if (!mode) return null;

  if (mode === 'watermark') {
    // Refused, not ignored. See migrations/0006: resolving a watermark means
    // a SELECT max against the target, which this layer cannot do and the
    // action has not been taught yet. Running it as a plain period instead
    // would move rows the job was configured NOT to move, and running it with
    // no window would move everything.
    throw new Error('Job ' + job.id + ' is set to incrementalMode "watermark", which is not ' +
      'implemented yet — the action has to resolve max(column) against its own target. ' +
      'Use "period", or clear the mode to run the job on its own inputs.');
  }
  if (mode !== 'period') {
    throw new Error('Job ' + job.id + ' has an unknown incrementalMode "' + mode + '" ' +
      '(expected "period", "watermark", or empty).');
  }

  var authored = (job.inputs && job.inputs.window) || {};
  return Object.assign({}, authored, {
    // NO +1 SECOND. The window is half-open (from <= x < to), so starting at
    // exactly the previous `to` is exact coverage; adding a second opens a
    // hole nothing ever fills. See migrations/0006.
    from: job.coveredTo || null,
    to: nowIso
  });
}

// opts:
//   inputs        per-trigger overrides — see mergeInputs
//   callbackUrl   where to POST this occurrence's outcome when it reaches a
//                 terminal state — see notifyCallback
//   occurrenceId  chosen by the CALLER so it can be returned from an HTTP
//                 trigger before the work starts. A caller that hands one in
//                 has a handle to poll from the moment it gets its response,
//                 rather than having to search the history for a row that may
//                 not exist yet.
async function executeJobScoped(models, job, triggerCtx, opts) {
  opts = opts || {};
  var overrides = opts.inputs || null;
  var log = _state.logger;
  var Job = models.Job;
  var JobOccurrence = models.JobOccurrence;
  triggerCtx = triggerCtx || { type: 'manual' };

  var occurrenceId = opts.occurrenceId || generateId();

  // 1. Acquire the per-job lock atomically.
  var locked = await Job.query()
    .patch({ running: true })
    .where({ id: job.id, running: false });
  if (locked === 0) {
    if (triggerCtx.type !== 'cron') {
      // The SAME id the caller was handed, so the row it was told to watch is
      // the row that exists. Previously this minted a fresh one, which left an
      // HTTP caller holding an id that would never appear.
      var skipped = await recordSkipped(JobOccurrence, job.id, triggerCtx, 'target busy',
        occurrenceId, opts.callbackUrl);
      // A REFUSAL IS AN OUTCOME, and it has to be reported like any other. A
      // workflow step that started this job is parked waiting; told nothing,
      // it waits forever on a run that never began.
      await notifyCallback(skipped, log);
    }
    return { occurrenceId: occurrenceId, status: 'skipped' };
  }

  _state.concurrent++;
  var startedAt = new Date().toISOString();
  var inserted = false;
  // AFTER the lock, before the occurrence row — the row records this set.
  //
  // THREE LAYERS, in this order, each beating the one before it:
  //
  //   job.inputs        what was saved on the job
  //   + the period      this run's window, when the job is incremental
  //   + overrides       what this particular trigger asked for
  //
  // The trigger wins last, deliberately: that is what makes a backfill
  // possible. "Run this movement for last March" is a triggered run with an
  // explicit window, and it must beat the computed one rather than being
  // quietly widened to now.
  var inputs = null;
  var advances = false;

  // WHETHER THIS RUN IS ALLOWED TO MOVE coveredTo FORWARD.
  //
  // Only when it used the window this layer computed. A trigger that supplied
  // its own window is a backfill or a replay of a window that failed, and its
  // `to` is usually in the PAST — advancing to it would drag the watermark
  // backwards and re-move everything since, and refusing to advance at all is
  // the only reading of "run this for last March" that does not also mean
  // "and forget everything you have done since".
  var advances = Boolean(periodWindow) && !(overrides && overrides.window !== undefined);

  try {
    // INSIDE the try, so a misconfigured incrementalMode is recorded as a
    // failed occurrence and releases the lock through the same catch/finally
    // as any other failure — rather than throwing past them and stranding
    // `running = true` forever, which is the hole migrations/0004 exists to
    // close.
    var periodWindow = buildWindow(job, startedAt);
    var base = periodWindow
      ? Object.assign({}, job.inputs || {}, { window: periodWindow })
      : job.inputs;
    inputs = mergeInputs(base, overrides);

    // WHETHER THIS RUN MAY MOVE coveredTo FORWARD. Only when it used the
    // window this layer computed. A trigger that supplied its own window is a
    // backfill or a replay, and its `to` is usually in the PAST — advancing to
    // it would drag the watermark backwards and re-move everything since.
    // "Run this for last March" cannot also mean "and forget everything you
    // have done since".
    advances = Boolean(periodWindow) && !(overrides && overrides.window !== undefined);

    // 2. Insert the running occurrence — visible in the UI while it runs.
    await JobOccurrence.query().insert({
      id: occurrenceId,
      jobId: job.id,
      status: 'running',
      startedAt: startedAt,
      retryCount: 0,
      triggeredBy: { type: triggerCtx.type },
      // ON THE ROW, so the REAPER can find it. A worker that is SIGKILLed
      // never reports; a different process marks this timedOut and has to be
      // able to tell whoever is waiting. A callback held only in this
      // worker's memory dies with the worker — which is exactly the case it
      // exists to cover. See migrations/0008.
      callbackUrl: opts.callbackUrl || null,
      // THE MERGED SET, not job.inputs — this column is the record of what
      // this occurrence actually ran with, and a triggered run that used a
      // caller's window would otherwise be indistinguishable from a scheduled
      // one that used the job's. Still UNRESOLVED: see resolveInputs below.
      input: inputs
    });
    inserted = true;
    // Registered only AFTER the row exists — there is nothing to close out
    // before that, and a shutdown in between would find an id with no row.
    _state.inFlight.set(occurrenceId, { jobId: job.id, startedAt: startedAt });

    // 3. Hand off to @xeplr/actions — retrying a FAILURE up to retryLimit.
    //
    // ONE OCCURRENCE ROW, however many attempts. A retry is not a second run
    // of the job: it is the same due slot being attempted again, and giving it
    // its own row would double-count every flaky job in the history and make
    // "how often does this fail" unanswerable. retryCount says how many times
    // it was tried; the final status says how it ended up.
    //
    // Default 0 — an action that failed once will usually fail again, and
    // silently re-running something that MOVES DATA is worse than leaving it
    // failed and visible. A job opts in.
    //
    // Only a returned failure is retried, not a throw: a throw here is the
    // framework breaking (a DB insert, a missing action), which retrying
    // cannot fix and would only multiply.
    var retryLimit = Math.max(0, Number(job.retryLimit) || 0);
    var attempt = 0;
    var result;

    // AFTER the occurrence row exists, and its `input` column already holds
    // the UNRESOLVED inputs. That ordering is the whole safeguard: the
    // snapshot keeps the id, the action gets the credentials, and the two
    // never meet. Resolving before the insert would write the password into
    // every occurrence row this job ever produces.
    var resolvedInputs = await resolveInputs(inputs);
    var call = buildActionCall(job, occurrenceId, startedAt, triggerCtx, resolvedInputs,
      makeProgressReporter(JobOccurrence, occurrenceId));

    while (true) {
      result = await runAction(call);
      if (result.status === 'success' || attempt >= retryLimit) break;

      attempt++;
      // A failed ATTEMPT is not a failed job — there are more to come, and
      // the run may still succeed. Only the final outcome is an error.
      log.important('Job ' + job.id + ' attempt ' + attempt + ' of ' + (retryLimit + 1) +
        ' failed: ' + ((result.error && result.error.message) || 'unknown') + ' — retrying.');
      // Recorded as it happens, so a run that is still retrying says so rather
      // than looking like one long first attempt.
      await JobOccurrence.query().patch({ retryCount: attempt })
        .where({ id: occurrenceId })
        .catch(function() {});
    }

    // 4. Persist the outcome. retryCount is already current — it was written
    // as each retry happened, not reconstructed here.
    var endedAt = new Date().toISOString();
    var patch = {
      status: result.status,
      endedAt: endedAt,
      durationMs: result.durationMs,
      retryCount: attempt
    };
    if (result.status === 'success') patch.output = result.output;
    else patch.error = result.error;

    // CONDITIONAL ON STILL BEING 'running' — and what happens when it is not
    // is the whole point.
    //
    // If the reaper gave up on this occurrence while the work was still going,
    // the row now says 'timedOut'. Writing 'success' over it unconditionally
    // (which is what this used to do) would erase the ONE piece of evidence
    // that the tolerance is set too low: the run would end up looking like
    // every other successful run, and the only symptom left would be the
    // occasional duplicate execution nobody could explain.
    //
    // So a late finish does not overwrite the verdict — it ANNOTATES it. The
    // occurrence stays timedOut, and gains the fact that the worker did come
    // back, and how long it actually needed. That is the signal to raise
    // "give up after", and it is now a thing you can see and query for.
    var updated = await JobOccurrence.query().patch(patch)
      .where({ id: occurrenceId, status: 'running' });

    // COVERAGE ADVANCES HERE, AND ONLY HERE.
    //
    // Conditional on `updated` as well as on success, and that matters: if the
    // reaper already declared this occurrence timedOut, its lock was handed
    // back and something else may have run in the meantime. Moving the
    // watermark on the strength of a run that was written off would skip
    // whatever that other run did not cover.
    //
    // A FAILURE LEAVES IT WHERE IT WAS — that is the whole design. The 10:00
    // run fails, nextRunAt still goes to 11:00, coveredTo stays at 09:00, and
    // the 11:00 run covers 09:00 -> 11:00 by itself. Nothing is lost and
    // nobody reschedules anything.
    if (advances && updated && result.status === 'success') {
      await Job.query().patch({ coveredTo: inputs.window.to })
        .where({ id: job.id })
        .catch(function(e) {
          // Loud, because the consequence is silent: the next run recomputes
          // `from` off a stale coveredTo and moves the same window again.
          // Duplicates under append, invisible under upsert.
          log.error('Job ' + job.id + ' ran successfully but its coveredTo could not be ' +
            'advanced to ' + inputs.window.to + ' — the next run will repeat this window: ' + e.message);
        });
    }

    if (!updated) {
      var reallyTook = Math.round((result.durationMs || 0) / 60000);
      // NOT error level. Nothing is broken: the work completed, and what this
      // says is that a setting is too tight. The error screen is for things
      // that need fixing now, and a warning that lands there is noise that
      // makes the real failures harder to see.
      log.important('Job ' + job.id + ' occurrence ' + occurrenceId + ' finished (' +
        result.status + ') AFTER it had already been timed out — it ran for ' +
        reallyTook + ' minutes. Raise this job\'s "give up after" above that.');

      await JobOccurrence.query()
        .patch({
          // Deliberately NOT the real status. The run was already declared
          // dead and its lock handed back, so something else may have started
          // in the meantime; calling this a clean success would be a claim
          // nothing checked.
          lateFinish: {
            status: result.status,
            durationMs: result.durationMs,
            ranForMinutes: reallyTook,
            finishedAt: endedAt,
            note: 'Completed after being timed out — the tolerance is lower than this job needs.'
          }
        })
        .where({ id: occurrenceId })
        .catch(function() {});
    }

    // 5. Tell whoever is waiting. AFTER the row is written, never before —
    // the receiver's first move is usually to read the occurrence back, and a
    // callback that outruns its own record shows a run that has not finished.
    //
    // NOT AWAITED INTO THE RESULT: the caller of executeJob is a scheduler
    // tick or a fire-and-forget HTTP handler, and neither should be held open
    // for a receiver's retry backoff. Awaited HERE though, inside the try, so
    // the `finally` below still releases the lock afterwards.
    if (opts.callbackUrl) {
      var finished = await JobOccurrence.query().findById(occurrenceId);
      await notifyCallback(finished, log);
    }

    return { occurrenceId: occurrenceId, status: result.status };

  } catch (err) {
    // runAction never throws, but this catches anything upstream (DB insert etc.)
    var errEndedAt = new Date().toISOString();
    var errPayload = { name: err.name || 'Error', message: err.message };
    if (err.stack) errPayload.stack = err.stack;
    var errRow = {
      id: occurrenceId,
      jobId: job.id,
      status: 'failed',
      startedAt: startedAt,
      endedAt: errEndedAt,
      error: errPayload,
      retryCount: 0,
      triggeredBy: { type: triggerCtx.type },
      callbackUrl: opts.callbackUrl || null,
      // Null when the failure was working out the inputs themselves (a bad
      // incrementalMode), which is the honest record of a run that never had
      // a set to use.
      input: inputs
    };
    if (inserted) {
      await JobOccurrence.query().patch({ status: 'failed', endedAt: errEndedAt, error: errPayload })
        .where({ id: occurrenceId });
    } else {
      await JobOccurrence.query().insert(errRow);
    }
    log.error('Job ' + job.id + ' occurrence ' + occurrenceId + ' failed: ' + err.message);

    // A FAILURE IS REPORTED EXACTLY LIKE A SUCCESS. A chain that only advances
    // when nothing goes wrong is a chain that hangs the first time something
    // does — silently, with the step still showing "waiting".
    if (opts.callbackUrl) {
      await notifyCallback({
        id: occurrenceId, jobId: job.id, status: 'failed',
        startedAt: startedAt, endedAt: errEndedAt, error: errPayload,
        callbackUrl: opts.callbackUrl
      }, log).catch(function() {});
    }

    return { occurrenceId: occurrenceId, status: 'failed' };

  } finally {
    // Release the lock, and bump nextRunAt for CRON RUNS ONLY.
    //
    // A manual trigger must not move the schedule. It used to: this ran for
    // every trigger type and recomputed from `now`, so a manual run that
    // CROSSED a slot ate it — triggered at 09:59, finished at 10:00:02,
    // nextRunAt jumped to 11:00 and the 10:00 scheduled run simply never
    // happened, with nothing recording that it had been skipped.
    //
    // The schedule is set by the schedule. Running a job by hand is a
    // statement about right now, not about when it fires next.
    var releasePatch = { running: false };
    if (job.schedule && triggerCtx.type === 'cron') {
      try { releasePatch.nextRunAt = computeNextRun(job.schedule).toISOString(); }
      catch (e) { log.error('Invalid cron on job ' + job.id + ': ' + job.schedule); }
    }
    try { await Job.query().patch(releasePatch).where({ id: job.id }); }
    catch (e) { log.error('Failed to release lock on job ' + job.id + ':', e); }
    _state.inFlight.delete(occurrenceId);
    _state.concurrent--;
  }
}

async function recordSkipped(JobOccurrence, jobId, triggerCtx, reason, occurrenceId, callbackUrl) {
  var now = new Date().toISOString();
  return JobOccurrence.query().insert({
    id: occurrenceId || generateId(),
    jobId: jobId,
    callbackUrl: callbackUrl || null,
    status: 'skipped',
    startedAt: now,
    endedAt: now,
    error: { message: reason },
    retryCount: 0,
    triggeredBy: { type: triggerCtx.type }
  });
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

// mtOf is exported for the scheduler's reaper, which has to re-establish a
// job's tenant context before handing it to a host callback — the same
// obligation executeJob discharges before running an action. One definition,
// because two would drift the moment a fifth level is added.
/**
 * Close out whatever this process is running, on the way down.
 *
 * BEST EFFORT, and that is the honest description. SIGTERM is catchable, so a
 * planned restart — a deploy, a scale-down, Ctrl-C — can say what happened
 * instead of leaving rows that look exactly like a crash. SIGKILL and an OOM
 * kill cannot be caught at all, and neither can the machine losing power. Those
 * still fall to the reaper, which is why this replaces nothing.
 *
 * Marks 'interrupted' rather than 'failed' or 'timedOut', because we know
 * precisely what happened and the other two would each be a lie: `failed` says
 * the action reported an error (it did not), `timedOut` says nobody came back
 * (somebody did — us, to say we were stopping).
 *
 * The lock is released too, so the job is runnable the moment the process
 * comes back up rather than waiting out a tolerance for a worker that
 * deliberately went away.
 */
async function shutdownInFlight(models, options) {
  options = options || {};
  var log = _state.logger || normalizeLogger(null);
  var entries = Array.from(_state.inFlight.entries());
  if (!entries.length) return { closed: 0 };

  // A deploy is a planned stop, not a fault — nothing here needs fixing, so
  // it must not reach the error screen. Logged at 'important' so it is still
  // findable when working out why a job did not finish last night.
  log.important('xeplr-jobs: shutting down with ' + entries.length + ' job(s) in flight — marking interrupted.');
  var endedAt = new Date().toISOString();
  var closed = 0;

  for (var i = 0; i < entries.length; i++) {
    var occurrenceId = entries[i][0];
    var info = entries[i][1];
    try {
      // Conditional, same as the normal finish path: if the reaper already
      // called this one timedOut, that verdict stands.
      var n = await models.JobOccurrence.unscopedQuery()
        .patch({
          status: 'interrupted',
          endedAt: endedAt,
          durationMs: Date.now() - new Date(info.startedAt).getTime(),
          error: {
            name: 'Interrupted',
            message: 'The process running this job was asked to stop (restart or deploy) before the job finished.'
          }
        })
        .where({ id: occurrenceId, status: 'running' });
      if (n) closed++;

      await models.Job.unscopedQuery().patch({ running: false }).where({ id: info.jobId });

      // The third terminal path, and it must report like the other two. A
      // deploy during a twenty-minute movement is the COMMONEST way a waiting
      // step gets stranded — far commoner than a SIGKILL — and it is the one
      // case where the process still has a moment to say so.
      //
      // Best-effort by nature: this runs inside the shutdown window, so a slow
      // receiver may not be answered before the process goes. The reaper is
      // the backstop — the occurrence is already written either way.
      if (n) {
        var stopped = await models.JobOccurrence.unscopedQuery().findById(occurrenceId);
        if (stopped && stopped.callbackUrl) await notifyCallback(stopped, log);
      }
    } catch (err) {
      log.error('xeplr-jobs: could not mark occurrence ' + occurrenceId + ' interrupted:', err);
    }
  }

  _state.inFlight.clear();
  return { closed: closed };
}

// mergeInputs is exported for its own sake: it is pure — two objects in, one
// out — so the override rule can be tested, and read, without a database.
module.exports = { executeJob, initExecutorState, currentConcurrency, maxConcurrency, mtOf, shutdownInFlight, mergeInputs };

/**
 * The call handed to @xeplr/actions, built once and reused for every attempt.
 *
 * `system` is deliberately the same on a retry as on the first try — the
 * occurrenceId in particular. An action that writes progress against it (see
 * moveRunAction) should be appending to the same run, not opening a second
 * one, because from the outside this is still one due slot being worked.
 */
function buildActionCall(job, occurrenceId, startedAt, triggerCtx, resolvedInputs, onProgress) {
  return {
    name: job.actionName,
    // RESOLVED inputs — the job's own merged with this trigger's overrides
    // (see mergeInputs), then connection ids exchanged for credentials by
    // resolveInputs. NO fallback to job.inputs: resolveInputs always returns
    // an object, and a fallback that fired would silently run the job's saved
    // window instead of the one the caller asked for — the failure mode where
    // a movement looks like it worked and moved the wrong rows.
    input: resolvedInputs || {},
    system: {
      jobId: job.id,
      occurrenceId: occurrenceId,
      startedAt: startedAt,
      triggeredBy: { type: triggerCtx.type },
      // OPTIONAL FOR THE ACTION, always present from here. db-move forwards
      // this straight to the uploader's own onProgress and every other action
      // is free to ignore it — an action that never calls it simply reports
      // nothing, exactly as before.
      //
      // Shared across retries along with the rest of `system`: a retry is the
      // same due slot being attempted again, so its progress belongs on the
      // same occurrence rather than opening a second set of numbers.
      onProgress: onProgress || null
    }
  };
}
