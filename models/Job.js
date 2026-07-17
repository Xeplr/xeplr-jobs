var { BaseModel } = require('@xeplr/db');

class Job extends BaseModel {
  static get tableName() { return 'jobs'; }
  static get idColumn() { return 'id'; }
  static get multiTenant() { return false; }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['id', 'jobTypeId', 'name'],
      properties: {
        id: { type: 'string', maxLength: 25 },
        jobTypeId: { type: 'string', maxLength: 25 },
        name: { type: 'string', maxLength: 255 },
        description: { type: ['string', 'null'] },
        jobInputs: { type: ['object', 'null'] },
        status: { type: 'string', maxLength: 20 },
        running: { type: 'boolean' },
        schedule: { type: ['string', 'null'], maxLength: 100 },
        nextRunAt: { type: ['string', 'null'] },
        paramSchema: { type: ['array', 'null'] },
        outputSchema: { type: ['object', 'null'] },
        outputSchemaMode: { type: 'string', maxLength: 20 },
        isActive: { type: 'boolean' },
        recordCreatedDate: { type: ['string', 'null'] },
        recordModifiedDate: { type: ['string', 'null'] },
        recordCreatedBy: { type: ['string', 'null'], maxLength: 25 },
        recordModifiedBy: { type: ['string', 'null'], maxLength: 25 }
      }
    };
  }

  $beforeInsert() {
    super.$beforeInsert();
    if (this.schedule && !this.nextRunAt) {
      try {
        var { computeNextRun } = require('../lib/cron');
        this.nextRunAt = computeNextRun(this.schedule).toISOString();
      } catch (_) { /* invalid cron → picker treats NULL as run-now, self-repairs */ }
    }
  }

  static get relationMappings() {
    var JobType = require('./JobType');
    var JobReactivity = require('./JobReactivity');
    var JobOccurrence = require('./JobOccurrence');
    return {
      jobType: {
        relation: BaseModel.BelongsToOneRelation,
        modelClass: JobType,
        join: { from: 'jobs.jobTypeId', to: 'jobTypes.id' }
      },
      downstreamLinks: {
        relation: BaseModel.HasManyRelation,
        modelClass: JobReactivity,
        join: { from: 'jobs.id', to: 'jobReactivity.sourceJobId' }
      },
      upstreamLinks: {
        relation: BaseModel.HasManyRelation,
        modelClass: JobReactivity,
        join: { from: 'jobs.id', to: 'jobReactivity.targetJobId' }
      },
      occurrences: {
        relation: BaseModel.HasManyRelation,
        modelClass: JobOccurrence,
        join: { from: 'jobs.id', to: 'jobOccurrences.jobId' }
      }
    };
  }
}

module.exports = Job;
