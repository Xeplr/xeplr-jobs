var express = require('express');
var { genericRoute } = require('@xeplr/base-apis');
var { respond } = require('@xeplr/utils/lib/response');
var { HTTP, STATUS } = require('@xeplr/utils/isomorphic');
var models = require('../models');
var { executeJob } = require('./execute');

/**
 * Build the jobs HTTP router.
 *
 *   options.auth  — single middleware or { list, getById, save, delete }
 *                    passed through to genericRoute for CRUD paths.
 *                    Also gates the custom endpoints (trigger/pause/resume/chain).
 */
function createJobRouter(options) {
  options = options || {};
  var router = express.Router();
  var auth = options.auth;
  var authMw = normalizeAuth(auth);

  // CRUD via genericRoute for each resource.
  router.use('/job-types',       genericRoute({ key: 'jobType',      model: models.JobType       }, { auth: auth }));
  router.use('/jobs',            genericRoute({ key: 'job',          model: models.Job           }, { auth: auth }));
  router.use('/job-reactivity',  genericRoute({ key: 'reactivity',   model: models.JobReactivity }, { auth: auth }));
  router.use('/job-occurrences', genericRoute({ key: 'occurrence',   model: models.JobOccurrence }, { auth: auth }));

  // POST /jobs/:id/trigger — enqueue a manual occurrence (fire-and-forget)
  router.post('/jobs/:id/trigger', authMw, async function(req, res) {
    try {
      var job = await models.Job.query().findById(req.params.id).withGraphFetched('jobType');
      if (!job) return respond(res, HTTP.NOT_FOUND, STATUS.NOT_FOUND, 'not_found');
      executeJob(models, job, { type: 'manual', params: (req.body && req.body.params) || {} });
      respond(res, HTTP.OK, STATUS.SUCCESS, 'triggered');
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

  // GET /job-occurrences/chain/:groupingTag — all occurrences in one reactive chain
  router.get('/job-occurrences/chain/:tag', authMw, async function(req, res) {
    try {
      var occurrences = await models.JobOccurrence.query()
        .where({ groupingTag: req.params.tag })
        .orderBy('startedAt', 'asc');
      respond(res, HTTP.OK, STATUS.SUCCESS, 'success', { dataArray: occurrences });
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
  // Object form — pick the save middleware as a reasonable default for actions.
  if (auth.save) return Array.isArray(auth.save) ? chain(auth.save) : auth.save;
  return noop;
}

function chain(mws) {
  return function(req, res, next) {
    var i = 0;
    (function run() {
      if (i >= mws.length) return next();
      mws[i++](req, res, run);
    })();
  };
}

module.exports = createJobRouter;
