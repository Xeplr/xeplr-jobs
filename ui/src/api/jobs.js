import { authFetch } from '@xeplr/ui-account'

// WHERE THE JOBS API LIVES, set once by the host at registration.
//
// The router mounts at the API ROOT ('/jobs', '/job-occurrences', '/actions' —
// see lib/jobRouter.js), so this is empty for every host that mounts it the
// normal way. It exists for the one that does not: a host free to mount the
// router under a prefix must be able to say so, and the alternative is this
// package hardcoding a path it does not control.
//
// Module-level rather than passed per call: it is a property of the
// deployment, fixed before the first request, and threading it through every
// function would put a parameter on each one that is the same value forever.
let API_BASE = ''

export function configureJobsApi(config) {
  API_BASE = (config && config.base) || ''
}

const url = (p) => API_BASE + p

// SCHEDULED JOBS — @xeplr/jobs, mounted at the API root (see the bottom of
// backend/routes/index.js).
//
// The trust boundary is the same one the rest of the product keeps: the client
// sends a job ID and the values a job was configured with. It never sends the
// action's implementation, a connection, or a credential — `actionName` is a
// reference into the server's registry, and what that name means is the
// server's business. A client that could post an executable step could run
// anything the registry offers, whatever the UI appears to allow.

/** Every job, newest change first. */
export async function listJobs() {
  const res = await authFetch(url('/jobs?limit=0'))
  return res.dataArray || []
}

/**
 * WHAT IS RUNNING RIGHT NOW — the small request a live screen repeats.
 *
 * Deliberately not listOccurrences() on a timer, which is what this page used
 * to do: that fetches EVERY occurrence ever recorded (`limit=0`) alongside the
 * job list and the action catalogue, three requests and an unbounded one among
 * them, every four seconds. This returns only occurrences still in flight —
 * bounded by the executor's concurrency cap, off an index that already exists
 * for the reaper — and carries each one's live progress.
 *
 * An empty array is the normal answer and the signal to slow down. See the
 * polling rule in Jobs.jsx.
 */
export async function listActiveRuns() {
  const res = await authFetch(url('/jobs/active'))
  return res.dataArray || []
}

/** The runs of a job — or of everything, if no id is given. */
export async function listOccurrences(jobId) {
  const res = await authFetch(url('/job-occurrences?limit=0'))
  const all = res.dataArray || []
  return jobId ? all.filter((o) => o.jobId === jobId) : all
}

// ── remote option lists ───────────────────────────────────────────────────
//
// An input field may name a KIND of thing to choose from — `optionsFrom:
// 'connections'` — and the host says once where that kind lives. This package
// never learns what a connection is, nor which URL BI serves them on; it knows
// only "fetch this list, show labels, store ids".
//
// One generic capability instead of a branch per concept. The next picker
// (a workspace, a folder) is an entry in the host's map, not a change here.
//
// Nothing configured for a kind → the field falls back to a plain text input.
// That is what keeps standalone jobs honest: an empty dropdown looks broken,
// while a text box is simply what you have when there is no catalogue.
let _optionSources = {}

export function configureOptionSources(sources) {
  _optionSources = sources || {}
}

export function hasOptionSource(kind) {
  return Boolean(_optionSources[kind])
}

/**
 * Fetch one option list.
 *
 * `dependsOn` is passed through as a query parameter so a dependent list can
 * be narrowed — databases on the chosen connection, rather than every database
 * on every connection.
 */
export async function fetchOptions(kind, filter) {
  const src = _optionSources[kind]
  if (!src) return []
  const q = filter && filter.value ? `&${encodeURIComponent(filter.name)}=${encodeURIComponent(filter.value)}` : ''
  const res = await authFetch(url(`${src.url}?limit=0${q}`))
  // `dataArray` is what genericRoute returns, so it is the default — but a
  // hand-written endpoint answers with whatever it likes (BI's
  // /warehouse/tables says `tables`). The host names the key rather than this
  // package guessing, because guessing wrong yields an empty dropdown and no
  // error, which reads as "you have none of these".
  const rows = res[src.key || 'dataArray'] || []
  return rows
    .filter((r) => (filter && filter.clientKey ? r[filter.clientKey] === filter.value : true))
    .map((r) => ({ value: r[src.value || 'id'], label: r[src.label] || r[src.value || 'id'] }))
}

/**
 * ONE job's run history, newest first, bounded.
 *
 * Deliberately not listOccurrences(jobId) above, which fetches every
 * occurrence of every job and filters in the browser. That is tolerable for
 * the one-row-per-job summary the table needs; it is not how you open a run
 * history, because the answer grows forever while the question does not.
 */
export async function listJobOccurrences(jobId, limit = 50) {
  const res = await authFetch(url(`/jobs/${encodeURIComponent(jobId)}/occurrences?limit=${limit}`))
  return res.dataArray || []
}

/**
 * The actions a job may name.
 *
 * Served from the server's own registry, which is also what the runner
 * validates against — so the dropdown cannot offer something that will not
 * run, and cannot miss something that would. See backend/db/jobsSetup.js for
 * which built-ins this product actually offers, and why it is a whitelist.
 */
export async function listJobActions() {
  const res = await authFetch(url('/actions'))
  return res.dataArray || []
}

/**
 * Create or update. The generic route's rules: no id → insert, id → patch,
 * id + deleted → soft delete.
 */
export async function saveJob(job) {
  return authFetch(url('/jobs/save'), {
    method: 'POST',
    body: JSON.stringify([job])
  })
}

export async function deleteJob(id) {
  return authFetch(url('/jobs/delete'), {
    method: 'POST',
    body: JSON.stringify({ ids: [id] })
  })
}

/** Run it now — one manual occurrence, regardless of the schedule. */
export async function triggerJob(id) {
  return authFetch(url(`/jobs/${id}/trigger`), { method: 'POST' })
}

// Pausing sets status to 'pause', which is what the scheduler's picker skips.
// It does NOT stop a run already going: the job is picked or it isn't, and one
// that has started is somewhere in an action this has no handle on.
export async function pauseJob(id) {
  return authFetch(url(`/jobs/${id}/pause`), { method: 'POST' })
}

export async function resumeJob(id) {
  return authFetch(url(`/jobs/${id}/resume`), { method: 'POST' })
}

/**
 * ONE occurrence's log lines, by the LOGGING KEY.
 *
 * The key is the occurrenceId itself: an action that logs is expected to write
 * under the referenceId it was handed in `system` (see lib/execute.js's
 * buildActionCall), so the lines are already stored under an id this side
 * knows. Nothing here has to learn what the action actually did — a movement,
 * a build, anything — which is the whole point of keying logs by the work
 * rather than by the table that produced them.
 *
 * NOT under API_BASE: /logs is the platform's own generic log route, not part
 * of the jobs router. A host that has no such route answers 404 and the panel
 * says there are no lines — which is the truth for an action that never wrote
 * any, and the same thing this package would show either way.
 */
export async function fetchOccurrenceLogs(occurrenceId) {
  const res = await authFetch(`/logs?referenceId=${encodeURIComponent(occurrenceId)}`)
  return res.dataArray || []
}
