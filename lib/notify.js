// TELLING WHOEVER IS WAITING THAT A RUN HAS ENDED.
//
// One function, called from every path that writes a terminal status —
// success, failure, the lock refusing, the reaper timing a run out, and the
// shutdown sweep marking one interrupted. MISSING ANY ONE OF THEM IS THE BUG
// THIS FILE EXISTS TO AVOID: a workflow step parked on a resume key waits for
// a callback that never comes, and there is nothing anywhere that says why.
// "It only reports success" is the same as not reporting at all, because a
// chain that only advances when nothing goes wrong is a chain nobody can rely
// on.
//
// THE ENVELOPE IS DELIBERATELY GENERIC.
//
//   { output: { status, jobId, occurrenceId, startedAt, endedAt, durationMs,
//               output, error } }
//
// Wrapped in `output` because the receiving end is @xeplr/workflow's
// POST /public/resume/:key, whose whole contract is "the key, plus whatever
// the resolution carries". Jobs does not import workflow and does not know
// what a step is — it POSTs a description of what happened to a URL it was
// given. Anything that can receive JSON can be that URL.
//
// STATUS IS IN THE BODY, NOT IN THE HTTP CODE. The callback SUCCEEDS (200) when
// it successfully reports a FAILURE. Those are two different questions and
// collapsing them is how a receiver ends up retrying a job that definitively
// failed.

var MAX_ATTEMPTS = 3;
var RETRY_MS = 2000;
var TIMEOUT_MS = 10000;

/**
 * POST an occurrence's outcome to its callback URL. Never throws.
 *
 * RETRIED, unlike the progress writes, and the asymmetry is the point:
 * progress is a gauge where the next value supersedes the last, so a dropped
 * update costs nothing. This is the ONLY message that will ever be sent about
 * this run. Dropping it strands whatever is waiting.
 *
 * Three attempts and then a loud log. Not infinite: a callback URL can be
 * permanently gone (the workflow deleted, the host moved), and a worker
 * retrying that forever is a worker not doing anything else. What is left
 * behind is an error a person can act on, plus an occurrence row that already
 * holds the full outcome — so the run is recoverable by hand.
 */
async function notifyCallback(occurrence, log) {
  var url = occurrence && occurrence.callbackUrl;
  if (!url) return false;

  // DID THE WORK HAPPEN — the receiver's first question, answered at the top
  // level rather than buried in the payload.
  //
  // A workflow step must fail when its job failed, and it cannot be asked to
  // pattern-match on jobs' own vocabulary to find that out. Which of
  // success / failed / skipped / timedOut / interrupted count as "the work
  // happened" is a question only THIS package can answer, so it answers it
  // here and sends the verdict. The full status is still in the payload for
  // anyone who wants to tell a timeout from a refusal.
  var ok = occurrence.status === 'success';

  var body = JSON.stringify({
    status: ok ? 'success' : 'failed',
    error: ok ? null : (occurrence.error || {
      name: 'JobNotCompleted',
      message: 'The job ended as "' + occurrence.status + '" rather than completing.'
    }),
    output: {
      status:       occurrence.status,
      jobId:        occurrence.jobId,
      occurrenceId: occurrence.id,
      startedAt:    occurrence.startedAt || null,
      endedAt:      occurrence.endedAt || null,
      durationMs:   occurrence.durationMs != null ? occurrence.durationMs : null,
      // The action's own return value — for a movement, { totalRows, window,
      // movementId, ... }. THE WINDOW IN PARTICULAR is why a downstream step
      // can act on exactly the rows this run moved rather than on the period
      // somebody declared at the top: it is what the job ACTUALLY covered.
      output:       occurrence.output || null,
      error:        occurrence.error || null
    }
  });

  for (var attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      var controller = new AbortController();
      var timer = setTimeout(function() { controller.abort(); }, TIMEOUT_MS);
      // .unref() so a callback in flight cannot hold the process open during a
      // shutdown — the same rule every other timer in this package follows.
      if (timer.unref) timer.unref();
      var res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) return true;

      // 4xx is NOT retried. A resume key that has already been consumed
      // answers 400 "already used or not valid", and that is a settled
      // answer — retrying it twice more cannot change it and only delays the
      // log line that says what happened. 5xx is the receiver being briefly
      // unwell, which is exactly what retries are for.
      if (res.status >= 400 && res.status < 500) {
        log.important('Job ' + occurrence.jobId + ' occurrence ' + occurrence.id +
          ' callback refused by ' + url + ' (' + res.status + '). Not retrying — ' +
          'the receiver gave a settled answer, usually a resume key already used.');
        return false;
      }
      throw new Error('callback returned ' + res.status);
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        // ERROR level on purpose: this is the sink that puts a row on the
        // universal error screen, and something is now waiting on a message
        // that will never arrive. The occurrence row holds the full outcome,
        // so it can be delivered by hand.
        log.error('Job ' + occurrence.jobId + ' occurrence ' + occurrence.id +
          ' finished (' + occurrence.status + ') but its callback to ' + url +
          ' failed after ' + MAX_ATTEMPTS + ' attempts: ' + err.message +
          ' — whatever was waiting on this run has not been told.');
        return false;
      }
      await new Promise(function(resolve) {
        var t = setTimeout(resolve, RETRY_MS * attempt);
        if (t.unref) t.unref();
      });
    }
  }
  return false;
}

module.exports = { notifyCallback: notifyCallback };
