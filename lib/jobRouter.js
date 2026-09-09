var express = require('express');
var { genericRoute } = require('@xeplr/base-apis');
var { respond } = require('@xeplr/utils/lib/response');
var { HTTP, STATUS } = require('@xeplr/utils/isomorphic');
var actions = require('@xeplr/actions');
var unboundModels = require('../models');
var { executeJob } = require('./execute');
var { generateId } = require('@xeplr/utils/lib/helpers');

/**
 * Build the jobs HTTP router.
 *
 *   options.auth  — single middleware or { list, getById, save, delete }
 *                    passed through to genericRoute for CRUD paths.
 *                    Also gates the custom endpoints.
 */
function createJobRouter(options) {
  options = options || {};
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
      var job = await models.Job.query().findById(req.params.id);
      if (!job) return respond(res, HTTP.NOT_FOUND, STATUS.NOT_FOUND, 'not_found');

      // BUSY IS A REFUSAL, NOT A QUEUE, and it is answered here rather than
      // discovered later.
      //
      // A job holds one lock and runs one at a time. Told "triggered" while
      // the previous run is still going, a caller — a workflow step above all
      // — carries on as though a second run had started, and the step after it
      // acts on data that was never moved. Saying so up front is the only
      // answer that leaves the chain honest.
      //
      // The check is racy against a cron tick claiming the lock a millisecond
      // later, and that is covered rather than ignored: executeJob records a
      // 'skipped' occurrence and fires the callback with that status, so a
      // caller learns the same thing either way. This just makes the common
      // case immediate and legible instead of arriving by callback.
      if (job.running) {
        return respond(res, HTTP.CONFLICT, STATUS.CONFLICT, 'busy', {
          message: 'This job is already running. Wait for the current run to finish.',
          dataArray: [{ jobId: job.id, status: 'busy' }]
        });
      }

      var body = req.body || {};
      // MINTED HERE so it can be returned NOW. executeJob is fire-and-forget —
      // a twenty-minute movement cannot be awaited inside a request — so
      // without this the caller gets no handle at all and has to go hunting
      // through the history for a row that may not exist yet.
      var occurrenceId = generateId();

      executeJob(models, job, { type: 'manual' }, {
        inputs: body.inputs || null,
        // Where to report when this run ends, in whatever way it ends. Stored
        // on the occurrence so the reaper can honour it after a worker dies.
        callbackUrl: body.callbackUrl || null,
        occurrenceId: occurrenceId
      });

      respond(res, HTTP.OK, STATUS.SUCCESS, 'triggered', {
        dataArray: [{ occurrenceId: occurrenceId, jobId: job.id, status: 'running' }]
      });
    } catch (err) {
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
