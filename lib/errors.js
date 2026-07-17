// TransientError is the placeholder for the retry-rules feature deferred to
// a later iteration. Today the framework does not act on it — occurrences
// that fail (transient or not) are marked 'failed'. Once retry policy lands,
// this signal will drive same-occurrence retries for connection-class errors.
class TransientError extends Error {
  constructor(message, opts) {
    super(message);
    this.name = 'TransientError';
    if (opts && opts.cause) this.cause = opts.cause;
  }
}

class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ValidationError';
    this.details = details || [];
  }
}

class ExecutorNotRegisteredError extends Error {
  constructor(jobTypeName) {
    super('No executor registered for job type: ' + jobTypeName);
    this.name = 'ExecutorNotRegisteredError';
    this.jobTypeName = jobTypeName;
  }
}

module.exports = { TransientError, ValidationError, ExecutorNotRegisteredError };
