var parser = require('cron-parser');

// Next scheduled run after `from` (default: now), read in `timezone` — a job's
// own (jobs.timezone, migrations/0011) — or the server's when it is blank.
// "0 9 * * 1" in Asia/Kolkata is 9:00 in Kolkata, wherever the server is.
// Throws on an invalid expression or an unknown zone.
function computeNextRun(cronExpr, from, timezone) {
  var opts = {};
  if (from) opts.currentDate = from;
  if (timezone) opts.tz = timezone;
  var interval = parser.parseExpression(cronExpr, opts);
  return interval.next().toDate();
}

function isValidCron(cronExpr, timezone) {
  try { parser.parseExpression(cronExpr, timezone ? { tz: timezone } : undefined); return true; }
  catch (_) { return false; }
}

module.exports = { computeNextRun, isValidCron };
