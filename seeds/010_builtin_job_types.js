// Built-in JobType templates shipped with @xeplr/jobs.
// Idempotent: upsert by name — running again refreshes the configSchema
// (safe to run after every seed evolution).
//
// These seed the METADATA that the UI reads to render job-creation forms.
// The EXECUTORS themselves (the code that runs when a Job of one of these
// types fires) are separate — consumers must jobs.registerExecutor(name, fn)
// for each type they want to actually run.

var now = new Date().toISOString();

var JOB_TYPES = [
  {
    id: 'builtinJobTypeApiXxxxxxxx',
    name: 'api',
    description: 'Generic HTTP API caller — GET/POST/etc. with optional auth pre-call and optional DB upload.',
    configSchema: [
      { name: 'url',              type: 'string',  required: true, order: 1,
        description: 'Target URL (templated). Vars: {sourceDate}, {targetDate}, {system.*}' },
      { name: 'method',           type: 'string',  required: true, default: 'GET', order: 2,
        description: 'GET | POST | PUT | DELETE | PATCH' },
      { name: 'headers',          type: 'object',  default: {},  order: 3,
        description: 'Request headers (values templated).' },
      { name: 'body',             type: 'string',  default: '',  order: 4,
        description: 'Request body for POST/PUT/PATCH (templated).' },

      // Auth pre-call — leave authUrl empty to skip
      { name: 'authUrl',          type: 'string',  default: '',  order: 10,
        description: 'Auth token endpoint. Empty = no pre-call.' },
      { name: 'authMethod',       type: 'string',  default: 'POST', order: 11 },
      { name: 'authBody',         type: 'string',  default: '',  order: 12,
        description: 'Auth request body (templated).' },
      { name: 'authTokenPath',    type: 'string',  default: 'access_token', order: 13,
        description: 'Dotted path to the token in the auth response.' },
      { name: 'authHeaderName',   type: 'string',  default: 'Authorization', order: 14 },
      { name: 'authHeaderPrefix', type: 'string',  default: 'Bearer ', order: 15 },

      // Optional DB upload
      { name: 'uploadToDB',       type: 'boolean', default: false, order: 20 },
      { name: 'tableName',        type: 'string',  default: '',  order: 21,
        description: 'Target table (required when uploadToDB=true).' },
      { name: 'responseRowsPath', type: 'string',  default: '',  order: 22,
        description: 'Dotted path to the rows array. Empty = the whole response IS the array.' },

      // Incremental window
      { name: 'isIncremental',    type: 'boolean', default: false, order: 30 },
      { name: 'sourceDate',       type: 'string',  default: '',  order: 31,
        description: 'Available in templates as {sourceDate}.' },
      { name: 'targetDate',       type: 'string',  default: '',  order: 32,
        description: 'Available in templates as {targetDate}.' }
    ]
  },

  {
    id: 'builtinJobTypeSpawnXxxxxx',
    name: 'spawnable-program',
    description: 'Spawns an external program (node/python/sh/etc.) and captures its outcome. ' +
                 'Program signals status via stdout: "success" or "error"/"failure" on its own line; ' +
                 'lines prefixed "job-log:" are captured as log entries. Programs are expected to ' +
                 'write any business data themselves (e.g. to a DB).',
    configSchema: [
      { name: 'command',   type: 'string', required: true, order: 1,
        description: 'Executable (e.g. node, python, sh).' },
      { name: 'args',      type: 'array',  default: [], order: 2,
        description: 'Argument list, e.g. ["./programs/etl.js", "--config", "prod"].' },
      { name: 'cwd',       type: 'string', default: '', order: 3,
        description: 'Working directory (empty = process cwd).' },
      { name: 'env',       type: 'object', default: {}, order: 4,
        description: 'Extra env vars, merged onto the parent process env.' },
      { name: 'timeoutMs', type: 'number', default: 300000, order: 5,
        description: 'Kill after this many ms (default 5 min).' }
    ]
  },

  {
    id: 'builtinJobTypeMoverXxxxxx',
    name: 'data-mover',
    description: 'Moves rows from a source (table/query/procedure) into a target table. ' +
                 'Requires the incrementalInfo table for isIncremental=true, and the (planned) ' +
                 'dataConnections table when using sourceInfoId/targetInfoId. Inline ...Info ' +
                 'objects work today.',
    configSchema: [
      // Source connection — provide EITHER sourceInfoId OR sourceInfo (enforced at run time)
      { name: 'sourceInfoId',       type: 'string', default: '', order: 1,
        description: 'Reference to dataConnections row.' },
      { name: 'sourceInfo',         type: 'object', default: {}, order: 2,
        description: 'Inline connection: { kind, host, user, password, database, ... }.' },
      { name: 'sourceKind',         type: 'string', required: true, default: 'table', order: 3,
        description: 'table | query | procedure' },
      { name: 'sourceTable',        type: 'string', default: '', order: 4,
        description: 'Table name — required if sourceKind=table.' },
      { name: 'sourceQuery',        type: 'string', default: '', order: 5,
        description: 'Templated SQL — required if sourceKind=query. Vars: {sourceDate}, {targetDate}, {watermark.*}, {system.*}' },
      { name: 'sourceProcedure',    type: 'string', default: '', order: 6,
        description: 'Templated procedure call — required if sourceKind=procedure.' },

      // Target connection — provide EITHER targetInfoId OR targetInfo
      { name: 'targetInfoId',       type: 'string', default: '', order: 10 },
      { name: 'targetInfo',         type: 'object', default: {}, order: 11 },
      { name: 'targetTable',        type: 'string', required: true, order: 12 },

      // Movement mode
      { name: 'movementMode',       type: 'string', required: true, default: 'upsert', order: 20,
        description: 'append | upsert | replace' },
      { name: 'upsertKey',          type: 'array',  default: [], order: 21,
        description: 'Column names for ON CONFLICT — required if movementMode=upsert.' },

      // Incremental — rejected at save time if movementMode=replace
      { name: 'isIncremental',      type: 'boolean', default: false, order: 30,
        description: 'Rejected at save if movementMode=replace.' },
      { name: 'incrementalColumns', type: 'array',   default: [], order: 31,
        description: 'Column names to watermark. Values live in the framework-managed incrementalInfo table.' }
    ]
  }
];

exports.seed = async function(knex) {
  for (var i = 0; i < JOB_TYPES.length; i++) {
    var jt = JOB_TYPES[i];
    await knex('jobTypes')
      .insert({
        id: jt.id,
        name: jt.name,
        description: jt.description,
        configSchema: JSON.stringify(jt.configSchema),
        isActive: true,
        recordCreatedDate: now,
        recordModifiedDate: now
      })
      .onConflict('name')
      .merge({
        description: jt.description,
        configSchema: JSON.stringify(jt.configSchema),
        recordModifiedDate: now,
        isActive: true
      });
  }
};
