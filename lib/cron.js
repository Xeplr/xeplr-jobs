var parser = require('cron-parser');

// Next scheduled run after `from` (default: now). Throws on invalid expr.
function computeNextRun(cronExpr, from) {
  var opts = from ? { currentDate: from } : undefined;
  var interval = parser.parseExpression(cronExpr, opts);
  return interval.next().toDate();
}

function isValidCron(cronExpr) {
  try { parser.parseExpression(cronExpr); return true; }
  catch (_) { return false; }
}

module.exports = { computeNextRun, isValidCron };
