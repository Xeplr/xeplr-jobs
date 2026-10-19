// WHAT EVERY RUN OF A JOB RECEIVES — a fixed contract.
//
// A run covers a period: its WINDOW, a start and an end. It comes from the
// job's own schedule ("since the last successful run", incrementalMode
// 'period') or from whoever started it — above all the job before it in a
// chain, which hands over the period it ran for. Either may be absent; then
// the values are simply empty.
//
// Because the shape is fixed, a job's inputs can BIND to it instead of asking
// for JSON: a procedure parameter whose value is `{window.from}` gets the
// start of this run's window. The form offers exactly these as choices
// (GET /jobs/run-contract), so nobody types a binding by hand.
//
// Only these names bind, nothing else: an input is the job author's text, and
// a general template language over the run would be a way to reach things a
// job has no business reading.

var CONTRACT = [
  { key: 'window.from', label: 'Start of the window',
    description: 'Where the period this run covers begins (included).' },
  { key: 'window.to', label: 'End of the window',
    description: 'Where it ends (not included) — the next period starts exactly here.' }
];

var TOKEN = /\{\s*(window\.(?:from|to))\s*\}/g;
var WHOLE = /^\{\s*(window\.(?:from|to))\s*\}$/;

function valueOf(window, key) {
  var field = key.split('.')[1];
  var v = window && window[field];
  return v === undefined ? null : v;
}

/**
 * The run's inputs with every `{window.from}` / `{window.to}` filled in.
 *
 * A string that is exactly one binding takes the value as it is (null when
 * the run has no window, so the parameter is passed empty); one inside other
 * text is replaced as text. Objects and lists are walked; everything else is
 * returned unchanged. The `window` input itself is left as it is.
 */
function bindRunValues(value, window) {
  if (typeof value === 'string') {
    var whole = WHOLE.exec(value);
    if (whole) return valueOf(window, whole[1]);
    if (!usesWindowBinding(value)) return value;
    return value.replace(TOKEN, function(_, key) {
      var v = valueOf(window, key);
      return v == null ? '' : String(v);
    });
  }
  if (Array.isArray(value)) return value.map(function(v) { return bindRunValues(v, window); });
  if (value && typeof value === 'object') {
    var out = {};
    Object.keys(value).forEach(function(k) { out[k] = k === 'window' ? value[k] : bindRunValues(value[k], window); });
    return out;
  }
  return value;
}

/** Whether a job's saved inputs bind the window anywhere. */
function usesWindowBinding(value) {
  if (typeof value === 'string') { TOKEN.lastIndex = 0; var hit = TOKEN.test(value); TOKEN.lastIndex = 0; return hit; }
  if (Array.isArray(value)) return value.some(usesWindowBinding);
  if (value && typeof value === 'object') return Object.keys(value).some(function(k) { return k !== 'window' && usesWindowBinding(value[k]); });
  return false;
}

module.exports = { CONTRACT: CONTRACT, bindRunValues: bindRunValues, usesWindowBinding: usesWindowBinding };
