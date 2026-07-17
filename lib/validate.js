var { ValidationError } = require('./errors');

// Runtime type checks. 'date' accepts either a Date instance or an
// ISO-parseable string. Everything else is a straight typeof check.
var TYPE_CHECKERS = {
  string:  function(v) { return typeof v === 'string'; },
  number:  function(v) { return typeof v === 'number' && !isNaN(v); },
  boolean: function(v) { return typeof v === 'boolean'; },
  date:    function(v) { return v instanceof Date || (typeof v === 'string' && !isNaN(Date.parse(v))); },
  object:  function(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); },
  array:   function(v) { return Array.isArray(v); }
};

/**
 * Apply a schema (array of field definitions) to a values object.
 * Returns a copy of `values` with defaults filled in.
 * Throws ValidationError listing every problem.
 *
 * Schema field:  { name, type, required, default, description, order }
 * Values:        { [name]: value }
 * Label:         'config' | 'params' — used in error messages
 */
function applySchema(schema, values, label) {
  values = values || {};
  label = label || 'field';
  var out = {};
  var errors = [];

  if (!Array.isArray(schema)) {
    // No schema declared → pass values through untouched.
    return Object.assign({}, values);
  }

  for (var i = 0; i < schema.length; i++) {
    var field = schema[i];
    var name = field.name;
    if (!name) continue;

    var val = values[name];
    var missing = val === undefined || val === null;

    if (missing && field.default !== undefined) {
      out[name] = field.default;
      continue;
    }
    if (missing) {
      if (field.required) errors.push('Missing required ' + label + ' field: ' + name);
      continue;
    }
    if (field.type && TYPE_CHECKERS[field.type] && !TYPE_CHECKERS[field.type](val)) {
      errors.push(label + ' field "' + name + '" expected type ' + field.type + ', got ' + typeof val);
      continue;
    }
    out[name] = val;
  }

  if (errors.length) throw new ValidationError(errors.join('; '), errors);
  return out;
}

module.exports = { applySchema, TYPE_CHECKERS };
