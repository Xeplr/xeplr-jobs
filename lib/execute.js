var { generateId } = require('@xeplr/utils/lib/helpers');
var { runAction } = require('@xeplr/actions');
var { computeNextRun } = require('./cron');

// In-memory runtime state for this worker process.
var _state = { concurrent: 0, maxConcurrent: 20, logger: null };

function initExecutorState(opts) {
  _state.maxConcurrent = (opts && opts.maxConcurrent) || 20;
  _state.logger = normalizeLogger(opts && opts.logger);
}

function currentConcurrency() { return _state.concurrent; }
function maxConcurrency() { return _state.maxConcurrent; }

/**
 * Execute a single occurrence of a Job. Fire-and-forget from the caller.
 * Never throws — all failures are recorded on the occurrence row.
 *
 * triggerCtx: { type: 'cron' | 'manual' }
 */
async function executeJob(models, job, triggerCtx) {
  var log = _state.logger;
  var Job = models.Job;
  var JobOccurrence = models.JobOccurrence;
  triggerCtx = triggerCtx || { type: 'manual' };

  // 1. Acquire the per-job lock atomically.
  var locked = await Job.query()
    .patch({ running: true })
    .where({ id: job.id, running: false });
  if (locked === 0) {
    if (triggerCtx.type !== 'cron') {
      await recordSkipped(JobOccurrence, job.id, triggerCtx, 'target busy');
    }
    return null;
  }

  _state.concurrent++;
  var occurrenceId = generateId();
  var startedAt = new Date().toISOString();
  var inserted = false;

  try {
    // 2. Insert the running occurrence — visible in the UI while it runs.
    await JobOccurrence.query().insert({
      id: occurrenceId,
      jobId: job.id,
      status: 'running',
      startedAt: startedAt,
      retryCount: 0,
      triggeredBy: { type: triggerCtx.type },
      input: job.inputs || {}
    });
    inserted = true;

    // 3. Hand off to @xeplr/actions.
    var result = await runAction({
      name: job.actionName,
      input: job.inputs || {},
      system: {
        jobId: job.id,
        occurrenceId: occurrenceId,
        startedAt: startedAt,
        triggeredBy: { type: triggerCtx.type }
      }
    });

    // 4. Persist the outcome.
    var endedAt = new Date().toISOString();
    var patch = {
      status: result.status,
      endedAt: endedAt,
      durationMs: result.durationMs
    };
    if (result.status === 'success') patch.output = result.output;
    else patch.error = result.error;
    await JobOccurrence.query().patch(patch).where({ id: occurrenceId });

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
      triggeredBy: { type: triggerCtx.type }
    };
    if (inserted) {
      await JobOccurrence.query().patch({ status: 'failed', endedAt: errEndedAt, error: errPayload })
        .where({ id: occurrenceId });
    } else {
      await JobOccurrence.query().insert(errRow);
    }
    log.error('Job ' + job.id + ' occurrence ' + occurrenceId + ' failed: ' + err.message);
    return { occurrenceId: occurrenceId, status: 'failed' };

  } finally {
    // Release the lock and bump nextRunAt for scheduled jobs.
    var releasePatch = { running: false };
    if (job.schedule) {
      try { releasePatch.nextRunAt = computeNextRun(job.schedule).toISOString(); }
      catch (e) { log.error('Invalid cron on job ' + job.id + ': ' + job.schedule); }
    }
    try { await Job.query().patch(releasePatch).where({ id: job.id }); }
    catch (e) { log.error('Failed to release lock on job ' + job.id + ':', e); }
    _state.concurrent--;
  }
}

async function recordSkipped(JobOccurrence, jobId, triggerCtx, reason) {
  var now = new Date().toISOString();
  await JobOccurrence.query().insert({
    id: generateId(),
    jobId: jobId,
    status: 'skipped',
    startedAt: now,
    endedAt: now,
    error: { message: reason },
    retryCount: 0,
    triggeredBy: { type: triggerCtx.type }
  });
}

function normalizeLogger(logger) {
  if (logger && typeof logger.error === 'function') return logger;
  return {
    info:  function() { console.log.apply(console, arguments); },
    error: function() { console.error.apply(console, arguments); }
  };
}

module.exports = { executeJob, initExecutorState, currentConcurrency, maxConcurrency };
