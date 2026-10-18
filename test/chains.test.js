// What a chain needs from jobs, on a real Postgres: every run that ends is
// reported to the host's onFinish hook — cron runs, failures and refusals too —
// with the period it ran for and whatever was carried with it; and a trigger
// may fill only `window` plus the inputs the job itself accepts.
//
// Needs JOBS_TEST_PG = '{"host":"localhost","port":5432,"user":"…","password":"…"}'.
// A scratch database is created and dropped.
var test = require('node:test');
var assert = require('node:assert/strict');
var http = require('node:http');
var path = require('node:path');

var PG = process.env.JOBS_TEST_PG ? JSON.parse(process.env.JOBS_TEST_PG) : null;
var skip = PG ? false : 'set JOBS_TEST_PG to run against Postgres';

var jobs = require('..');
var DB = 'xeplr_jobs_test_' + Date.now();
var finished = [];
var conn;

function waitFor(predicate, ms) {
  var until = Date.now() + (ms || 5000);
  return new Promise(function(resolve, reject) {
    (function poll() {
      var hit = predicate();
      if (hit) return resolve(hit);
      if (Date.now() > until) return reject(new Error('timed out waiting'));
      setTimeout(poll, 25);
    })();
  });
}

function reportFor(occurrenceId) {
  return waitFor(function() {
    return finished.find(function(f) { return f.output.occurrenceId === occurrenceId; });
  });
}

async function saveJob(row) {
  var { Job } = jobs.boundModels();
  return Job.query().insert(Object.assign({ id: 'j' + Math.random().toString(36).slice(2, 12), status: 'ready' }, row));
}

test.before(async function() {
  if (skip) return;
  jobs.registerAction({
    name: 'chain-echo',
    inputSchema: [{ name: 'window', type: 'object' }, { name: 'region', type: 'string' }],
    execute: async function(ctx) { return { region: ctx.input.region || null }; }
  });
  jobs.registerAction({
    name: 'chain-fail',
    execute: async function() { throw new Error('the source table is gone'); }
  });
  conn = await jobs.init({
    database: DB,
    connection: PG,
    defaultActions: false,
    onFinish: async function(report) { finished.push(report); }
  });
  await conn.migrate.latest({ directory: path.join(__dirname, '..', 'migrations') });
});

test.after(async function() {
  if (skip) return;
  jobs.stopScheduler();
  await conn.destroy();
  var admin = require('knex')({ client: 'pg', connection: Object.assign({ database: 'postgres' }, PG) });
  await admin.raw('DROP DATABASE IF EXISTS "' + DB + '" WITH (FORCE)');
  await admin.destroy();
});

test('a triggered run reports its window, its chain and its own output', { skip: skip }, async function() {
  var job = await saveJob({ name: 'Load', actionName: 'chain-echo', inputs: { region: 'north' }, acceptsInputs: ['region'] });
  var window = { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' };
  var started = await jobs.trigger(job.id, {
    inputs: { window: window, region: 'south' },
    chain: { carry: { batch: 7 }, path: ['jA'] }
  });
  assert.equal(started.status, 'running');

  var report = await reportFor(started.occurrenceId);
  assert.equal(report.status, 'success');
  assert.deepEqual(report.output.window, window);
  assert.deepEqual(report.output.chain, { carry: { batch: 7 }, path: ['jA'] });
  assert.deepEqual(report.output.output, { region: 'south' }, 'the accepted input reached the action');
  assert.equal(report.occurrence.jobId, job.id);
});

test('a trigger may fill only window and what the job accepts', { skip: skip }, async function() {
  var job = await saveJob({ name: 'Strict', actionName: 'chain-echo', inputs: {} });
  await assert.rejects(jobs.trigger(job.id, { inputs: { region: 'x' } }), function(err) {
    assert.equal(err.code, 'INPUTS_REFUSED');
    assert.match(err.message, /region — only window/);
    return true;
  });
  await assert.rejects(jobs.trigger('no-such-job', {}), { code: 'NOT_FOUND' });
});

test('a job cannot accept its connection from another job', { skip: skip }, async function() {
  await assert.rejects(
    saveJob({ name: 'Bad', actionName: 'chain-echo', acceptsInputs: ['region', 'sourceConnectionInfoId'] }),
    /"sourceConnectionInfoId" cannot be accepted from another job/);
  var job = await saveJob({ name: 'Sneaky', actionName: 'chain-echo', inputs: {} });
  // Written past the model's check, straight into the table: the trigger still refuses it.
  await conn('jobs').where({ id: job.id }).update({ acceptsInputs: JSON.stringify(['connectionInfoId']) });
  await assert.rejects(jobs.trigger(job.id, { inputs: { connectionInfoId: 'c2' } }), { code: 'INPUTS_REFUSED' });
});

test('a failed run is reported as failed, with its error and its chain', { skip: skip }, async function() {
  var job = await saveJob({ name: 'Breaks', actionName: 'chain-fail', inputs: {} });
  var started = await jobs.trigger(job.id, { chain: { carry: { k: 1 } } });
  var report = await reportFor(started.occurrenceId);
  assert.equal(report.status, 'failed');
  assert.match(report.error.message, /source table is gone/);
  assert.deepEqual(report.output.chain, { carry: { k: 1 } });
});

test('a busy job refuses at once', { skip: skip }, async function() {
  var job = await saveJob({ name: 'Busy', actionName: 'chain-echo', inputs: {}, running: true });
  await assert.rejects(jobs.trigger(job.id, {}), { code: 'BUSY' });
});

test('a cron run, with nobody waiting on it, still reaches onFinish', { skip: skip }, async function() {
  var job = await saveJob({
    name: 'Nightly', actionName: 'chain-echo', inputs: { window: { column: 'postedAt' } },
    schedule: '0 3 * * *', nextRunAt: new Date(Date.now() - 60000).toISOString(), incrementalMode: 'period'
  });
  jobs.startScheduler({ intervalMs: 100 });
  var report = await waitFor(function() {
    return finished.find(function(f) { return f.output.jobId === job.id; });
  });
  jobs.stopScheduler();
  assert.equal(report.status, 'success');
  assert.equal(report.occurrence.callbackUrl, null);
  assert.equal(report.output.window.column, 'postedAt', 'the authored window fields survive');
  assert.ok(report.output.window.to, 'the computed period is reported');
});

test('the callback URL receives the same window and chain', { skip: skip }, async function() {
  var received;
  var server = http.createServer(function(req, res) {
    var data = '';
    req.on('data', function(c) { data += c; });
    req.on('end', function() { received = JSON.parse(data); res.end('{}'); });
  });
  await new Promise(function(r) { server.listen(0, r); });
  try {
    var job = await saveJob({ name: 'Called back', actionName: 'chain-echo', inputs: {} });
    var window = { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' };
    await jobs.trigger(job.id, {
      inputs: { window: window },
      chain: { carry: { x: 'y' } },
      callbackUrl: 'http://127.0.0.1:' + server.address().port + '/done'
    });
    await waitFor(function() { return received; });
    assert.equal(received.status, 'success');
    assert.deepEqual(received.output.window, window);
    assert.deepEqual(received.output.chain, { carry: { x: 'y' } });
  } finally {
    await new Promise(function(r) { server.close(r); });
  }
});

test('a run that fails before its action (a bad incremental mode) is reported too', { skip: skip }, async function() {
  var job = await saveJob({ name: 'Misconfigured', actionName: 'chain-echo', inputs: {}, incrementalMode: 'watermark' });
  var started = await jobs.trigger(job.id, { chain: { carry: { k: 2 } } });
  var report = await reportFor(started.occurrenceId);
  assert.equal(report.status, 'failed');
  assert.match(report.error.message, /watermark/);
  assert.deepEqual(report.output.chain, { carry: { k: 2 } });
});

test('a run the reaper times out is reported, though its worker never came back', { skip: skip }, async function() {
  var { JobOccurrence } = jobs.boundModels();
  var job = await saveJob({ name: 'Vanished', actionName: 'chain-echo', inputs: {}, running: true, timeoutMinutes: 1 });
  var occ = await JobOccurrence.query().insert({
    id: 'o' + Math.random().toString(36).slice(2, 12), jobId: job.id, status: 'running', retryCount: 0,
    startedAt: new Date(Date.now() - 5 * 60000).toISOString(), triggeredBy: { type: 'manual' },
    input: { window: { from: 'a', to: 'b' } }, chain: { carry: { lost: true } }
  });
  jobs.startScheduler({ intervalMs: 100 });
  var report = await reportFor(occ.id);
  jobs.stopScheduler();
  assert.equal(report.status, 'failed');
  assert.equal(report.output.status, 'timedOut');
  assert.deepEqual(report.output.window, { from: 'a', to: 'b' });
  assert.deepEqual(report.output.chain, { carry: { lost: true } });
});

test('a run stopped by a shutdown is reported as interrupted', { skip: skip }, async function() {
  var release;
  jobs.registerAction({ name: 'chain-slow', execute: function() { return new Promise(function(r) { release = r; }); } });
  var job = await saveJob({ name: 'Slow', actionName: 'chain-slow', inputs: {} });
  var started = await jobs.trigger(job.id, { chain: { carry: { s: 1 } } });
  await waitFor(function() { return release; });
  await require('../lib/execute').shutdownInFlight(jobs.boundModels());
  var report = await reportFor(started.occurrenceId);
  assert.equal(report.status, 'failed');
  assert.equal(report.output.status, 'interrupted');
  assert.deepEqual(report.output.chain, { carry: { s: 1 } });

  // The worker comes back late: recorded as lateFinish, and NOT reported a
  // second time — a second report would start the next job twice.
  release({});
  var { Job, JobOccurrence } = jobs.boundModels();
  var until = Date.now() + 3000;
  var row;
  while (Date.now() < until) {
    row = await JobOccurrence.query().findById(started.occurrenceId);
    if (row.lateFinish) break;
    await new Promise(function(r) { setTimeout(r, 50); });
  }
  assert.ok(row.lateFinish, 'the late finish is recorded');
  assert.equal(row.status, 'interrupted');
  assert.equal(finished.filter(function(f) { return f.output.occurrenceId === started.occurrenceId; }).length, 1, 'reported once');
  assert.equal((await Job.query().findById(job.id)).running, false);
});

test('acceptsInputs is checked as a list of plain names', function() {
  var problems = require('../lib/trigger').acceptsInputsProblems;
  assert.deepEqual(problems(null), []);
  assert.deepEqual(problems(['region']), []);
  assert.match(problems('region')[0], /must be a list/);
  assert.match(problems(['', 3])[0], /blank or non-text/);
  assert.match(problems(['dbConnection'])[0], /cannot be accepted/);
});
