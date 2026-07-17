var { BaseModel } = require('@xeplr/db');

class JobOccurrence extends BaseModel {
  static get tableName() { return 'jobOccurrences'; }
  static get idColumn() { return 'id'; }
  static get multiTenant() { return false; }

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
