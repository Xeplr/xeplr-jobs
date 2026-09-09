#!/usr/bin/env node

/**
 * Standalone jobs server entry point.
 * Designed to be run directly or from a consuming project's npm script.
 */
var jobs = require('../index');

var config = {};

if (process.env.JOBS_CONFIG) {
  try {
    config = JSON.parse(process.env.JOBS_CONFIG);
  } catch (e) {
    console.error('Failed to parse JOBS_CONFIG:', e.message);
    process.exit(1);
  }
}

config.port = config.port || process.env.JOBS_PORT || 19003;
// Left to connectJobsDb to reject if absent — one refusal, one message, in the
// one place that knows what a missing database actually costs. A default here
// would silently create and run jobs in a store nobody chose.
config.database = config.database || process.env.DB_JOBS;

// TENANCY, which this process has no other way of learning.
//
// registerMTs() is process-local: the app registered its levels in ITS server,
// and that says nothing here. Without it BaseModel's tenant modifier no-ops and
// every tenant's jobs are one list — no error, nothing to notice.
//
// JOBS_MTS is the same JSON registerMTs() takes, e.g.
//   JOBS_MTS='{"l1":{"name":"companyId","header":"x-company-id"},
//              "l2":{"name":"workspaceId","header":"x-workspace-id"}}'
// It can also be given as `mts` inside JOBS_CONFIG. init() warns loudly when
// neither is present rather than failing, because a genuinely single-tenant
// install is a legitimate consumer of this package.
if (!config.mts && process.env.JOBS_MTS) {
  try {
    config.mts = JSON.parse(process.env.JOBS_MTS);
  } catch (e) {
    console.error('Failed to parse JOBS_MTS:', e.message);
    process.exit(1);
  }
}

// start() is async now — the connection must be established before its router
// can be built (see index.js). Reporting ready before that resolved would have
// told a supervisor the process was up while its routes were still 500ing.
jobs.start(config)
  .then(function() {
    if (process.send) process.send({ status: 'ready', port: config.port });
  })
  .catch(function(err) {
    console.error('[xeplr-jobs] could not start:', err && err.message);
    process.exit(1);
  });
