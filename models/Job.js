var { BaseModel } = require('@xeplr/db');

class Job extends BaseModel {
  static get tableName() { return 'jobs'; }
  static get idColumn() { return 'id'; }

  // TENANT-SCOPED, and the level count is the APP's to decide.
  //
  // `multiTenant = false` used to be here, which made a job created in one
  // workspace visible, editable and triggerable from every other.
  //
  // mtLevels is deliberately NOT set. Left null it means "however many levels
  // this app registered" — one for a consumer with one, two for a consumer
  // with company + workspace, none at all for a consumer that never called
  // registerMTs, where the modifier no-ops and the columns sit unused. A
  // package that pinned a level count would be wrong for everybody who chose
  // differently. See migrations/0003_jobs_mt.js.

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['id', 'name', 'actionName'],
      properties: {
        id: { type: 'string', maxLength: 25 },
        name: { type: 'string', maxLength: 255 },
        description: { type: ['string', 'null'] },
        actionName: { type: 'string', maxLength: 100 },
        inputs: { type: ['object', 'null'] },
        status: { type: 'string', maxLength: 20 },
        running: { type: 'boolean' },
        schedule: { type: ['string', 'null'], maxLength: 100 },
        // The zone `schedule` is read in (an IANA name). Null = the server's.
        // See migrations/0011.
        timezone: { type: ['string', 'null'], maxLength: 64 },
        // A job of the install itself (the workflow engine's due work),
        // listed to every company and changed by no one. See migrations/0012.
        system: { type: 'boolean' },
        // DERIVED, and rewritten on every save and every run — which is
        // exactly why startAt below cannot be folded into it.
        nextRunAt: { type: ['string', 'null'] },
        // AUTHORED once: the earliest this job may run at all. Null = as soon
        // as the schedule says.
        startAt: { type: ['string', 'null'] },
        // 0 = a failure is left failed. See the retry loop in lib/execute.js.
        retryLimit: { type: ['integer', 'null'], minimum: 0 },
        // Null = the scheduler's default (30). How long an occurrence may sit
        // at 'running' before the reaper calls it timedOut.
        timeoutMinutes: { type: ['integer', 'null'], minimum: 1 },
        // HOW FAR THE DATA HAS GOT — the `to` of the last window this job
        // successfully covered. Distinct from nextRunAt (when to fire, which
        // advances even on failure) and from an occurrence's endedAt (when the
        // process stopped). Advanced only on success, and only when the run
        // used the window this layer computed. See migrations/0006.
        coveredTo: { type: ['string', 'null'] },
        // null = not incremental. See migrations/0006 for why there is no
        // separate 'full'.
        incrementalMode: { type: ['string', 'null'], enum: [null, 'period', 'watermark'] },
        // 'watermark' only: re-read the last N days as well. See migrations/0010.
        reloadDays: { type: ['integer', 'null'], minimum: 1 },
        // Input keys a trigger (a chain, above all) may fill on this job, beyond
        // the router's overridableInputs. See migrations/0009.
        acceptsInputs: { type: ['array', 'null'], items: { type: 'string' } },
        isActive: { type: 'boolean' },
        recordCreatedDate: { type: ['string', 'null'] },
        recordModifiedDate: { type: ['string', 'null'] },
        recordCreatedBy: { type: ['string', 'null'], maxLength: 25 },
        recordModifiedBy: { type: ['string', 'null'], maxLength: 25 }
      }
    };
  }

  // acceptsInputs is the one field that widens what a caller may change, so it
  // is checked on every write rather than trusted from the form.
  $beforeValidate(jsonSchema, json, opt) {
    var problems = require('../lib/trigger').acceptsInputsProblems(json.acceptsInputs);
    if (problems.length) {
      throw this.constructor.createValidationError({ type: 'ModelValidation', message: problems.join(' ') });
    }
    return super.$beforeValidate ? super.$beforeValidate(jsonSchema, json, opt) : jsonSchema;
  }

  $beforeInsert() {
    super.$beforeInsert();
    if (this.schedule && !this.nextRunAt) {
      try {
        var { computeNextRun } = require('../lib/cron');
        this.nextRunAt = computeNextRun(this.schedule, null, this.timezone).toISOString();
      } catch (_) { /* invalid cron → picker treats NULL as run-now, self-repairs */ }
    }
  }

  // A SAVE THAT CHANGES WHEN IT RUNS moves its next run. The Jobs screen
  // sends the schedule and the time zone with every save; without this a new
  // cron, or a new zone, took effect only after the next run on the old one.
  // A caller that sets nextRunAt itself (keepSchedule, which keeps a due run
  // where it is) is left alone.
  $beforeUpdate(opt, ctx) {
    super.$beforeUpdate(opt, ctx);
    if (typeof this.schedule === 'string' && this.schedule && this.nextRunAt === undefined) {
      try {
        var { computeNextRun } = require('../lib/cron');
        this.nextRunAt = computeNextRun(this.schedule, null, this.timezone || null).toISOString();
      } catch (_) { /* an invalid cron is reported when it runs, as on insert */ }
    }
  }

  static get relationMappings() {
    var JobOccurrence = require('./JobOccurrence');
    return {
      occurrences: {
        relation: BaseModel.HasManyRelation,
        modelClass: JobOccurrence,
        join: { from: 'jobs.id', to: 'jobOccurrences.jobId' }
      }
    };
  }
}

module.exports = Job;
