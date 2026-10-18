var express = require('express');
var { genericRoute } = require('@xeplr/base-apis');
var { respond } = require('@xeplr/utils/lib/response');
var { HTTP, STATUS } = require('@xeplr/utils/isomorphic');
var actions = require('@xeplr/actions');
var unboundModels = require('../models');
var { executeJob } = require('./execute');

/**
 * Build the jobs HTTP router.
 *
 *   options.auth  — single middleware or { list, getById, save, delete }
 *                    passed through to genericRoute for CRUD paths.
 *                    Also gates the custom endpoints.
 *   options.overridableInputs — the job input keys a TRIGGER REQUEST may
 *                    replace for one run. Default ['window']. Anything else in
 *                    body.inputs is refused (400), naming the keys.
 */
// The rule about which inputs a request may fill lives in lib/trigger.js, so
// this router and a host's in-process trigger() cannot disagree about it.
var trigger = require('./trigger');
var refusedInputs = trigger.refusedInputs;
var DEFAULT_OVERRIDABLE_INPUTS = trigger.DEFAULT_OVERRIDABLE_INPUTS;

function createJobRouter(options) {
  options = options || {};
  var overridable = Array.isArray(options.overridableInputs) ? options.overridableInputs : DEFAULT_OVERRIDABLE_INPUTS;
  // BOUND models, supplied by index.js's router()/start(). The unbound classes
  // are the fallback for a caller building this router directly — they resolve
  // through the process's global Objection binding, which is correct only when
  // jobs is the only thing in the process. See lib/db.js.
  var models = options.models || unboundModels;
  var router = express.Router();
  var auth = options.auth;
  var authMw = normalizeAuth(auth);

  // GET /jobs/:id/occurrences — this job's run history, NEWEST FIRST.
  //
  // BEFORE the generic /jobs router below, and that ordering is deliberate.
  // Today genericRoute only declares GET '/' and GET '/:id', so a two-segment
  // path falls through to here on its own — but that is a fact about another
  // package's current contents, not a guarantee. Registered first, this route
  // cannot be swallowed by a catch-all somebody adds there later.
  //
  // The generic route could not serve this anyway: it paginates (?page=&limit=)
  // but does not ORDER, so ?limit=50 returns an arbitrary fifty rather than the
  // most recent fifty. That is also why the UI's latestByJob() has to defend
  // against arbitrary order.
  //
  // Bounded on purpose. A job on a five-minute cron writes about 105,000
  // occurrences a year; "show me this job's runs" must never mean "send all of
  // them". Default 50, hard ceiling 500 — a ceiling rather than an honoured
  // request, because the cost of a big one is paid by the server, not by
  // whoever asked for it.
  router.get('/jobs/:id/occurrences', authMw, async function(req, res) {
    try {
      var limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
      var rows = await models.JobOccurrence.query()
        .where('jobId', req.params.id)
        .orderBy('startedAt', 'desc')
        .limit(limit);
      respond(res, HTTP.OK, STATUS.SUCCESS, 'success', { dataArray: rows });
    } catch (err) {
      respond(res, HTTP.SERVER_ERROR, STATUS.SERVER_ERROR, 'server_error', { error: err });
    }
  });

  // CRUD
  // GET /jobs/active — WHAT IS RUNNING RIGHT NOW, and how far it has got.
  //
  // BEFORE the generic /jobs mount, and it has to be: genericRoute declares
  // GET '/:id', which matches 'active' as an id and answers not_found. Same
  // reasoning as /jobs/:id/occurrences above.
  //
  // The endpoint a screen polls instead of reloading itself. Those are not the
  // same cost and the difference is the whole point: a page refresh re-runs
  // the job list, the occurrence history and every render behind them; this
  // returns a handful of rows off `idx_occurrences_running` (added in 0004 for
  // the reaper, which asks this exact question).
  //
  // THE CLIENT'S HALF OF THE BARGAIN IS TO STOP. Poll every couple of seconds
  // while this returns rows, and stop completely when it returns none — an
  // idle screen should make no requests at all, which is something a polling
  // client can do and an open SSE connection cannot.
  //
  // No pagination, because there is a natural ceiling: nothing can be running
  // beyond the executor's concurrency cap. If this ever returns a big list,
  // that is a fact worth seeing rather than one to hide behind a page size.
  //
  // Tenant-scoped through the ordinary model query — a caller sees what is
  // running in their own company, not the machine's whole workload.
  router.get('/jobs/active', authMw, async function(req, res) {
    try {
      var running = await models.JobOccurrence.query()
        .where({ status: 'running' })
        .orderBy('startedAt', 'asc');

      // The job's name comes along, so the poller has everything it needs to
      // render a row without a second request per occurrence.
      var jobIds = running.map(function(o) { return o.jobId; });
      var jobs = jobIds.length ? await models.Job.query().whereIn('id', jobIds).select('id', 'name') : [];
      var nameById = {};
      jobs.forEach(function(j) { nameById[j.id] = j.name; });

      respond(res, HTTP.OK, STATUS.SUCCESS, 'success', {
        dataArray: running.map(function(o) {
          return {
            id: o.id,
            jobId: o.jobId,
            jobName: nameById[o.jobId] || null,
            status: o.status,
            startedAt: o.startedAt,
            retryCount: o.retryCount,
            // Null until the first throttled write lands, and null forever for
            // an action that reports nothing. A client must render "running"
            // without numbers rather than waiting for them.
            progress: o.progress || null
          };
        })
      });
    } catch (err) {
      respond(res, HTTP.SERVER_ERROR, STATUS.SERVER_ERROR, 'server_error', { error: err });
    }
  });

  router.use('/jobs',            genericRoute({ key: 'job',        model: models.Job           }, { auth: auth }));
  router.use('/job-occurrences', genericRoute({ key: 'occurrence', model: models.JobOccurrence }, { auth: auth }));

  // GET /actions — list registered actions from the runtime registry.
  // This is what the UI reads to render the "select an action" dropdown.
  router.get('/actions', authMw, function(req, res) {
    respond(res, HTTP.OK, STATUS.SUCCESS, 'success', { dataArray: actions.list() });
  });

  // POST /jobs/:id/trigger — fire a single manual occurrence
  //
  // Body `{ inputs }` overrides the job's saved inputs FOR THIS RUN ONLY, one
  // top-level key at a time (see mergeInputs in lib/execute.js). The job row
  // is not touched, so the next scheduled run is unaffected.
  //
  // This is what makes a job reusable as a step in something larger: the same
  // saved movement runs for whatever window the caller names — an hourly
  // top-up, a backfill of last March, a re-run of the window that failed —
  // instead of needing one job row per window. Without it the only way to
  // vary a run was to edit the job, run it, and edit it back.
  //
  // The merged set is what lands in the occurrence's `input` column, so the
  // history says which window each run actually used.
  router.post('/jobs/:id/trigger', authMw, async function(req, res) {
    try {
      var body = req.body || {};
      var started = await trigger.triggerJob(models, req.params.id, {
        inputs: body.inputs,
        callbackUrl: body.callbackUrl,
        chain: body.chain
      }, { overridableInputs: overridable });
      respond(res, HTTP.OK, STATUS.SUCCESS, 'triggered', { dataArray: [started] });
    } catch (err) {
      if (err.code === 'NOT_FOUND') return respond(res, HTTP.NOT_FOUND, STATUS.NOT_FOUND, 'not_found');
      if (err.code === 'BUSY') {
        return respond(res, HTTP.CONFLICT, STATUS.CONFLICT, 'busy', {
          message: err.message,
          dataArray: [{ jobId: err.jobId, status: 'busy' }]
        });
      }
      if (err.code === 'INPUTS_REFUSED') {
        return respond(res, HTTP.BAD_REQUEST, STATUS.BAD_REQUEST, 'bad_request', { message: err.message });
      }
      respond(res, HTTP.SERVER_ERROR, STATUS.SERVER_ERROR, 'server_error', { error: err });
    }
  });

  // POST /jobs/run — batch-trigger by id
  router.post('/jobs/run', authMw, async function(req, res) {
    try {
      var jobIds = (req.body && req.body.jobIds) || [];
      if (!Array.isArray(jobIds) || jobIds.length === 0) {
        return respond(res, HTTP.BAD_REQUEST, STATUS.BAD_REQUEST, 'bad_request', {
          message: 'jobIds array is required'
        });
      }
      // PER-JOB overrides, `{ inputs: { <jobId>: {...} } }` — deliberately not
      // one object applied to all of them. This route takes an arbitrary set
      // of jobs whose actions have nothing in common, so a shared `inputs`
      // would be a window meant for one movement landing on another job that
      // happens to have a field of the same name. A caller wanting the same
      // override on several jobs says so several times, which is the honest
      // amount of typing for the thing being asked.
      var byJob = (req.body && req.body.inputs) || {};
      var found = await models.Job.query().whereIn('id', jobIds);
      var jobById = {};
      found.forEach(function(j) { jobById[j.id] = j; });
      // Each job by its OWN accepted list (see lib/trigger.js). An id that is
      // not found is checked against the host's list alone.
      var refusedByJob = Object.keys(byJob).map(function(id) {
        var allowed = trigger.allowedInputsFor(jobById[id], overridable);
        var r = refusedInputs(byJob[id], allowed);
        return r.length ? id + ': ' + r.join(', ') + ' (only ' + allowed.join(', ') + ')' : null;
      }).filter(Boolean);
      if (refusedByJob.length) {
        return respond(res, HTTP.BAD_REQUEST, STATUS.BAD_REQUEST, 'bad_request', {
          message: 'These inputs cannot be overridden by a request — ' + refusedByJob.join('; ')
        });
      }
      var ids = new Set(found.map(function(j) { return j.id; }));
      var missing = jobIds.filter(function(id) { return !ids.has(id); });
      for (var i = 0; i < found.length; i++) {
        executeJob(models, found[i], { type: 'manual' }, { inputs: byJob[found[i].id] || null });
      }
      respond(res, HTTP.OK, STATUS.SUCCESS, 'triggered', {
        updatedIds: found.map(function(j) { return j.id; }),
        dataArray: [{ triggered: found.length, missing: missing }]
      });
    } catch (err) {
      respond(res, HTTP.SERVER_ERROR, STATUS.SERVER_ERROR, 'server_error', { error: err });
    }
  });

  // POST /jobs/:id/pause
  router.post('/jobs/:id/pause', authMw, async function(req, res) {
    try {
      var rows = await models.Job.query().patch({ status: 'pause' }).where({ id: req.params.id });
      if (!rows) return respond(res, HTTP.NOT_FOUND, STATUS.NOT_FOUND, 'not_found');
      respond(res, HTTP.OK, STATUS.SUCCESS, 'paused');
    } catch (err) {
      respond(res, HTTP.SERVER_ERROR, STATUS.SERVER_ERROR, 'server_error', { error: err });
    }
  });

  // POST /jobs/:id/resume
  router.post('/jobs/:id/resume', authMw, async function(req, res) {
    try {
      var rows = await models.Job.query().patch({ status: 'ready' }).where({ id: req.params.id });
      if (!rows) return respond(res, HTTP.NOT_FOUND, STATUS.NOT_FOUND, 'not_found');
      respond(res, HTTP.OK, STATUS.SUCCESS, 'resumed');
    } catch (err) {
      respond(res, HTTP.SERVER_ERROR, STATUS.SERVER_ERROR, 'server_error', { error: err });
    }
  });

  return router;
}

function normalizeAuth(auth) {
  var noop = function(req, res, next) { next(); };
  if (!auth) return noop;
  if (typeof auth === 'function') return auth;
  if (auth.save) return Array.isArray(auth.save) ? chain(auth.save) : auth.save;
  return noop;
}

function chain(mws) {
  return function(req, res, next) {
    var i = 0;
    (function run() { if (i >= mws.length) return next(); mws[i++](req, res, run); })();
  };
}

module.exports = createJobRouter;
module.exports.refusedInputs = refusedInputs;
module.exports.DEFAULT_OVERRIDABLE_INPUTS = DEFAULT_OVERRIDABLE_INPUTS;
