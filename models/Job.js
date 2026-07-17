var { BaseModel } = require('@xeplr/db');

class Job extends BaseModel {
  static get tableName() { return 'jobs'; }
  static get idColumn() { return 'id'; }
  static get multiTenant() { return false; }

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
        nextRunAt: { type: ['string', 'null'] },
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
