// A trigger request may change only what a caller legitimately picks — by
// default the window — never a saved job's SQL, table, procedure or connection.
var test = require('node:test');
var assert = require('node:assert/strict');
var http = require('node:http');
var path = require('node:path');
var express = require('express');

var executed = [];
var executePath = require.resolve(path.join(__dirname, '../lib/execute'));
require.cache[executePath] = { id: executePath, filename: executePath, loaded: true, exports: { executeJob: function(models, job, trigger, opts) { executed.push({ jobId: job.id, inputs: opts.inputs }); } } };

var createJobRouter = require('../lib/jobRouter');
var unbound = require('../models');

function stubModels() {
  var jobs = { j1: { id: 'j1', running: false }, j2: { id: 'j2', running: false } };
  var Job = Object.create(unbound.Job);
  Job.query = function() {
    return {
      findById: async function(id) { return jobs[id] || null; },
      whereIn: async function(col, ids) { return ids.map(function(id) { return jobs[id]; }).filter(Boolean); }
    };
  };
  return Object.assign({}, unbound, { Job: Job });
}

async function withServer(options, fn) {
  var app = express();
  app.use(express.json());
  app.use(createJobRouter(Object.assign({ models: stubModels(), auth: function(req, res, next) { next(); } }, options)));
  var server = http.createServer(app);
  await new Promise(function(r) { server.listen(0, r); });
  var base = 'http://127.0.0.1:' + server.address().port;
  var post = async function(url, body) {
    var res = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try { await fn(post); } finally { await new Promise(function(r) { server.close(r); }); }
}

test('trigger: the window may be overridden; the SQL, table and connection may not', async function() {
  await withServer({}, async function(post) {
    executed.length = 0;
    var ok = await post('/jobs/j1/trigger', { inputs: { window: { from: '2026-08-01' } } });
    assert.equal(ok.status, 200);
    assert.deepEqual(executed[0].inputs, { window: { from: '2026-08-01' } });

    var bad = await post('/jobs/j1/trigger', { inputs: { sql: 'DELETE FROM orders', where: '1=1', window: {} } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /cannot be overridden by a request: sql, where/);
    assert.equal(executed.length, 1, 'nothing ran');

    var none = await post('/jobs/j1/trigger', {});
    assert.equal(none.status, 200, 'no inputs at all is fine');
  });
});

test('batch run: per-job overrides are checked the same way', async function() {
  await withServer({}, async function(post) {
    executed.length = 0;
    var bad = await post('/jobs/run', { jobIds: ['j1', 'j2'], inputs: { j2: { sourceConnectionInfoId: 'elsewhere' } } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /j2: sourceConnectionInfoId/);
    assert.equal(executed.length, 0);
    var ok = await post('/jobs/run', { jobIds: ['j1'], inputs: { j1: { window: { to: '2026-09-01' } } } });
    assert.equal(ok.status, 200);
  });
});

test('an app can widen the list, knowingly', async function() {
  await withServer({ overridableInputs: ['window', 'limit'] }, async function(post) {
    assert.equal((await post('/jobs/j1/trigger', { inputs: { limit: 100 } })).status, 200);
    assert.equal((await post('/jobs/j1/trigger', { inputs: { sql: 'x' } })).status, 400);
  });
  assert.deepEqual(createJobRouter.refusedInputs(['not', 'an object'], ['window']), []);
  assert.deepEqual(createJobRouter.DEFAULT_OVERRIDABLE_INPUTS, ['window']);
});
