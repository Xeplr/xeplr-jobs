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
config.database = config.database || process.env.DB_JOBS || 'jobs';

jobs.start(config);

if (process.send) {
  process.send({ status: 'ready', port: config.port });
}
