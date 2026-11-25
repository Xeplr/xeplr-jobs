// A schedule another product owns, kept as a job, on a real Postgres with two
// tenancy levels: keepSchedule creates it in the caller's company, brings it up
// to date without moving a due run or un-pausing it, removes it, refuses
// another company's id; a system job is every company's ('*'), the scheduler
// runs it, and the routes refuse to change it for anyone (Run now allowed); a job's time zone decides when it is next due; a cron run
// hands its action the slot it was picked for (system.dueAt); and init
// ({ migrate: true }) brings the tables up itself.
//
// Needs JOBS_TEST_PG = '{"host":"localhost","port":5432,"user":"…","password":"…"}'.
var test = require('node:test');
var assert = require('node:assert/strict');

var PG = process.env.JOBS_TEST_PG ? JSON.parse(process.env.JOBS_TEST_PG) : null;
var skip = PG ? false : 'set JOBS_TEST_PG to run against Postgres';

var { runWithMt } = require('@xeplr/db');
var jobs = require('..');
var cron = require('../lib/cron');
var DB = 'xeplr_jobs_keep_test_' + Date.now();
var A = { mtId1: 'coA', mtId2: 'wsA' };
var B = { mtId1: 'coB', mtId2: 'wsB' };
var conn;
var ran = [];

function waitFor(predicate, ms) {
  var until = Date.now() + (ms || 8000);
  return new Promise(function(resolve, reject) {
    (async function poll() {
      var hit = await predicate();
      if (hit) return resolve(hit);
      if (Date.now() > until) return reject(new Error('timed out waiting'));
      setTimeout(poll, 50);
    })();
  });
}

test.before(async function() {
  if (skip) return;
  jobs.registerAction({
    name: 'keep-echo',
    inputSchema: [{ name: 'workflowId', type: 'string' }],
    execute: async function(ctx) { ran.push({ input: ctx.input, system: ctx.system }); return { ok: true }; }
  });
  conn = await jobs.init({
    database: DB,
    connection: PG,
    defaultActions: false,
    migrate: true,
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } }
  });
});

test.after(async function() {
  if (skip) return;
  jobs.stopScheduler();
  await conn.destroy();
  var admin = require('knex')({ client: 'pg', connection: Object.assign({ database: 'postgres' }, PG) });
  await admin.raw('DROP DATABASE IF EXISTS "' + DB + '" WITH (FORCE)');
  await admin.destroy();
});

test('a time zone decides when a cron is next due; blank is the server\'s', function() {
  var from = new Date('2026-11-25T00:00:00Z');
  assert.equal(cron.computeNextRun('0 9 * * *', from, 'Asia/Kolkata').toISOString(), '2026-11-25T03:30:00.000Z');
  assert.equal(cron.computeNextRun('0 9 * * *', from, 'Europe/London').toISOString(), '2026-11-25T09:00:00.000Z');
  assert.equal(cron.computeNextRun('0 9 * * *', from).getHours(), 9);
  assert.equal(cron.isValidCron('0 9 * * *', 'Asia/Kolkata'), true);
  assert.equal(cron.isValidCron('not a cron'), false);
});

test('init({ migrate: true }) made the tables, the time zone column included', { skip: skip }, async function() {
  assert.equal(await conn.schema.hasColumn('jobs', 'timezone'), true);
});

test('keepSchedule makes the job in the caller\'s company, read in its time zone', { skip: skip }, async function() {
  var job = await runWithMt(A, function() {
    return jobs.keepSchedule('wfKeep1', { name: 'Month-end recon', actionName: 'keep-echo', inputs: { workflowId: 'wfKeep1' }, cron: '0 9 * * *', timezone: 'Asia/Kolkata' });
  });
  assert.equal(job.mtId1, 'coA');
  assert.equal(job.mtId2, 'wsA');
  assert.equal(job.status, 'ready');
  assert.equal(job.timezone, 'Asia/Kolkata');
  var at = new Date(job.nextRunAt);
  // 9:00 in Kolkata is 03:30 UTC.
  assert.equal(at.getUTCHours() * 60 + at.getUTCMinutes(), 3 * 60 + 30);
  var seenByB = await runWithMt(B, function() { return jobs.boundModels().Job.query().findById('wfKeep1'); });
  assert.equal(seenByB, undefined, 'another company does not see it');
});

test('keeping it again changes what changed, and never un-pauses it or moves a due run', { skip: skip }, async function() {
  var Job = jobs.boundModels().Job;
  await runWithMt(A, async function() {
    await Job.query().findById('wfKeep1').patch({ status: 'pause' });
    var before = await Job.query().findById('wfKeep1');
    var same = await jobs.keepSchedule('wfKeep1', { name: 'Month-end recon (renamed)', actionName: 'keep-echo', inputs: { workflowId: 'wfKeep1' }, cron: '0 9 * * *', timezone: 'Asia/Kolkata' });
    assert.equal(same.status, 'pause', 'still paused');
    assert.equal(same.name, 'Month-end recon (renamed)');
    assert.equal(new Date(same.nextRunAt).getTime(), new Date(before.nextRunAt).getTime(), 'same cron: the due run stays');
    var moved = await jobs.keepSchedule('wfKeep1', { name: 'Month-end recon', actionName: 'keep-echo', inputs: { workflowId: 'wfKeep1' }, cron: '30 6 * * *', timezone: 'Europe/London' });
    assert.equal(moved.status, 'pause');
    assert.equal(moved.schedule, '30 6 * * *');
    assert.equal(moved.timezone, 'Europe/London');
    var at = new Date(moved.nextRunAt);
    assert.equal(at.getUTCHours() * 60 + at.getUTCMinutes(), 6 * 60 + 30, 'a new cron: due again from it');
  });
});

test('keepSchedule refuses a cron or zone it cannot read, and a missing name or action', { skip: skip }, async function() {
  await runWithMt(A, async function() {
    await assert.rejects(jobs.keepSchedule('wfBad', { name: 'x', actionName: 'keep-echo', cron: 'every day' }), /not a schedule this can read/);
    await assert.rejects(jobs.keepSchedule('wfBad', { name: 'x', actionName: 'keep-echo', cron: '0 9 * * *', timezone: 'Mars/Olympus' }), /in Mars\/Olympus/);
    await assert.rejects(jobs.keepSchedule('wfBad', { name: 'x', actionName: 'keep-echo', cron: '' }), /needs a cron/);
    await assert.rejects(jobs.keepSchedule('wfBad', { actionName: 'keep-echo', cron: '0 9 * * *' }), /needs a name/);
    await assert.rejects(jobs.keepSchedule('wfBad', { name: 'x', cron: '0 9 * * *' }), /the action it runs/);
    await assert.rejects(jobs.keepSchedule(null, null), /needs the id/);
  });
});

test('another company cannot take over a job by its id', { skip: skip }, async function() {
  await assert.rejects(runWithMt(B, function() {
    return jobs.keepSchedule('wfKeep1', { name: 'Mine now', actionName: 'keep-echo', cron: '0 9 * * *' });
  }), /belongs to someone else/);
});

test('null removes it; deleted on the Jobs screen, keeping it makes it again', { skip: skip }, async function() {
  var Job = jobs.boundModels().Job;
  await runWithMt(A, async function() {
    assert.equal(await jobs.keepSchedule('wfKeep1', null), null);
    assert.equal(await Job.query().findById('wfKeep1'), undefined);
    assert.equal(await jobs.keepSchedule('wfKeep1', null), null, 'removing twice is fine');
    await jobs.keepSchedule('wfKeep2', { name: 'Daily', actionName: 'keep-echo', cron: '0 1 * * *' });
    await Job.query().findById('wfKeep2').patch({ isActive: false });   // the screen's delete
    var back = await jobs.keepSchedule('wfKeep2', { name: 'Daily', actionName: 'keep-echo', cron: '0 1 * * *' });
    assert.equal(back.isActive, true);
    assert.equal(back.status, 'ready');
    await Job.query().findById('wfKeep2').patch({ isActive: false });
    assert.equal(await jobs.keepSchedule('wfKeep2', null), null);
    assert.equal(await conn('jobs').where({ id: 'wfKeep2' }).first(), undefined, 'a deleted one is cleared too');
  });
});

test('a system job is every company\'s, and the scheduler runs it with the slot it was due at', { skip: skip }, async function() {
  var sys = await jobs.keepSchedule('keep-system', { name: 'Due work', actionName: 'keep-echo', inputs: {}, cron: '* * * * *' }, { system: true });
  assert.equal(sys.mtId1, '*');
  assert.equal(sys.mtId2, '*');
  assert.equal(sys.system, true);
  var again = await jobs.keepSchedule('keep-system', { name: 'Due work', actionName: 'keep-echo', inputs: {}, cron: '* * * * *' }, { system: true });
  assert.equal(again.id, 'keep-system', 'kept twice is kept once');
  var seenByA = await runWithMt(A, function() { return jobs.boundModels().Job.query().findById('keep-system'); });
  assert.equal(seenByA && seenByA.system, true, 'every company lists it');
  await runWithMt(A, async function() {
    await assert.rejects(jobs.keepSchedule('keep-system', { name: 'Mine', actionName: 'keep-echo', cron: '* * * * *' }), /is a system job/);
    await assert.rejects(jobs.keepSchedule('wfKeep3x', { name: 'x', actionName: 'keep-echo', cron: '0 1 * * *' }).then(function() {
      return jobs.keepSchedule('wfKeep3x', { name: 'x', actionName: 'keep-echo', cron: '0 1 * * *' }, { system: true });
    }), /is an ordinary job/);
  });

  // Due now: the scheduler picks it and runs it with system.dueAt = that slot.
  var due = new Date(Date.now() - 1000).toISOString();
  await conn('jobs').where({ id: 'keep-system' }).update({ nextRunAt: due });
  jobs.startScheduler({ intervalMs: 200 });
  var hit = await waitFor(function() { return ran.find(function(r) { return r.system.jobId === 'keep-system'; }); });
  jobs.stopScheduler();
  assert.equal(hit.system.triggeredBy.type, 'cron');
  assert.equal(hit.system.dueAt, due);
  var after = await waitFor(async function() {
    var row = await conn('jobs').where({ id: 'keep-system' }).first();
    return row && !row.running ? row : null;
  });
  assert.ok(new Date(after.nextRunAt) > new Date(), 'moved on to its next minute');
  var occ = await conn('jobOccurrences').where({ jobId: 'keep-system' }).first();
  assert.equal(occ.mtId1, '*', 'its runs are every company\'s too');
});

test('the routes refuse to save, delete, pause or resume a system job, for anyone; Run now is allowed', { skip: skip }, async function() {
  var express = require('express');
  var { mtMiddleware } = require('@xeplr/db');
  var app = express();
  app.use(express.json());
  app.use(mtMiddleware());
  app.use(jobs.router());
  var server = await new Promise(function(resolve) { var s = app.listen(0, function() { resolve(s); }); });
  var base = 'http://127.0.0.1:' + server.address().port;
  async function call(path, body) {
    var r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-company-id': 'coA', 'x-workspace-id': 'wsA' }, body: JSON.stringify(body || {}) });
    return { status: r.status, body: await r.json() };
  }
  try {
    var tries = [
      ['/jobs/save', [{ id: 'keep-system', name: 'Paused by me' }]],
      ['/jobs/save', [{ name: 'Sneaky', actionName: 'keep-echo', system: true }]],
      ['/jobs/delete', { ids: ['keep-system'] }],
      ['/jobs/keep-system/pause'],
      ['/jobs/keep-system/resume']
    ];
    for (var i = 0; i < tries.length; i++) {
      var r = await call(tries[i][0], tries[i][1]);
      assert.equal(r.status, 403, tries[i][0]);
      assert.match(JSON.stringify(r.body), /system job/);
    }
    var row = await conn('jobs').where({ id: 'keep-system' }).first();
    assert.equal(row.name, 'Due work');
    assert.equal(row.status, 'ready');
    assert.equal(row.isActive, true);
    var none = await conn('jobs').where({ name: 'Sneaky' }).first();
    assert.equal(none, undefined);

    // An ordinary job still saves and pauses through the same routes.
    var ok = await call('/jobs/wfKeep3x/pause');
    assert.equal(ok.status, 200);

    var run = await call('/jobs/keep-system/trigger');
    assert.equal(run.status, 200, JSON.stringify(run.body));
    await waitFor(function() { return ran.filter(function(r) { return r.system.jobId === 'keep-system'; }).length >= 2; });
  } finally {
    await new Promise(function(resolve) { server.close(resolve); });
  }
  await waitFor(async function() { var row = await conn('jobs').where({ id: 'keep-system' }).first(); return row && !row.running; });
  assert.equal(await jobs.keepSchedule('keep-system', null, { system: true }), null);
  assert.equal(await conn('jobs').where({ id: 'keep-system', isActive: true }).first(), undefined);
});

test('a run started by hand has no due slot', { skip: skip }, async function() {
  var job = await runWithMt(A, function() {
    return jobs.keepSchedule('wfKeep3', { name: 'By hand', actionName: 'keep-echo', inputs: { workflowId: 'wfKeep3' }, cron: '0 1 1 1 *' });
  });
  await runWithMt(A, function() { return jobs.trigger(job.id, {}); });
  var hit = await waitFor(function() { return ran.find(function(r) { return r.system.jobId === 'wfKeep3'; }); });
  assert.equal(hit.system.dueAt, null);
  assert.equal(hit.input.workflowId, 'wfKeep3');
});

test('saving a new cron or time zone on the screen moves the next run', { skip: skip }, async function() {
  var Job = jobs.boundModels().Job;
  await runWithMt(A, async function() {
    var job = await Job.query().insertAndFetch({ id: 'jScreen1', name: 'Nightly', actionName: 'keep-echo', status: 'ready', schedule: '0 2 * * *' });
    await Job.query().findById(job.id).patch({ schedule: '0 2 * * *', timezone: 'Asia/Kolkata' });
    var at = new Date((await Job.query().findById(job.id)).nextRunAt);
    // 02:00 in Kolkata is 20:30 UTC the day before.
    assert.equal(at.getUTCHours() * 60 + at.getUTCMinutes(), 20 * 60 + 30);
    await Job.query().findById(job.id).patch({ schedule: '15 4 * * *', timezone: null });
    var local = new Date((await Job.query().findById(job.id)).nextRunAt);
    assert.equal(local.getHours() * 60 + local.getMinutes(), 4 * 60 + 15, 'blank: the server\'s zone');
    await Job.query().findById(job.id).patch({ name: 'Renamed' });
    assert.equal(new Date((await Job.query().findById(job.id)).nextRunAt).getTime(), local.getTime(), 'a save that does not touch the schedule leaves it');
  });
});
