// Output Schema — the declarative shape of what a Job produces. Stored on
// the Job as { context: {name: {type}}, data: {name: {type}} } and updated
// after each successful occurrence per the Job's outputSchemaMode:
//   manual  — never touched by the framework
//   learn   — union: add newly seen fields, keep everything already there
//   dynamic — replaced with the shape inferred from this occurrence

function inferType(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'date';
  return typeof v;
}

function schemaFromSection(section) {
  var out = {};
  if (!section || typeof section !== 'object') return out;
  var keys = Object.keys(section);
  for (var i = 0; i < keys.length; i++) {
    out[keys[i]] = { type: inferType(section[keys[i]]) };
  }
  return out;
}

/**
 * Return a fresh schema based on current + output + mode.
 * Never mutates inputs.
 */
function updateSchema(currentSchema, output, mode) {
  var current = currentSchema || { context: {}, data: {} };
  if (mode === 'manual') return current;

  var freshCtx  = schemaFromSection(output && output.context);
  var freshData = schemaFromSection(output && output.data);

  if (mode === 'dynamic') return { context: freshCtx, data: freshData };

  // learn (default) — union with existing
  var next = {
    context: Object.assign({}, current.context || {}),
    data:    Object.assign({}, current.data    || {})
  };
  var ctxKeys = Object.keys(freshCtx);
  for (var i = 0; i < ctxKeys.length; i++) {
    if (!next.context[ctxKeys[i]]) next.context[ctxKeys[i]] = freshCtx[ctxKeys[i]];
  }
  var dataKeys = Object.keys(freshData);
  for (var j = 0; j < dataKeys.length; j++) {
    if (!next.data[dataKeys[j]]) next.data[dataKeys[j]] = freshData[dataKeys[j]];
  }
  return next;
}

function schemasEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

module.exports = { updateSchema, schemasEqual, schemaFromSection, inferType };
