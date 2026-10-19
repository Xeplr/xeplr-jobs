// WHAT EVERY RUN OF A JOB RECEIVES — a fixed contract.
//
// A run covers a period: its WINDOW, a start and an end. It comes from the
// job's own schedule ("since the last successful run", incrementalMode
// 'period') or from whoever started it — above all the job before it in a
// chain, which hands over the period it ran for.
//
// A run started by the job before it also receives THAT job's two ranges,
// fixed by what every job reports when it ends:
//
//   previous.given  the range the job before was given (its own window)
//   previous.used   the range it actually covered, as its action reported it
//                   (an incremental movement that started from the copy's
//                   highest value is given none, and reports where it read)
//
// Any of these may be absent; then the values are simply empty.
//
// Because the shape is fixed, a job's inputs BIND to it instead of asking for
// JSON: a procedure parameter whose value is `{window.from}` gets the start of
// this run's window. The form offers exactly these as choices
// (GET /jobs/run-contract), so nobody types a binding by hand.
//
// Only these names bind, nothing else: an input is the job author's text, and
// a general template language over the run would be a way to reach things a
// job has no business reading.

var CONTRACT = [
  { key: 'window.from', group: 'This run', label: 'Start of the window',
    description: 'Where the period this run covers begins (included).' },
  { key: 'window.to', group: 'This run', label: 'End of the window',
    description: 'Where it ends (not included) — the next period starts exactly here.' },
  { key: 'previous.given.from', group: 'The job before', label: 'Given range: start',
    description: 'The start of the range the job before was given.' },
  { key: 'previous.given.to', group: 'The job before', label: 'Given range: end',
    description: 'The end of the range the job before was given.' },
  { key: 'previous.used.from', group: 'The job before', label: 'Used range: start',
    description: 'Where the job before actually started reading.' },
  { key: 'previous.used.to', group: 'The job before', label: 'Used range: end',
    description: 'Where it actually stopped (empty when it read to the end).' }
];

var KEYS = CONTRACT.map(function(c) { return c.key; });
var NAME = '(' + KEYS.map(function(k) { return k.replace(/\./g, '\\.'); }).join('|') + ')';
var TOKEN = new RegExp('\\{\\s*' + NAME + '\\s*\\}', 'g');
var WHOLE = new RegExp('^\\{\\s*' + NAME + '\\s*\\}$');

function valueOf(context, key) {
  var v = key.split('.').reduce(function(o, part) { return o == null ? undefined : o[part]; }, context);
  return v === undefined ? null : v;
}

/** Whether a value binds to the contract anywhere. */
function usesWindowBinding(value) {
  if (typeof value === 'string') { TOKEN.lastIndex = 0; var hit = TOKEN.test(value); TOKEN.lastIndex = 0; return hit; }
  if (Array.isArray(value)) return value.some(usesWindowBinding);
  if (value && typeof value === 'object') return Object.keys(value).some(function(k) { return k !== 'window' && usesWindowBinding(value[k]); });
  return false;
}

/**
 * The run's inputs with every contract binding filled in, against
 * `context` = { window, previous: { given, used } }.
 *
 * A string that is exactly one binding takes the value as it is (null when it
 * is absent, so the parameter is passed empty); one inside other text is
 * replaced as text. Objects and lists are walked; everything else is returned
 * unchanged. The `window` input itself is left as it is.
 *
 * `context` may also be a bare window, as it was before `previous` existed.
 */
function bindRunValues(value, context) {
  if (context && !('window' in context) && !('previous' in context)) context = { window: context };
  if (typeof value === 'string') {
    var whole = WHOLE.exec(value);
    if (whole) return valueOf(context, whole[1]);
    if (!usesWindowBinding(value)) return value;
    return value.replace(TOKEN, function(_, key) {
      var v = valueOf(context, key);
      return v == null ? '' : String(v);
    });
  }
  if (Array.isArray(value)) return value.map(function(v) { return bindRunValues(v, context); });
  if (value && typeof value === 'object') {
    var out = {};
    Object.keys(value).forEach(function(k) { out[k] = k === 'window' ? value[k] : bindRunValues(value[k], context); });
    return out;
  }
  return value;
}

module.exports = { CONTRACT: CONTRACT, bindRunValues: bindRunValues, usesWindowBinding: usesWindowBinding };
