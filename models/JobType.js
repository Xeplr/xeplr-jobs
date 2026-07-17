var { BaseModel } = require('@xeplr/db');

class JobType extends BaseModel {
  static get tableName() { return 'jobTypes'; }
  static get idColumn() { return 'id'; }
  static get multiTenant() { return false; }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['id', 'name'],
      properties: {
        id: { type: 'string', maxLength: 25 },
        name: { type: 'string', maxLength: 100 },
        description: { type: ['string', 'null'] },
        configSchema: { type: ['array', 'null'] },
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
      jobs: {
        relation: BaseModel.HasManyRelation,
        modelClass: Job,
        join: { from: 'jobTypes.id', to: 'jobs.jobTypeId' }
      }
    };
  }
}

module.exports = JobType;
