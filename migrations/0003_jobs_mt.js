// Tenancy for jobs and their occurrences.
//
// Both models declared `multiTenant = false` and these tables matched it by
// having no mtId columns — consistent, and wrong for any consumer with more
// than one tenant: a job created in one workspace was visible, editable and
// triggerable from every other.
//
// ALL FOUR COLUMNS, ALWAYS, whatever the consumer registers.
//
// The level count is the APP's decision, not this package's: registerMTs()
// derives it from how many contiguous slots the app supplies, and BaseModel's
// tenant modifier reads `modelClass.mtLevels ?? _mtConfig.levels`. So the
// models here deliberately do NOT set mtLevels — an app with one level
// enforces one, an app with two enforces two, and an app with no MT at all has
// `enabled: false`, no filtering happens, and these columns simply sit unused.
// Four nullable varchars cost nothing to carry; a package that guessed a level
// count would be wrong for everybody who guessed differently.
//
// EXISTING ROWS BECOME '*'. That is MT_ALL — the value BaseModel's filter
// treats as "matches every tenant" (`where mtId1 = ctx OR mtId1 = '*'`). Rows
// written before this migration have no tenant to attribute them to, and the
// two honest options are:
//
//   NULL — invisible to everyone the moment filtering turns on. Reads as data
//          loss, and a scheduled job would stop running with nothing to say why.
//   '*'  — visible to everyone, which is exactly what they were yesterday.
//
// '*' preserves today's behaviour rather than changing it as a side effect of a
// migration. Attributing them properly is a decision for whoever knows what
// they were for; this only has to avoid making it for them.

var LEVELS = [1, 2, 3, 4];

exports.up = async function(knex) {
  for (const table of ['jobs', 'jobOccurrences']) {
    await knex.schema.alterTable(table, function(t) {
      // 191, matching import_meta's mt columns in xeplr-db's config DB — wide
      // enough for any id the framework generates and short enough to index
      // under MySQL's key length limit.
      LEVELS.forEach(function(n) { t.string('mtId' + n, 191); });
    });
    await knex(table).update({ mtId1: '*', mtId2: '*', mtId3: '*', mtId4: '*' });
  }

  // The picker's index, REPLACED rather than added to.
  //
  // Its query is `status = ready AND running = false AND (nextRunAt IS NULL OR
  // nextRunAt <= now)`, and with tenancy on it also filters by tenant. Leading
  // with the tenant columns keeps the whole predicate on one index; leaving the
  // old index in place would have the planner choose between two partial
  // answers on the hottest query in the package.
  await knex.schema.alterTable('jobs', function(t) {
    t.dropIndex(['status', 'running', 'nextRunAt'], 'idx_jobs_picker');
    t.index(['mtId1', 'mtId2', 'status', 'running', 'nextRunAt'], 'idx_jobs_picker_mt');
  });

  // Occurrences are read per job and per tenant — the history list is
  // "everything that ran here", which without this is a scan.
  await knex.schema.alterTable('jobOccurrences', function(t) {
    t.index(['mtId1', 'mtId2', 'startedAt'], 'idx_job_occ_mt');
  });
};

exports.down = async function(knex) {
  await knex.schema.alterTable('jobs', function(t) {
    t.dropIndex(['mtId1', 'mtId2', 'status', 'running', 'nextRunAt'], 'idx_jobs_picker_mt');
    t.index(['status', 'running', 'nextRunAt'], 'idx_jobs_picker');
  });
  await knex.schema.alterTable('jobOccurrences', function(t) {
    t.dropIndex(['mtId1', 'mtId2', 'startedAt'], 'idx_job_occ_mt');
  });
  for (const table of ['jobs', 'jobOccurrences']) {
    await knex.schema.alterTable(table, function(t) {
      LEVELS.forEach(function(n) { t.dropColumn('mtId' + n); });
    });
  }
};
