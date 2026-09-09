// Jobs — the pure bits. Reading a cron expression, describing a run, and
// deciding what a job's state actually IS.
//
// Separate from the component because every one of these is a claim that can
// be wrong in a way a screenshot will not show you: "next run in 3 hours" when
// it is 3 days, "succeeded" over a job that failed and retried.

/** A job is not one flag but three, and the UI needs the combination. */
export function jobState(job) {
  if (!job) return 'unknown'
  // RUNNING WINS. A paused job that is mid-run is running — the pause takes
  // effect at the next pick, and saying "paused" over a live action invites
  // somebody to start a second one.
  if (job.running) return 'running'
  if (job.status === 'pause') return 'paused'
  if (!job.schedule) return 'manual'
  return 'scheduled'
}

export const STATE_LABELS = {
  running: 'Running',
  paused: 'Paused',
  manual: 'Manual only',
  scheduled: 'Scheduled',
  unknown: 'Unknown'
}

/**
 * A cron expression, in English — for the five-field expressions people
 * actually write. Anything else comes back null and the caller shows the
 * expression itself, which is honest: a wrong plain-English reading of a cron
 * is worse than the cron, because you cannot tell it is wrong.
 */
export function describeCron(expr) {
  if (!expr || typeof expr !== 'string') return null
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) return null
  const [min, hour, dom, mon, dow] = f

  const every = (v) => v === '*'
  const num = (v) => (/^\d+$/.test(v) ? Number(v) : null)
  const at = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

  // */n in the minute field — the commonest schedule anybody writes.
  const stepMin = /^\*\/(\d+)$/.exec(min)
  if (stepMin && every(hour) && every(dom) && every(mon) && every(dow)) {
    const n = Number(stepMin[1])
    return n === 1 ? 'Every minute' : `Every ${n} minutes`
  }

  const stepHour = /^\*\/(\d+)$/.exec(hour)
  if (num(min) !== null && stepHour && every(dom) && every(mon) && every(dow)) {
    const n = Number(stepHour[1])
    return n === 1 ? `Every hour, at ${min} past` : `Every ${n} hours, at ${min} past`
  }

  if (every(min) && every(hour) && every(dom) && every(mon) && every(dow)) return 'Every minute'
  if (num(min) !== null && every(hour) && every(dom) && every(mon) && every(dow)) {
    return `Every hour, at ${min} past`
  }
  if (num(min) !== null && num(hour) !== null && every(dom) && every(mon) && every(dow)) {
    return `Every day at ${at(hour, min)}`
  }
  if (num(min) !== null && num(hour) !== null && every(dom) && every(mon) && num(dow) !== null) {
    return `Every ${DAYS[num(dow) % 7]} at ${at(hour, min)}`
  }
  if (num(min) !== null && num(hour) !== null && num(dom) !== null && every(mon) && every(dow)) {
    return `Monthly on day ${dom} at ${at(hour, min)}`
  }
  return null
}

/**
 * When the next run is due, as something a person reads.
 *
 * Deliberately says OVERDUE rather than "in -2 minutes". A due time in the
 * past means the scheduler has not picked it — paused, not running, or stuck
 * with `running` left true by a process that died — and that is worth seeing
 * rather than rendering as a negative number.
 */
export function nextRunLabel(value, now) {
  if (!value) return null
  const at = new Date(value).getTime()
  if (Number.isNaN(at)) return null
  const delta = at - (now || Date.now())
  if (delta <= 0) return 'due now'
  const mins = Math.round(delta / 60000)
  if (mins < 1) return 'in under a minute'
  if (mins < 60) return `in ${mins} minute${mins === 1 ? '' : 's'}`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `in ${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.round(hours / 24)
  return `in ${days} day${days === 1 ? '' : 's'}`
}

/** How long a run took. Sub-second matters here — most actions are quick. */
export function durationLabel(ms) {
  if (ms === null || ms === undefined) return null
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60000)
  const secs = Math.round((ms % 60000) / 1000)
  return `${mins}m ${secs}s`
}

/**
 * The last run of each job, keyed by job id.
 *
 * The LATEST by start time, not the last in the array — occurrences arrive in
 * whatever order the list endpoint returns them, and "the last one we were
 * sent" is not a fact about when anything ran.
 */
export function latestByJob(occurrences) {
  const out = {}
  ;(occurrences || []).forEach((o) => {
    if (!o || !o.jobId) return
    const prev = out[o.jobId]
    if (!prev || new Date(o.startedAt).getTime() > new Date(prev.startedAt).getTime()) out[o.jobId] = o
  })
  return out
}

/** Search and sort. No paging — a workspace's job list is short by nature. */
export function prepareJobs(jobs, { query = '', sort = 'name' } = {}) {
  const q = query.trim().toLowerCase()
  let rows = (jobs || []).filter((j) => {
    if (!q) return true
    // The ACTION is searched too: "which jobs push to the database" is a real
    // question, and the action is the answer to it.
    return [j.name, j.description, j.actionName].filter(Boolean).join(' ').toLowerCase().includes(q)
  })

  rows = rows.slice().sort((a, b) => {
    if (sort === 'next') {
      // Jobs with no next run sort LAST rather than first — a manual job is
      // not "due before everything else", it is simply not due.
      const at = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Infinity
      const bt = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Infinity
      return at - bt
    }
    if (sort === 'action') return String(a.actionName || '').localeCompare(String(b.actionName || ''))
    return String(a.name || '').localeCompare(String(b.name || ''))
  })

  return rows
}

/**
 * A running occurrence's progress, in words — or null when there is nothing
 * honest to say yet.
 *
 * ROWS READ, NOT A PERCENTAGE, and that is not a shortcut. The uploader counts
 * what it has read, because the write queue drains behind the read and waiting
 * for confirmation would report zero for minutes; and there is no denominator
 * to divide by, because a query source has no row count without running it
 * twice. A progress bar here would have to invent the total, and an invented
 * total is worse than a number that is simply true.
 *
 * Null while progress is absent — the first throttled write has not landed
 * yet, or the action reports nothing at all. Callers show "Running" on its own
 * rather than waiting for a number that may never come.
 */
export function progressLabel(occurrence) {
  const p = occurrence && occurrence.progress
  if (!p || p.rowsRead == null) return null
  return `${formatCount(p.rowsRead)} rows`
}

/** 1200 → "1.2K", 3400000 → "3.4M". Thousands separators past nine digits stop
 *  being readable at a glance, and a glance is all this gets. */
export function formatCount(n) {
  if (n == null || isNaN(n)) return '—'
  if (n < 1000) return String(n)
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}K`
  return `${(n / 1000000).toFixed(n < 10000000 ? 1 : 0)}M`
}

/**
 * Whether a live run has gone QUIET — reporting, then stopping.
 *
 * `progress.at` is the moment of the last update. A job that reported 400K
 * rows nine minutes ago and nothing since is not the same as one that reported
 * it two seconds ago, and the numbers alone cannot tell them apart. This is
 * what lets a row say "no update for 9m" instead of showing a stale count as
 * though it were current.
 *
 * Advisory only — a movement legitimately goes quiet during a long final
 * drain. It is a prompt to look, not a verdict.
 */
export function progressStale(occurrence, now = Date.now(), toleranceMs = 120000) {
  const at = occurrence && occurrence.progress && occurrence.progress.at
  if (!at) return false
  return now - new Date(at).getTime() > toleranceMs
}
