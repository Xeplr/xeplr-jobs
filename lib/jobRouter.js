var express = require('express');
var { genericRoute } = require('@xeplr/base-apis');
var { respond } = require('@xeplr/utils/lib/response');
var { HTTP, STATUS } = require('@xeplr/utils/isomorphic');
var actions = require('@xeplr/actions');
var models = require('../models');
var { executeJob } = require('./execute');

/**
 * Build the jobs HTTP router.
 *
 *   options.auth  — single middleware or { list, getById, save, delete }
 *                    passed through to genericRoute for CRUD paths.
 *                    Also gates the custom endpoints.
 */
function createJobRouter(options) {
  options = options || {};
  var router = express.Router();
  var auth = options.auth;
  var authMw = normalizeAuth(auth);

  // CRUD
  router.use('/jobs',            genericRoute({ key: 'job',        model: models.Job           }, { auth: auth }));
  router.use('/job-occurrences', genericRoute({ key: 'occurrence', model: models.JobOccurrence }, { auth: auth }));

  // GET /actions — list registered actions from the runtime registry.
  // This is what the UI reads to render the "select an action" dropdown.
  router.get('/actions', authMw, function(req, res) {
    respond(res, HTTP.OK, STATUS.SUCCESS, 'success', { dataArray: actions.list() });
  });

  // POST /jobs/:id/trigger — fire a single manual occurrence
  router.post('/jobs/:id/trigger', authMw, async function(req, res) {
    try {
      var job = await models.Job.query().findById(req.params.id);
      if (!job) return respond(res, HTTP.NOT_FOUND, STATUS.NOT_FOUND, 'not_found');
      executeJob(models, job, { type: 'manual' });
      respond(res, HTTP.OK, STATUS.SUCCESS, 'triggered');
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
      var found = await models.Job.query().whereIn('id', jobIds);
      var ids = new Set(found.map(function(j) { return j.id; }));
      var missing = jobIds.filter(function(id) { return !ids.has(id); });
      for (var i = 0; i < found.length; i++) {
        executeJob(models, found[i], { type: 'manual' });
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
