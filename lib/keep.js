// A SCHEDULE ANOTHER PRODUCT OWNS, kept as an ordinary job.
//
// A workflow with "On a schedule" as its trigger is started by a job: the
// workflow engine tells its host "this workflow should run on this cron", the
// host passes that here, and from then on the schedule is a row in `jobs` like
// any other — on the Jobs screen, paused and resumed there, run by the one
// scheduler. There is no second clock anywhere.
//
//   keepSchedule(id, spec)          create the job, or bring it up to date
//   keepSchedule(id, null)          remove it (the trigger is gone or off)
//   keepSchedule(id, spec, { system: true })
//                                   a job of the install itself, belonging to
//                                   no tenant (the workflow engine's "do what
//                                   is due" job)
//
// spec: { name, description?, actionName, inputs?, cron, timezone? }
//
// BY ID, so keeping it twice is keeping it once: the caller picks an id it can
// find again (the workflow engine uses the workflow's own id).
//
// WHAT IT NEVER CHANGES on a job that is already there: `status`. Somebody who
// paused it on the Jobs screen paused it; saving the workflow again must not
// quietly start it again. nextRunAt is worked out again only when the cron or
// the time zone changed, so a re-save does not move a run that is due.
//
// In the caller's tenant context (a workflow is saved by somebody in a
// company), like trigger(). A system job is read and written across tenants
// and carries no tenant of its own.
var jobsDb = require('./db');
var { computeNextRun } = require('./cron');

var ALL = '*';

function refuse(message) {
  var err = new Error(message);
  err.code = 'SCHEDULE_INVALID';
  err.status = 400;
  return err;
}

function fieldsOf(spec) {
  var cron = String(spec.cron == null ? '' : spec.cron).trim();
  if (!cron) throw refuse('A schedule needs a cron expression, e.g. "0 9 * * 1".');
  if (!spec.name) throw refuse('A schedule needs a name, for the Jobs screen.');
  if (!spec.actionName) throw refuse('A schedule needs the action it runs.');
  var timezone = spec.timezone ? String(spec.timezone) : null;
  var next;
  try { next = computeNextRun(cron, null, timezone); } catch (err) {
    throw refuse('"' + cron + '"' + (timezone ? ' in ' + timezone : '') + ' is not a schedule this can read: ' + err.message);
  }
  return {
    fields: {
      name: String(spec.name).slice(0, 255),
      description: spec.description || null,
      actionName: spec.actionName,
      inputs: spec.inputs || {},
      schedule: cron,
      timezone: timezone
    },
    nextRunAt: next.toISOString()
  };
}

async function keepSchedule(id, spec, opts) {
  if (!id) throw refuse('keepSchedule needs the id to keep the job under.');
  var system = Boolean(opts && opts.system);
  var Job = jobsDb.boundModels().Job;
  var knex = Job.knex();
  function q() { return system ? Job.unscopedQuery() : Job.query(); }

  var row = await q().findById(id);
  // Found by id alone: a row the scoped read above cannot see. Deleted on the
  // Jobs screen (a soft delete) is made new again; anything else is somebody
  // else's, and is refused rather than overwritten.
  var hidden = row ? null : await knex('jobs').where({ id: id }).first();

  if (!spec) {
    if (row) await q().deleteById(id);
    else if (hidden && hidden.isActive === false) await knex('jobs').where({ id: id, isActive: false }).del();
    return null;
  }

  var made = fieldsOf(spec);

  if (row) {
    if (Boolean(row.system) !== system) {
      throw refuse('Job ' + id + (row.system ? ' is a system job, kept only as one.' : ' is an ordinary job, not a system one.'));
    }
    // Said every time, so the model does not work it out again from now: a
    // run that is due and not yet picked stays due.
    var same = row.schedule === made.fields.schedule && (row.timezone || null) === made.fields.timezone;
    var patch = Object.assign({}, made.fields, {
      nextRunAt: same && row.nextRunAt ? new Date(row.nextRunAt).toISOString() : made.nextRunAt
    });
    await q().findById(id).patch(patch);
    return q().findById(id);
  }

  if (hidden) {
    if (hidden.isActive !== false) throw refuse('Job ' + id + ' belongs to someone else.');
    await knex('jobs').where({ id: id, isActive: false }).del();
  }

  if (system) {
    // EVERY company's ('*'), so every Jobs screen lists it and its runs, and
    // the executor's tenant-scoped lock and run rows work as for any job (a
    // row of no tenant would be skipped there, every time, saying nothing).
    // `system` makes the routes refuse to change it (migrations/0012).
    return Job.unscopedQuery().insertAndFetch(Object.assign({}, made.fields, {
      id: id,
      status: 'ready',
      running: false,
      system: true,
      nextRunAt: made.nextRunAt,
      mtId1: ALL, mtId2: ALL, mtId3: ALL, mtId4: ALL
    }));
  }

  return Job.query().insertAndFetch(Object.assign({}, made.fields, {
    id: id,
    status: 'ready',
    running: false,
    nextRunAt: made.nextRunAt
  }));
}

module.exports = { keepSchedule: keepSchedule };
