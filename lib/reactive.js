var { resolveMapping } = require('./mapping');

/**
 * Fire all reactive downstream jobs after a source occurrence succeeds.
 * Independent fan-in: every downstream link fires exactly once against
 * this source occurrence's output. Reactive fires bypass the scheduler's
 * concurrency cap; the per-job lock still applies (busy target → skipped).
 */
async function fireReactive(models, sourceJobId, sourceOccurrenceId, sourceOutput, groupingTag) {
  var Job = models.Job;
  var JobReactivity = models.JobReactivity;

  var links = await JobReactivity.query().where({ sourceJobId: sourceJobId });
  if (!links.length) return;

  var targetIds = links.map(function(l) { return l.targetJobId; });
  var targets = await Job.query()
    .whereIn('id', targetIds)
    .withGraphFetched('jobType');

  var byId = new Map();
  targets.forEach(function(t) { byId.set(t.id, t); });

  var executeJob = require('./execute').executeJob;

  for (var i = 0; i < links.length; i++) {
    var link = links[i];
    var target = byId.get(link.targetJobId);
    if (!target) continue;
    if (target.status !== 'ready') continue; // paused → silently skip

    var params = resolveMapping(link.paramMapping, sourceOutput);
    executeJob(models, target, {
      type: 'reactive',
      sourceJobId: sourceJobId,
      sourceOccurrenceId: sourceOccurrenceId,
      groupingTag: groupingTag,
      params: params
    }).catch(function() { /* swallowed — occurrence records the failure */ });
  }
}

module.exports = { fireReactive };
