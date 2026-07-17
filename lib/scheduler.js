var { executeJob, initExecutorState, currentConcurrency, maxConcurrency } = require('./execute');

var _timer = null;
var _ticking = false;

/**
 * Start the scheduler loop.
 *
 * config:
 *   models         — { Job, JobOccurrence }
 *   intervalMs     — poll interval (default 5000)
 *   maxConcurrent  — soft cap on scheduled picks per tick (default 20)
 *   logger         — { info(), error() } (default: console)
 */
function startScheduler(config) {
  if (_timer) throw new Error('Scheduler already started');
  if (!config || !config.models) throw new Error('startScheduler requires config.models');

  var models = config.models;
  var interval = config.intervalMs || 5000;
  var log = normalizeLogger(config.logger);

  initExecutorState({ maxConcurrent: config.maxConcurrent || 20, logger: log });

  async function tick() {
    if (_ticking) return;
    _ticking = true;
    try {
      var capacity = maxConcurrency() - currentConcurrency();
      if (capacity <= 0) return;

      var nowIso = new Date().toISOString();
      var jobs = await models.Job.query()
        .where({ status: 'ready', running: false })
        .whereNotNull('schedule')
        .where(function() {
          this.whereNull('nextRunAt').orWhere('nextRunAt', '<=', nowIso);
        })
        .limit(capacity);

      for (var i = 0; i < jobs.length; i++) {
        executeJob(models, jobs[i], { type: 'cron' })
          .catch(function(err) { log.error('executeJob threw:', err); });
      }
    } catch (err) {
      log.error('Scheduler tick error:', err);
    } finally {
      _ticking = false;
    }
  }

  _timer = setInterval(tick, interval);
  tick();
  log.info('xeplr-jobs scheduler started (intervalMs=' + interval + ', maxConcurrent=' + (config.maxConcurrent || 20) + ')');
  return { stop: stopScheduler };
}

function stopScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

function normalizeLogger(logger) {
  if (logger && typeof logger.error === 'function') return logger;
  return {
    info:  function() { console.log.apply(console, arguments); },
    error: function() { console.error.apply(console, arguments); }
  };
}

module.exports = { startScheduler, stopScheduler };
