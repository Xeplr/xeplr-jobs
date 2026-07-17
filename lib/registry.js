// In-process registry of Job Type executors. Consuming apps call
// registerExecutor(name, fn) at startup; the scheduler looks up the
// executor by the Job's jobType.name at run time.

var _executors = new Map();

function registerExecutor(jobTypeName, fn) {
  if (typeof jobTypeName !== 'string' || !jobTypeName) {
    throw new Error('registerExecutor: jobTypeName must be a non-empty string');
  }
  if (typeof fn !== 'function') {
    throw new Error('registerExecutor: fn must be a function');
  }
  _executors.set(jobTypeName, fn);
}

function getExecutor(jobTypeName) {
  return _executors.get(jobTypeName);
}

function listRegistered() {
  return Array.from(_executors.keys());
}

function clear() {
  _executors.clear();
}

module.exports = { registerExecutor, getExecutor, listRegistered, clear };
