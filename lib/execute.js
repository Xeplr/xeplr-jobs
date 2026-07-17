var { generateId } = require('@xeplr/utils/lib/helpers');
var { ExecutorNotRegisteredError } = require('./errors');
var { getExecutor } = require('./registry');
var { applySchema } = require('./validate');
var { updateSchema, schemasEqual } = require('./outputSchema');
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
 * triggerCtx:
 *   { type: 'cron' | 'reactive' | 'manual',
 *     sourceJobId?, sourceOccurrenceId?, groupingTag?, params? }
 */
async function executeJob(models, job, triggerCtx) {
  var log = _state.logger;
  var Job = models.Job;
  var JobOccurrence = models.JobOccurrence;

  var groupingTag = (triggerCtx && triggerCtx.groupingTag) || generateId();

  // 1. Acquire the per-job lock atomically. If someone else holds it,
  //    we're either racing the scheduler or the target is busy (reactive).
  var lockedRows = await Job.query()
    .patch({ running: true })
    .where({ id: job.id, running: false });
  if (lockedRows === 0) {
    if (triggerCtx && triggerCtx.type !== 'cron') {
      // Record 'skipped' for reactive + manual so the caller has a receipt.
      // Cron picker already filters running=false, so cron never lands here.
      await recordSkipped(JobOccurrence, job.id, triggerCtx, groupingTag, 'target busy');
    }
    return null;
  }

  _state.concurrent++;
  var occurrenceId = generateId();
  var startedAt = new Date().toISOString();
  var occurrenceInserted = false;

  try {
    // 2. Resolve + validate params (reactive jobs only).
    var params = null;
    if (job.paramSchema) {
      params = applySchema(job.paramSchema, (triggerCtx && triggerCtx.params) || {}, 'params');
    }

    // 3. Look up executor.
    var typeName = job.jobType && job.jobType.name;
    var executor = typeName && getExecutor(typeName);
    if (!executor) throw new ExecutorNotRegisteredError(typeName || '<unknown>');

    // 4. Insert the occurrence row (status=running) so it's visible while it runs.
    await JobOccurrence.query().insert({
      id: occurrenceId,
      jobId: job.id,
      status: 'running',
      startedAt: startedAt,
      retryCount: 0,
      triggeredBy: buildTriggeredBy(triggerCtx),
      groupingTag: groupingTag
    });
    occurrenceInserted = true;

    // 5. Build system context and invoke the executor.
    var system = {
      jobId: job.id,
      occurrenceId: occurrenceId,
      groupingTag: groupingTag,
      startedAt: startedAt,
      triggeredBy: buildTriggeredBy(triggerCtx)
    };
    var result = await executor({
      config: job.jobInputs || {},
      params: params,
      system: system
    });
    var context = (result && result.context) || {};
    var data    = (result && result.data)    || {};
    var endedAt = new Date().toISOString();

    // 6. Update occurrence with the success payload.
    var systemOutput = Object.assign({}, system, { endedAt: endedAt, status: 'success' });
    await JobOccurrence.query()
      .patch({
        status: 'success',
        endedAt: endedAt,
        systemOutput: systemOutput,
        contextOutput: context,
        dataOutput: data
      })
      .where({ id: occurrenceId });

    // 7. Learn/dynamic — fold newly seen fields into the Job's output schema.
    if (job.outputSchemaMode && job.outputSchemaMode !== 'manual') {
      var nextSchema = updateSchema(job.outputSchema, { context: context, data: data }, job.outputSchemaMode);
      if (!schemasEqual(nextSchema, job.outputSchema)) {
        await Job.query().patch({ outputSchema: nextSchema }).where({ id: job.id });
      }
    }

    // 8. Fire reactive downstream. Lazy-require to break the execute↔reactive cycle.
    var fireReactive = require('./reactive').fireReactive;
    fireReactive(models, job.id, occurrenceId, { context: context, data: data }, groupingTag)
      .catch(function(err) { log.error('fireReactive failed for job ' + job.id + ':', err); });

    return { occurrenceId: occurrenceId, status: 'success' };

  } catch (err) {
    var errEndedAt = new Date().toISOString();
    var errPayload = { name: err.name || 'Error', message: err.message };
    if (err.stack) errPayload.stack = err.stack;
    if (err.details) errPayload.details = err.details;

    if (occurrenceInserted) {
      await JobOccurrence.query()
        .patch({ status: 'failed', endedAt: errEndedAt, error: errPayload })
        .where({ id: occurrenceId });
    } else {
      // Failed before we could insert the running row — insert a failed row directly.
      await JobOccurrence.query().insert({
        id: occurrenceId,
        jobId: job.id,
        status: 'failed',
        startedAt: startedAt,
        endedAt: errEndedAt,
        error: errPayload,
        retryCount: 0,
        triggeredBy: buildTriggeredBy(triggerCtx),
        groupingTag: groupingTag
      });
    }
    log.error('Job ' + job.id + ' occurrence ' + occurrenceId + ' failed: ' + err.message);
    return { occurrenceId: occurrenceId, status: 'failed' };

  } finally {
    // Release the lock and bump next_run_at for scheduled jobs.
    var patch = { running: false };
    if (job.schedule) {
      try { patch.nextRunAt = computeNextRun(job.schedule).toISOString(); }
      catch (e) { log.error('Invalid cron on job ' + job.id + ': ' + job.schedule); }
    }
    try { await Job.query().patch(patch).where({ id: job.id }); }
    catch (e) { log.error('Failed to release lock on job ' + job.id + ':', e); }
    _state.concurrent--;
  }
}

async function recordSkipped(JobOccurrence, jobId, triggerCtx, groupingTag, reason) {
  var now = new Date().toISOString();
  await JobOccurrence.query().insert({
    id: generateId(),
    jobId: jobId,
    status: 'skipped',
    startedAt: now,
    endedAt: now,
    error: { message: reason },
    retryCount: 0,
    triggeredBy: buildTriggeredBy(triggerCtx),
    groupingTag: groupingTag
  });
}

function buildTriggeredBy(ctx) {
  var t = { type: (ctx && ctx.type) || 'manual' };
  if (ctx && ctx.sourceJobId) t.sourceJobId = ctx.sourceJobId;
  if (ctx && ctx.sourceOccurrenceId) t.sourceOccurrenceId = ctx.sourceOccurrenceId;
  return t;
}

function normalizeLogger(logger) {
  if (logger && typeof logger.error === 'function') return logger;
  return {
    info:  function() { console.log.apply(console, arguments); },
    error: function() { console.error.apply(console, arguments); }
  };
}

module.exports = { executeJob, initExecutorState, currentConcurrency, maxConcurrency };
