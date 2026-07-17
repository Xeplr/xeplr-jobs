// Resolve a param mapping against a source occurrence's output.
// Mapping shape: { targetParamName: 'context.foo.bar' | 'data.x.y' }
// Source shape:  { context: {...}, data: {...} }

function getPath(obj, path) {
  if (obj == null || !path) return undefined;
  var parts = String(path).split('.');
  var cur = obj;
  for (var i = 0; i < parts.length; i++) {
    if (cur == null) return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

function resolveMapping(mapping, sourceOutput) {
  var out = {};
  if (!mapping) return out;
  var keys = Object.keys(mapping);
  for (var i = 0; i < keys.length; i++) {
    out[keys[i]] = getPath(sourceOutput, mapping[keys[i]]);
  }
  return out;
}

module.exports = { resolveMapping, getPath };
