var { BaseModel } = require('@xeplr/db');

class JobReactivity extends BaseModel {
  static get tableName() { return 'jobReactivity'; }
  static get idColumn() { return 'id'; }
  static get multiTenant() { return false; }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['id', 'sourceJobId', 'targetJobId', 'paramMapping'],
      properties: {
        id: { type: 'string', maxLength: 25 },
        sourceJobId: { type: 'string', maxLength: 25 },
        targetJobId: { type: 'string', maxLength: 25 },
        paramMapping: { type: 'object' },
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
      source: {
        relation: BaseModel.BelongsToOneRelation,
        modelClass: Job,
        join: { from: 'jobReactivity.sourceJobId', to: 'jobs.id' }
      },
      target: {
        relation: BaseModel.BelongsToOneRelation,
        modelClass: Job,
        join: { from: 'jobReactivity.targetJobId', to: 'jobs.id' }
      }
    };
  }
}

module.exports = JobReactivity;
