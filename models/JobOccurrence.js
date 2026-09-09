var { BaseModel } = require('@xeplr/db');

class JobOccurrence extends BaseModel {
  static get tableName() { return 'jobOccurrences'; }
  static get idColumn() { return 'id'; }

  // Scoped like its Job, and for the same reason — an occurrence carries the
  // action's INPUT and OUTPUT, which is the tenant's data rather than a
  // timestamp. See Job.js; mtLevels is deliberately unset there too.
  //
  // The executor is what fills these in: it runs each job inside its own
  // tenant context, so every insert here picks the values up from
  // $beforeInsert without the row having to be told. See lib/execute.js.

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['id', 'jobId', 'status', 'startedAt', 'triggeredBy'],
      properties: {
        id: { type: 'string', maxLength: 25 },
        jobId: { type: 'string', maxLength: 25 },
        status: { type: 'string', maxLength: 20 },
        startedAt: { type: 'string' },
        endedAt: { type: ['string', 'null'] },
        input: { type: ['object', 'null'] },
        output: { type: ['object', 'null'] },
        error: { type: ['object', 'null'] },
        // Set only when a worker finished work that had already been timed
        // out — the signal that this job's tolerance is too low, and by how
        // much. See migrations/0005_late_finish.js.
        lateFinish: { type: ['object', 'null'] },
        // Live counters while the run is in flight — { rowsRead, batches, at }
        // for a movement. Written throttled by the executor, never by the
        // action itself. See migrations/0007.
        progress: { type: ['object', 'null'] },
        // Where to POST this occurrence's outcome when it reaches a terminal
        // state. Null for a run nobody is waiting on. See migrations/0008.
        callbackUrl: { type: ['string', 'null'] },
        retryCount: { type: 'integer' },
        triggeredBy: { type: 'object' },
        durationMs: { type: ['integer', 'null'] },
        isActive: { type: 'boolean' },
        recordCreatedDate: { type: ['string', 'null'] },
        recordModifiedDate: { type: ['string', 'null'] },
        recordCreatedBy: { type: ['string', 'null'], maxLength: 25 },
        recordModifiedBy: { type: ['string', 'null'], maxLength: 25 }
      }
    };
  }

  static get relationMappings() {
    var Job = require('./Job');
    return {
      job: {
        relation: BaseModel.BelongsToOneRelation,
        modelClass: Job,
        join: { from: 'jobOccurrences.jobId', to: 'jobs.id' }
      }
    };
  }
}

module.exports = JobOccurrence;
