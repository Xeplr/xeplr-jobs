// STARTING ONE RUN OF A SAVED JOB, ON SOMEBODY ELSE'S SAY-SO.
//
// One function for both doors: POST /jobs/:id/trigger, and a host calling
// trigger() in-process (its workflow engine starting the next job of a chain).
// The rule about which inputs a caller may fill is the safety rule of this
// package, so it lives once and both doors go through it.
var { generateId } = require('@xeplr/utils/lib/helpers');
var { executeJob } = require('./execute');

// WHAT A REQUEST MAY CHANGE ABOUT A SAVED JOB. A job's inputs include its SQL,
// its WHERE clause, its table, procedure and connection — whoever saved the job
// chose those. Letting any caller replace them would turn "run this job" into
// "run this SQL on that connection". The period a run covers is the thing a
// caller legitimately picks; a host widens the list knowingly (the router's
// overridableInputs), and a job widens it for itself (acceptsInputs).
var DEFAULT_OVERRIDABLE_INPUTS = ['window'];

// A job may not offer these to a caller, whatever its author ticks: a saved
// connection is the one input that decides WHERE the job reads and writes.
var NEVER_ACCEPTED = /connection/i;

function refusedInputs(inputs, allowed) {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return [];
  return Object.keys(inputs).filter(function(k) { return inputs[k] !== undefined && allowed.indexOf(k) === -1; });
}

/** The keys a trigger may fill on this job: the host's list plus the job's own. */
function allowedInputsFor(job, overridable) {
  var base = Array.isArray(overridable) ? overridable : DEFAULT_OVERRIDABLE_INPUTS;
  var own = (job && Array.isArray(job.acceptsInputs) ? job.acceptsInputs : [])
    .filter(function(k) { return typeof k === 'string' && k && !NEVER_ACCEPTED.test(k); });
  return base.concat(own.filter(function(k) { return base.indexOf(k) === -1; }));
}

/**
 * The problems with a job's acceptsInputs, as sentences — for the save path.
 * Empty when it is fine.
 */
function acceptsInputsProblems(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return ['acceptsInputs must be a list of input names.'];
  var problems = [];
  value.forEach(function(k) {
    if (typeof k !== 'string' || !k.trim()) problems.push('acceptsInputs holds a blank or non-text name.');
    else if (NEVER_ACCEPTED.test(k)) problems.push('"' + k + '" cannot be accepted from another job: a connection is chosen by whoever saves the job.');
  });
  return problems;
}

function fail(code, message, extra) {
  var err = new Error(message);
  err.code = code;
  Object.assign(err, extra || {});
  return err;
}

/**
 * Start one run of a saved job. Answers at once — the run itself is
 * fire-and-forget, a twenty-minute movement cannot be awaited inside a request.
 *
 *   body.inputs       per-run overrides, only the allowed keys
 *   body.callbackUrl  where to POST the outcome when the run ends
 *   body.chain        carried with the run and handed back when it ends
 *
 * Throws with err.code NOT_FOUND | BUSY | INPUTS_REFUSED. Runs in the caller's
 * tenant context: the job is found through a tenant-filtered query.
 */
async function triggerJob(models, jobId, body, options) {
  body = body || {};
  options = options || {};
  var job = await models.Job.query().findById(jobId);
  if (!job) throw fail('NOT_FOUND', 'No job ' + jobId + '.');

  // BUSY IS A REFUSAL, NOT A QUEUE, and it is answered here rather than
  // discovered later.
  //
  // A job holds one lock and runs one at a time. Told "triggered" while the
  // previous run is still going, a caller — a workflow step above all —
  // carries on as though a second run had started, and the step after it acts
  // on data that was never moved. Saying so up front is the only answer that
  // leaves the chain honest.
  //
  // The check is racy against a cron tick claiming the lock a millisecond
  // later, and that is covered rather than ignored: executeJob records a
  // 'skipped' occurrence and reports it, so a caller learns the same thing
  // either way. This just makes the common case immediate.
  if (job.running) {
    throw fail('BUSY', 'This job is already running. Wait for the current run to finish.', { jobId: job.id });
  }

  var allowed = allowedInputsFor(job, options.overridableInputs);
  var refused = refusedInputs(body.inputs, allowed);
  if (refused.length) {
    throw fail('INPUTS_REFUSED', 'These inputs cannot be overridden by a request: ' + refused.join(', ') +
      ' — only ' + allowed.join(', '), { refused: refused });
  }

  // MINTED HERE so it can be returned NOW, before the work starts.
  var occurrenceId = generateId();

  executeJob(models, job, { type: options.triggerType || 'manual' }, {
    inputs: body.inputs || null,
    // Stored on the occurrence so the reaper can honour it after a worker dies.
    callbackUrl: body.callbackUrl || null,
    chain: body.chain || null,
    occurrenceId: occurrenceId
  });

  return { occurrenceId: occurrenceId, jobId: job.id, status: 'running' };
}

module.exports = {
  triggerJob: triggerJob,
  refusedInputs: refusedInputs,
  allowedInputsFor: allowedInputsFor,
  acceptsInputsProblems: acceptsInputsProblems,
  DEFAULT_OVERRIDABLE_INPUTS: DEFAULT_OVERRIDABLE_INPUTS
};
