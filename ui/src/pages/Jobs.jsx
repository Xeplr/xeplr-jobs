import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { raiseConfirm, raiseSnackbar } from '@xeplr/ui-utils'
import { relativeTime } from './relativeTime.js'
import {
  listJobs, listOccurrences, listJobOccurrences, listJobActions, listActiveRuns,
  saveJob, deleteJob, triggerJob, pauseJob, resumeJob, fetchOccurrenceLogs,
  fetchOptions, hasOptionSource
} from '../api/jobs.js'
import {
  jobState, STATE_LABELS, describeCron, nextRunLabel, durationLabel,
  latestByJob, prepareJobs, progressLabel, progressStale
} from './jobsList.js'
import CronScheduleField from '../components/CronScheduleField.jsx'
import './Jobs.css'

// SCHEDULED JOBS — @xeplr/jobs, in this product's chrome.
//
// A job is a registered ACTION plus the inputs to call it with, plus optionally
// a cron expression. The scheduler picks what is due and hands it to
// @xeplr/actions; each attempt is recorded as an occurrence.
//
// The page shows both halves, because neither is useful alone: a list of jobs
// with no history cannot tell you a nightly job has been failing for a week,
// and a list of runs with no jobs cannot tell you what is meant to happen.
//
// NOT the same thing as the import history on the Upload page. That is a log of
// files that were loaded; this is a scheduler.

function StatePill({ state }) {
  return <span className={`jb-pill jb-pill--${state}`}>{STATE_LABELS[state] || state}</span>
}

// SIX STATUSES, not three. The executor and the reaper between them write
// running · success · failed · skipped · timedOut · interrupted, and this used
// to tone anything that was not success or failed as "busy" — so a job the
// reaper gave up on, and one abandoned by a deploy, both rendered in the same
// colour as one that is happily running right now. Three different situations,
// one appearance, and the two that need attention were the ones disguised.
const RUN_TONES = {
  success: 'good',
  failed: 'bad',
  timedOut: 'bad',
  interrupted: 'warn',
  skipped: 'warn',
  running: 'busy'
}
const RUN_LABELS = {
  timedOut: 'timed out',
  interrupted: 'interrupted',
  skipped: 'skipped'
}
const RUN_TITLES = {
  timedOut: 'Ran past its "give up after" and was given up on — the lock was released so the job could run again.',
  interrupted: 'The process shut down while this was running.',
  skipped: 'Not run — the previous occurrence was still going, or the action was not registered.'
}

function RunPill({ status }) {
  return (
    <span className={`jb-pill jb-pill--${RUN_TONES[status] || 'busy'}`} title={RUN_TITLES[status] || undefined}>
      {RUN_LABELS[status] || status}
    </span>
  )
}

/* SVG, not a text glyph.
 *
 * The expander was a '\u203a' rotated 90deg, and a chevron character carries its own
 * side bearings — rotated, that asymmetry becomes a visible lean inside a
 * round button, which no amount of centring the BOX can fix. A path is
 * symmetric about its own viewBox, so it lands where it looks like it should.
 */
function Icon({ path, size = 16 }) {
  return (
    <svg className="jb-icon" width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      {path}
    </svg>
  )
}

const ICON_CHEVRON = <polyline points="9 18 15 12 9 6" />
const ICON_RUN = <><polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none" /></>
const ICON_EDIT = <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>
const ICON_DELETE = <><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>

/**
 * ONE occurrence's log lines, under its own row.
 *
 * Fetched by referenceId — the occurrenceId — so this package never learns
 * what the action did. Whatever ran wrote its lines under the key it was
 * handed; this asks for that key back.
 *
 * Loaded on OPEN, not with the history: most occurrences are never opened, and
 * a job with fifty runs would otherwise mean fifty log queries to render a
 * table nobody has looked at yet.
 */
function OccurrenceLogs({ occurrenceId }) {
  const [lines, setLines] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    setError(null)
    fetchOccurrenceLogs(occurrenceId)
      .then((rows) => { if (alive) setLines(rows) })
      // Same rule as the history above: a failed fetch must not render as an
      // empty list, which reads as "this run said nothing".
      .catch((err) => { if (alive) { setLines([]); setError(err.message || 'Could not load the log') } })
    return () => { alive = false }
  }, [occurrenceId])

  if (lines === null) return <p className="muted jb-runs-note">Loading log…</p>
  if (error) return <p className="jb-run-error jb-runs-note">{error}</p>
  if (!lines.length) {
    return <p className="muted jb-runs-note">This run wrote no log lines.</p>
  }
  return (
    <ul className="jb-log">
      {lines.map((line) => (
        <li key={line.id} className={`jb-log-line jb-log-line--${line.level || 'info'}`}>
          <span className="jb-log-at" title={new Date(line.createdAt).toLocaleString()}>
            {new Date(line.createdAt).toLocaleTimeString()}
          </span>
          <span className="jb-log-msg">{line.message}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * ONE job's run history, expanded under its row.
 *
 * Fetched when opened rather than taken from the page's own occurrence list.
 * That list is every occurrence of every job (`?limit=0`) and exists to fill
 * one "last run" cell per row; a job on a five-minute cron adds ~105,000 rows
 * a year to it. Asking the server for this job's newest fifty is a bounded
 * question with a bounded answer.
 *
 * Re-fetched on `refreshKey` so that pressing Run now updates the open history
 * instead of leaving it showing the state from before the click.
 */
function JobRuns({ jobId, refreshKey }) {
  const [runs, setRuns] = useState(null)
  const [error, setError] = useState(null)
  // Which occurrence has its log open. One at a time: two open logs is two
  // scrolling regions competing inside a row that is already an expansion.
  const [openLogId, setOpenLogId] = useState(null)

  useEffect(() => {
    let alive = true
    setError(null)
    listJobOccurrences(jobId, 50)
      .then((r) => { if (alive) setRuns(r) })
      // A history that fails to load must SAY so. Rendering an empty list
      // would read as "this job has never run", which is a different and much
      // more alarming fact than "we could not fetch it".
      .catch((err) => { if (alive) { setRuns([]); setError(err.message || 'Could not load the run history') } })
    return () => { alive = false }
  }, [jobId, refreshKey])

  if (runs === null) return <p className="muted jb-runs-note">Loading runs…</p>
  if (error) return <p className="jb-run-error jb-runs-note">{error}</p>
  if (!runs.length) return <p className="muted jb-runs-note">This job has not run yet.</p>

  return (
    <div className="jb-history">
      <table className="jb-history-table">
        <thead>
          <tr>
            <th>Started</th>
            <th>Outcome</th>
            <th>Took</th>
            <th>Trigger</th>
            <th>Detail</th>
            <th>Log</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <Fragment key={run.id}>
            <tr>
              {/* Relative for reading, exact on hover — "3 hours ago" is what
                  you want 99% of the time and never what you want when
                  correlating against another system's timestamps. */}
              <td title={new Date(run.startedAt).toLocaleString()}>
                {relativeTime(run.startedAt, Date.now())}
              </td>
              <td>
                <RunPill status={run.status} />
                {run.retryCount > 0 && (
                  <span className="jb-retry" title={`Failed and was retried ${run.retryCount} time(s) within this same occurrence`}>
                    +{run.retryCount} retr{run.retryCount === 1 ? 'y' : 'ies'}
                  </span>
                )}
              </td>
              <td>{durationLabel(run.durationMs) || <span className="jb-dim">—</span>}</td>
              <td className="jb-dim">{run.triggeredBy?.type || '—'}</td>
              <td>
                {/* A late finish is not an error and must not read as one: the
                    work COMPLETED, after the reaper had already given up on
                    it. What it means is that "give up after" is set lower than
                    this job needs — a setting to change, not a failure to
                    investigate. */}
                {run.lateFinish && (
                  <span className="jb-late" title={run.lateFinish.note}>
                    finished later, after {run.lateFinish.ranForMinutes}m — raise “give up after”
                  </span>
                )}
                {run.error && <span className="jb-run-error">{run.error.message || 'Failed'}</span>}
                {!run.error && !run.lateFinish && <span className="jb-dim">—</span>}
              </td>
              <td>
                {/* THE SAME EXPANDER AS THE ROW ABOVE IT. A worded Show/Hide
                    button repeated down a column is louder than the column it
                    labels, and this table already teaches the chevron idiom
                    one row up. */}
                <button type="button"
                  className={`jb-log-toggle jb-caret${openLogId === run.id ? ' jb-caret--open' : ''}`}
                  aria-expanded={openLogId === run.id}
                  title={openLogId === run.id ? 'Hide this run’s log' : 'Show this run’s log'}
                  aria-label={openLogId === run.id ? 'Hide this run’s log' : 'Show this run’s log'}
                  onClick={() => setOpenLogId((id) => (id === run.id ? null : run.id))}>
                  <Icon path={ICON_CHEVRON} size={14} />
                </button>
              </td>
            </tr>
            {openLogId === run.id && (
              <tr className="jb-log-row">
                <td colSpan={6}><OccurrenceLogs occurrenceId={run.id} /></td>
              </tr>
            )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {runs.length === 50 && (
        <p className="muted jb-runs-note">Showing the 50 most recent.</p>
      )}
    </div>
  )
}

// ── the editor's three questions ──────────────────────────────────────────
//
// WHAT is it · WHAT does it need · WHEN does it run. In that order, because
// each one only makes sense once the one before it is answered: the inputs
// are the chosen action's inputs, and there is no point scheduling something
// that has not been described.
//
// A stepper rather than a wizard. All three are always reachable and Save is
// always available — someone editing a live job to change its cron should not
// have to walk past its name and its inputs to get there. The steps are for
// grouping, not for gatekeeping.
const STEPS = [
  { key: 'job', label: 'Job', hint: 'What it is, and what it runs' },
  { key: 'inputs', label: 'Inputs', hint: 'What that action needs' },
  { key: 'schedule', label: 'Schedule', hint: 'When, and what if it goes wrong' }
]

/**
 * Fields a PERSON fills in.
 *
 * `system: true` means the server supplies it just before the action runs —
 * a resolved connection, a dbType read off that connection. Rendering those
 * would be asking somebody to type a password into a form, which is exactly
 * what storing an id instead was for.
 */
function visibleFields(action) {
  return (action?.inputSchema || []).filter((f) => !f.system)
}

// ── labels ────────────────────────────────────────────────────────────────
//
// A schema field name is written for the action's code. Showing it raw put
// "connectionInfoId", "dbInfoId", "streaming_mode" and "batchSize" in front of
// people as though those were English.
//
// A schema may carry its own `label`; this is the fallback, and it is good
// enough that most fields will never need one. `Id`/`Info` are suffixes of the
// storage, not of the thing — you pick a Connection, not a connectionInfoId.
const LABEL_WORDS = { db: 'Database', sql: 'SQL', url: 'URL', id: 'ID', api: 'API' }

function fieldLabel(field) {
  if (field.label) return field.label
  return String(field.name)
    .replace(/Id$/, '')
    .replace(/Info$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .split(' ')
    .map((w, i) => {
      const known = LABEL_WORDS[w.toLowerCase()]
      if (known) return known
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.toLowerCase()
    })
    .join(' ')
}

/**
 * Split the fields into what you fill in and what you almost never touch.
 *
 * ADVANCED = optional AND already has a default. That is precisely the set
 * where doing nothing is the right answer — batchSize 1000, streaming_mode
 * true — and leaving them inline buried the two fields that actually decide
 * what the job does under six that do not.
 *
 * Collapsed, never hidden: the summary line lists what is in there and what it
 * is currently set to, so nothing is a surprise on the way to Save.
 */
function splitFields(fields) {
  const primary = []
  const advanced = []
  fields.forEach((f) => {
    if (!f.required && f.default !== undefined) advanced.push(f)
    else primary.push(f)
  })
  return { primary, advanced }
}

/** The control's value: always a string, whatever the declared type. */
function toFieldValue(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

/**
 * Strings back into the types the action declared — AT SAVE, not per keystroke.
 *
 * The form used to store `e.target.value` for everything, so a `number` field
 * was saved as "1000" and a `boolean` as "true", and @xeplr/schema-handler
 * rejected both at run time: `expected type number, got string`. Every job
 * with a non-string input was unrunnable, and (until the logging fix) failed
 * silently.
 *
 * Converting at save rather than on change matters for the JSON ones: parsing
 * per keystroke destroys half-typed text, because `{"a"` is not valid JSON and
 * never will be until the rest of it is typed.
 */
function fromFieldValues(action, inputs) {
  const out = {}
  ;(action?.inputSchema || []).forEach((f) => {
    if (f.system) return
    const raw = inputs?.[f.name]
    if (raw === undefined || raw === '') return
    if (typeof raw !== 'string') { out[f.name] = raw; return }

    if (f.type === 'number') {
      const n = Number(raw)
      out[f.name] = Number.isNaN(n) ? raw : n
    } else if (f.type === 'boolean') {
      out[f.name] = raw === 'true'
    } else if (f.type === 'object' || f.type === 'array') {
      // Left as the typed text if it will not parse. Saving is then refused
      // with the field named, which is a better answer than silently dropping
      // what somebody wrote.
      try { out[f.name] = JSON.parse(raw) } catch (e) { out[f.name] = raw }
    } else {
      out[f.name] = raw
    }
  })
  return out
}

/** Which JSON fields will not parse — named, so Save can say which. */
function badJson(action, inputs) {
  return (action?.inputSchema || [])
    .filter((f) => !f.system && (f.type === 'object' || f.type === 'array'))
    .filter((f) => {
      const raw = inputs?.[f.name]
      if (typeof raw !== 'string' || raw === '') return false
      try { JSON.parse(raw); return false } catch (e) { return true }
    })
    .map((f) => f.name)
}

/**
 * A field whose choices come from the host — a saved connection, a database.
 *
 * Loads on mount, and again whenever the field it `dependsOn` changes, so
 * choosing a connection narrows the database list instead of offering every
 * database on every connection.
 */
function RemoteSelect({ field, value, onChange, dependsOnValue }) {
  const [options, setOptions] = useState(null)
  const [failed, setFailed] = useState(false)
  const id = `jb-in-${field.name}`

  useEffect(() => {
    let alive = true
    // A dependent field cannot be chosen before the thing it depends on is.
    if (field.dependsOn && !dependsOnValue) { setOptions([]); return undefined }
    setFailed(false)
    fetchOptions(field.optionsFrom, field.dependsOn
      ? { name: field.dependsOn, value: dependsOnValue, clientKey: 'connectionId' }
      : null)
      .then((o) => { if (alive) setOptions(o) })
      // SAYS SO rather than showing an empty list. "There are none" and "we
      // could not ask" are different facts, and only one of them is the
      // user's problem to solve.
      .catch(() => { if (alive) { setOptions([]); setFailed(true) } })
    return () => { alive = false }
  }, [field.optionsFrom, field.dependsOn, dependsOnValue])

  return (
    <div className="jb-field">
      <label htmlFor={id}>
        {fieldLabel(field)}{field.required && <span className="jb-req"> *</span>}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}
        disabled={Boolean(field.dependsOn) && !dependsOnValue}>
        <option value="">
          {field.dependsOn && !dependsOnValue ? `Choose ${field.dependsOn} first…`
            : options === null ? 'Loading…'
            : options.length ? 'Choose…'
            : 'Nothing to choose from'}
        </option>
        {(options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {failed
        ? <span className="jb-help jb-warn">Could not load the list.</span>
        : field.description && <span className="jb-help">{field.description}</span>}
    </div>
  )
}

/** One input, rendered as whatever its declared type actually is. */
function ActionInput({ field, value, onChange, inputs }) {
  const id = `jb-in-${field.name}`
  const common = { id, value, onChange: (e) => onChange(e.target.value) }

  // A host-provided list, when the host has one. Without a source configured
  // this falls through to the plain controls below rather than rendering a
  // select nobody can fill.
  if (field.optionsFrom && hasOptionSource(field.optionsFrom)) {
    return (
      <RemoteSelect field={field} value={value} onChange={onChange}
        dependsOnValue={field.dependsOn ? inputs?.[field.dependsOn] : undefined} />
    )
  }

  let control
  if (Array.isArray(field.options) && field.options.length) {
    // The validator already REFUSES anything outside this list, so a free-text
    // box could only ever produce a run-time rejection.
    control = (
      <select {...common}>
        <option value="">Choose…</option>
        {field.options.map((o) => {
          const val = typeof o === 'object' ? o.value : o
          return <option key={val} value={val}>{typeof o === 'object' ? (o.label || o.value) : o}</option>
        })}
      </select>
    )
  } else if (field.type === 'boolean') {
    control = (
      <select {...common}>
        <option value="">{field.default === undefined ? 'Choose…' : `Default (${field.default})`}</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    )
  } else if (field.type === 'number') {
    control = <input type="number" {...common} placeholder={field.default !== undefined ? String(field.default) : ''} />
  } else if (field.type === 'object' || field.type === 'array') {
    control = <textarea rows={4} spellCheck="false" {...common} placeholder={field.type === 'array' ? '[]' : '{}'} />
  } else {
    control = <input {...common} placeholder={field.default !== undefined ? String(field.default) : ''} />
  }

  return (
    <div className={`jb-field${field.type === 'object' || field.type === 'array' ? ' jb-field--wide' : ''}`}>
      <label htmlFor={id}>
        {fieldLabel(field)}{field.required && <span className="jb-req"> *</span>}
        {/* The TYPE is shown only where it changes what you have to type —
            JSON. Everywhere else "· string" was noise on every single row. */}
        {(field.type === 'object' || field.type === 'array') &&
          <span className="jb-type"> · {field.type === 'array' ? 'JSON list' : 'JSON'}</span>}
      </label>
      {control}
      {field.description && <span className="jb-help">{field.description}</span>}
    </div>
  )
}

// The editor. A panel rather than a route: a job is a handful of fields, and a
// page you navigate to and back from for those is three navigations too many.
function JobEditor({ job, actions, onCancel, onSaved }) {
  const [draft, setDraft] = useState(() => ({
    name: job?.name || '',
    description: job?.description || '',
    actionName: job?.actionName || '',
    schedule: job?.schedule || '',
    // 'ready' | 'pause' — see xeplr-jobs migrations/0001_jobs.js. Editable
    // HERE and not only from the list, because "write it now, start it later"
    // is a normal thing to want: a job saved from this panel used to go
    // straight to 'ready' and begin running on its next due time, so the only
    // way to author one safely was to save it live and race to pause it.
    // New jobs default to paused for that reason; an existing one keeps
    // whatever it already is.
    status: job?.status || 'pause',
    // datetime-local wants 'YYYY-MM-DDTHH:mm' with no zone or seconds, and the
    // API hands back a full ISO string — so it is trimmed on the way in and
    // turned back into ISO on the way out (see submit).
    startAt: job?.startAt ? String(job.startAt).slice(0, 16) : '',
    retryLimit: job?.retryLimit ?? 0,
    // Empty means "use the default" rather than 0 — 0 would be a tolerance of
    // no minutes, which would time every job out instantly.
    timeoutMinutes: job?.timeoutMinutes ?? '',
    // Held as DISPLAY values (strings), converted back to their declared types
    // at save — see fromFieldValues.
    inputs: Object.fromEntries(
      Object.entries(job?.inputs || {}).map(([k, v]) => [k, toFieldValue(v)])
    )
  }))
  const [saving, setSaving] = useState(false)
  const [step, setStep] = useState(0)

  const action = actions.find((a) => a.name === draft.actionName) || null
  const patch = (p) => setDraft((d) => ({ ...d, ...p }))

  async function submit(e) {
    e.preventDefault()

    // Refused rather than saved with the broken text silently dropped or
    // stored as a string the action will reject at 3am.
    const broken = badJson(action, draft.inputs)
    if (broken.length) {
      setStep(1)
      raiseSnackbar(`Not valid JSON: ${broken.join(', ')}`, { design: 'error' })
      return
    }

    setSaving(true)
    try {
      await saveJob({
        ...(job?.id ? { id: job.id } : {}),
        name: draft.name.trim() || 'Untitled job',
        description: draft.description || '',
        actionName: draft.actionName,
        // Trimmed to null rather than '': the model treats an absent schedule
        // as manual-only, and an empty string is a cron expression the picker
        // would try to parse.
        schedule: draft.schedule.trim() || null,
        // A job with no schedule is manual-only, so 'ready' vs 'pause' says
        // nothing about it — the picker never looks at it either way. Sent as
        // 'ready' so it does not sit in the list wearing a Paused badge that
        // means nothing.
        status: draft.schedule.trim() ? draft.status : 'ready',
        // Sent as null rather than '' — the picker tests `startAt IS NULL`, and
        // an empty string is not null.
        startAt: draft.startAt ? new Date(draft.startAt).toISOString() : null,
        retryLimit: Number(draft.retryLimit) || 0,
        timeoutMinutes: draft.timeoutMinutes === '' ? null : Number(draft.timeoutMinutes),
        // Converted back to the types the action declared. Sending the raw
        // strings is what made every number/boolean field fail validation.
        inputs: fromFieldValues(action, draft.inputs)
      })
      onSaved()
    } catch (err) {
      raiseSnackbar(err.message || 'Could not save the job', { design: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const fields = visibleFields(action)

  return (
    <form className="jb-editor" onSubmit={submit}>
      <h2>{job?.id ? 'Edit job' : 'New job'}</h2>

      {/* Clickable, always. Nothing is gated behind a step — see STEPS. */}
      <nav className="jb-steps" aria-label="Sections">
        {STEPS.map((s, i) => (
          <button
            key={s.key}
            type="button"
            className={`jb-step${i === step ? ' jb-step--on' : ''}${i < step ? ' jb-step--done' : ''}`}
            aria-current={i === step ? 'step' : undefined}
            onClick={() => setStep(i)}
          >
            <span className="jb-step-n">{i + 1}</span>
            <span className="jb-step-t">{s.label}</span>
          </button>
        ))}
      </nav>
      <p className="jb-step-hint">{STEPS[step].hint}</p>

      {/* ── 1. What it is, and what it runs ─────────────────────────────── */}
      {step === 0 && (
        <>
          <div className="jb-field">
            <label htmlFor="jb-name">Name</label>
            <input id="jb-name" value={draft.name} placeholder="Nightly refresh"
              onChange={(e) => patch({ name: e.target.value })} />
          </div>

          <div className="jb-field">
            <label htmlFor="jb-desc">Description</label>
            <input id="jb-desc" value={draft.description} placeholder="What is this for?"
              onChange={(e) => patch({ description: e.target.value })} />
          </div>

          <div className="jb-field">
            <label htmlFor="jb-action">Action</label>
            <select id="jb-action" value={draft.actionName}
              onChange={(e) => patch({ actionName: e.target.value, inputs: {} })}>
              <option value="">Choose an action…</option>
              {actions.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
            </select>
            {action?.description && <span className="jb-help">{action.description}</span>}
            {!actions.length && (
              <span className="jb-help jb-warn">
                No actions are registered on the server, so a job has nothing to run.
              </span>
            )}
          </div>
        </>
      )}

      {/* ── 2. What that action needs ───────────────────────────────────────
          GENERATED FROM THE REGISTRY'S OWN SCHEMA. A hand-written form per
          action would be a second description of it, and the day the two
          disagree the form collects a field the action ignores. */}
      {step === 1 && (
        <>
          {!action && <p className="muted">Choose an action first — its inputs are its own.</p>}
          {action && !fields.length && (
            <p className="muted">
              <code className="jb-code">{action.name}</code> needs nothing filled in. Straight on to the schedule.
            </p>
          )}
          {action && (() => {
            const { primary, advanced } = splitFields(fields)
            const render = (f) => (
              <ActionInput
                key={f.name}
                field={f}
                inputs={draft.inputs}
                value={draft.inputs?.[f.name] ?? ''}
                onChange={(v) => patch({ inputs: { ...draft.inputs, [f.name]: v } })}
              />
            )
            return (
              <>
                <div className="jb-grid">{primary.map(render)}</div>
                {advanced.length > 0 && (
                  /* COLLAPSED, NOT HIDDEN. The summary names every field in
                     here and its current value, so closing it never conceals
                     something that is about to be saved. */
                  <details className="jb-advanced">
                    <summary>
                      Advanced
                      <span className="jb-dim">
                        {' — '}
                        {advanced.map((f) => `${fieldLabel(f)} ${draft.inputs?.[f.name] ?? f.default}`).join(' · ')}
                      </span>
                    </summary>
                    <div className="jb-grid">{advanced.map(render)}</div>
                  </details>
                )}
              </>
            )
          })()}
        </>
      )}

      {/* ── 3. When, and what if it goes wrong ─────────────────────────── */}
      {step === 2 && (
        <>
      <CronScheduleField id="jb-sched" value={draft.schedule} onChange={(schedule) => patch({ schedule })} />

      {/* ACTIVE OR PAUSED, decided while writing the job rather than after it
          is already live — "save it, but do not start it yet" is a normal
          thing to want, and without this the only way to author a scheduled
          job was to save it live and race to pause it.

          ALWAYS SHOWN. It was briefly hidden unless a schedule was set, on the
          grounds that the scheduler never looks at a manual-only job so the
          choice decides nothing. True, but a field that disappears is worse
          than one that is explained: the first thing it did was look missing.
          Disabled instead, saying why. */}
      <div className="jb-field">
        <label htmlFor="jb-status">Status</label>
        <select
          id="jb-status"
          value={draft.schedule.trim() ? draft.status : 'ready'}
          disabled={!draft.schedule.trim()}
          onChange={(e) => patch({ status: e.target.value })}
        >
          <option value="ready">Active — the scheduler runs this when it is due</option>
          <option value="pause">Paused — saved, but nothing runs until you resume it</option>
        </select>
        <span className="jb-help">
          {!draft.schedule.trim()
            ? 'This job has no schedule, so nothing runs it on its own — you trigger it yourself. Set a schedule above to be able to pause it.'
            : draft.status === 'ready'
              ? 'Runs on the schedule above. Pause it any time from the list.'
              : 'Kept exactly as written and left alone. Nothing runs until this is set to Active.'}
        </span>
      </div>

      {/* START DATE — "every fifteen minutes, but not before January".
          A separate field from the schedule because it answers a different
          question: the schedule says how often, this says not before when. */}
      {draft.schedule.trim() && (
        <div className="jb-field">
          <label htmlFor="jb-startat">Start from</label>
          <input
            id="jb-startat"
            type="datetime-local"
            value={draft.startAt}
            onChange={(e) => patch({ startAt: e.target.value })}
          />
          <span className="jb-help">
            {draft.startAt
              ? 'The schedule is ignored until this moment passes, then runs as normal.'
              : 'Leave empty to start as soon as the schedule says.'}
          </span>
        </div>
      )}

      {/* RETRY — off by default. An action that failed once usually fails
          again, and silently re-running something that moves data is worse
          than leaving it failed and visible. */}
      <div className="jb-field">
        <label htmlFor="jb-retry">Retry on failure</label>
        <select
          id="jb-retry"
          value={String(draft.retryLimit)}
          onChange={(e) => patch({ retryLimit: Number(e.target.value) })}
        >
          <option value="0">No — leave it failed</option>
          <option value="1">Retry once</option>
          <option value="2">Retry twice</option>
          <option value="3">Retry 3 times</option>
        </select>
        <span className="jb-help">
          {draft.retryLimit > 0
            ? 'Retries happen immediately, within the same run — the history shows one attempt with a retry count, not several runs.'
            : 'A failed run stays failed and is visible in the history.'}
        </span>
      </div>

      {/* TIMEOUT — the reaper's tolerance. Not a limit on how long the job may
          take; a limit on how long we keep believing a worker that has stopped
          reporting. See reapTimedOut in @xeplr/jobs' scheduler. */}
      <div className="jb-field">
        <label htmlFor="jb-timeout">Give up after</label>
        <input
          id="jb-timeout"
          type="number"
          min="1"
          placeholder="30"
          value={draft.timeoutMinutes}
          onChange={(e) => patch({ timeoutMinutes: e.target.value })}
        />
        <span className="jb-help">
          Minutes. If this job is still running after that, it is marked
          “timed out” and unlocked so it can run again — the worker was most
          likely killed. Leave empty for the default of 30.
          {' '}Set it higher than the job ever legitimately takes.
        </span>
      </div>
        </>
      )}

      <div className="jb-editor-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <span className="jb-editor-nav">
          {step > 0 && <button type="button" onClick={() => setStep(step - 1)}>Back</button>}
          {step < STEPS.length - 1 && (
            <button type="button" onClick={() => setStep(step + 1)} disabled={!draft.actionName}
              title={draft.actionName ? undefined : 'Choose an action first'}>
              Next
            </button>
          )}
        </span>
        {/* AVAILABLE ON EVERY STEP. Changing one job's cron should not mean
            walking past its name and its inputs to reach a button. */}
        <button type="submit" className="jb-primary" disabled={saving || !draft.actionName}>
          {saving ? 'Saving…' : 'Save job'}
        </button>
      </div>
    </form>
  )
}

/**
 * The jobs screen.
 *
 * Everything a HOST supplies is a prop, and all of it is optional — the page
 * renders correctly standalone with none of it. What a host owns is its own
 * chrome (a breadcrumb, a link to a sibling product); what this package owns
 * is jobs.
 *
 * @param {Function} [props.breadcrumb] - the host's breadcrumb component
 * @param {JSX.Element|string} [props.uploadLink] - a link to wherever the host
 *   loads files, if it has such a screen
 * @param {JSX.Element} [props.connectLink] - a link to the workflow canvas,
 *   for connecting jobs to each other so one starts when another finishes.
 *
 *   SUPPLIED BY THE HOST, not imported. This package must not depend on
 *   @xeplr/workflow: workflow already calls jobs — over HTTP, at run time, to
 *   start a job step — and importing its UI here would close that loop into a
 *   circular dependency between two packages that are deliberately installable
 *   on their own. Jobs is also the lower of the two: a deployment can have
 *   jobs and no workflow, and it should not be made to install one to render
 *   its own list.
 *
 *   So the host, which is the only thing that knows both are present, passes
 *   the link. Omitted, nothing is rendered — the screen is complete without
 *   it, exactly as uploadLink is.
 */
export default function Jobs({ breadcrumb: Breadcrumb, uploadLink, connectLink } = {}) {
  const [jobs, setJobs] = useState(null)
  const [runs, setRuns] = useState([])
  const [actions, setActions] = useState([])
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('name')
  const [editing, setEditing] = useState(null)   // job object, {} for new, null for closed
  const [busyId, setBusyId] = useState(null)
  const [openRuns, setOpenRuns] = useState(null) // jobId whose history is expanded
  // Bumped by anything that creates an occurrence, so an OPEN history refetches
  // rather than sitting there showing the state from before Run now was pressed.
  const [runsVersion, setRunsVersion] = useState(0)

  const load = useCallback(async () => {
    try {
      const [j, o, a] = await Promise.all([listJobs(), listOccurrences(), listJobActions()])
      setJobs(j)
      setRuns(o)
      setActions(a)
      setError(null)
    } catch (err) {
      setError(err.message || 'Could not load jobs')
      setJobs([])
    }
  }, [])

  useEffect(() => { load() }, [load])

  // ── LIVE UPDATES ────────────────────────────────────────────────────────
  //
  // This used to call load() on a timer, which is three requests — the job
  // list, the ACTION CATALOGUE, and every occurrence ever recorded
  // (`limit=0`) — every four seconds for as long as anything was running. On
  // a long movement that is the page re-reading its entire history hundreds of
  // times to discover that one number changed.
  //
  // Now it polls /jobs/active: only what is in flight, bounded by the
  // executor's concurrency cap, with each run's live progress attached.
  //
  // TWO SPEEDS, because there are two different questions:
  //
  //   something running    2s  — the numbers are moving and are worth
  //                              watching move.
  //   nothing running     15s  — nobody has pressed anything, but a CRON job
  //                              can start on its own and this is what
  //                              notices. The old gate polled only when a run
  //                              was ALREADY known about, so a scheduled job
  //                              starting by itself appeared on the page
  //                              whenever somebody next reloaded it.
  //
  // And ONE full load() on the edge from "something running" to "nothing
  // running": the small endpoint reports what is in flight, so by definition
  // it says nothing about the run that has just finished, and the final
  // status, duration and output still have to be fetched. Once, on the edge —
  // not every tick.
  //
  // The toggle is for the whole SCREEN rather than per job, because one
  // request already covers every running job. A per-job switch would multiply
  // requests rather than reduce them, and would need somewhere to keep a
  // preference that only affects what a screen looks like.
  const [live, setLive] = useState(true)
  const [active, setActive] = useState([])

  const anyRunning = active.length > 0 || (jobs || []).some((j) => j.running)

  useEffect(() => {
    if (!live) return undefined
    let stopped = false
    let sawActive = false

    const tick = async () => {
      try {
        const rows = await listActiveRuns()
        if (stopped) return
        setActive(rows)
        if (sawActive && rows.length === 0) load()   // the edge, one direction only
        sawActive = rows.length > 0
      } catch (err) {
        // A failed poll is not a failed page. The next tick tries again, and a
        // snackbar every two seconds because the network blinked would be
        // worse than the stale number it was warning about.
      }
    }

    const t = setInterval(tick, anyRunning ? 2000 : 15000)
    tick()
    return () => { stopped = true; clearInterval(t) }
    // Depends on anyRunning as a BOOLEAN, so the interval is rebuilt when the
    // page changes speed rather than every time a row count ticks up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, anyRunning, load])

  // The live run for each job, so a row can show its progress.
  const activeByJob = useMemo(
    () => Object.fromEntries((active || []).map((o) => [o.jobId, o])),
    [active]
  )

  const rows = useMemo(() => prepareJobs(jobs || [], { query, sort }), [jobs, query, sort])
  const lastRun = useMemo(() => latestByJob(runs), [runs])
  const recent = useMemo(
    () => runs.slice().sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).slice(0, 12),
    [runs]
  )
  const jobsById = useMemo(
    () => Object.fromEntries((jobs || []).map((j) => [j.id, j])),
    [jobs]
  )

  async function act(id, fn, failure) {
    setBusyId(id)
    try {
      await fn(id)
      await load()
      setRunsVersion((v) => v + 1)
    } catch (err) {
      raiseSnackbar(err.message || failure, { design: 'error' })
    } finally {
      setBusyId(null)
    }
  }

  async function remove(job) {
    const ok = await raiseConfirm(`Delete "${job.name}"? Its run history stays.`, { design: 'danger' })
    if (!ok) return
    act(job.id, deleteJob, 'Could not delete the job')
  }

  return (
    <section className="jb-page">
      {/* The host's own breadcrumb, if it has one. Standalone there is
          nothing to navigate back up to, so there is nothing to render —
          which is why this package does not ship one of its own. */}
      {Breadcrumb ? <Breadcrumb items={[{ label: 'Jobs' }]} /> : null}

      <header className="jb-head">
        <div>
          <h1>Jobs</h1>
          <p className="muted">
            An action, on a schedule. The server runs what is due and records every attempt.
          </p>
        </div>
        <div className="jb-head-tools">
          <input className="jb-search" type="search" value={query} placeholder="Search jobs…"
            aria-label="Search jobs" onChange={(e) => setQuery(e.target.value)} />
          <select className="jb-sort" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort by">
            <option value="name">Name</option>
            <option value="next">Next run</option>
            <option value="action">Action</option>
          </select>
          {/* LIVE UPDATES, for the screen rather than per job — one request
              already covers everything that is running.

              Checked by default, which it can afford to be: with nothing
              running this polls a small endpoint every fifteen seconds, and
              the alternative was a page somebody had to keep reloading by
              hand. Unchecking it makes the screen completely quiet.

              The count is here rather than in a row because it is the answer
              to "is anything happening at all", which is the question you ask
              before you go looking for which job. */}
          <label className="jb-live" title={live
            ? 'Refreshing while jobs are running. Uncheck to stop.'
            : 'The page will not refresh itself.'}>
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
            <span>Live updates</span>
            {live && active.length > 0 && (
              <span className="jb-live-count">{active.length} running</span>
            )}
          </label>
          {/* Before "+ New job", because connecting jobs is something you do
              to the ones already listed — a secondary action ON this screen's
              content, where the primary one creates more of it. */}
          {connectLink}
          <button type="button" className="jb-primary" onClick={() => setEditing({})}>+ New job</button>
        </div>
      </header>

      {error && <p className="report-builder-error">{error}</p>}
      {jobs === null && !error && <p className="muted">Loading…</p>}

      {editing && (
        <JobEditor
          job={editing.id ? editing : null}
          actions={actions}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}

      {jobs && jobs.length === 0 && !editing && (
        <div className="jb-empty">
          <p className="jb-empty-title">No jobs yet</p>
          <p className="muted">
            A job runs one registered action — on a cron, or whenever you press Run.
          </p>
          <button type="button" className="jb-primary" onClick={() => setEditing({})}>Create the first one</button>
        </div>
      )}

      {jobs && jobs.length > 0 && (
        <div className="jb-table-wrap">
          <table className="jb-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Action</th>
                <th>Schedule</th>
                <th>Next run</th>
                <th>Last run</th>
                {/* The toggle is not one of the actions. Pausing is a STATE
                    this job is in — visible at a glance down the column,
                    without reading a button's label to work out which way it
                    currently sits. */}
                <th>Enabled</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((job) => {
                const state = jobState(job)
                const last = lastRun[job.id]
                const liveRun = activeByJob[job.id]
                const busy = busyId === job.id
                const open = openRuns === job.id
                return (
                  <Fragment key={job.id}>
                  <tr className={open ? 'jb-row--open' : undefined}>
                    {/* ONE LINE PER ROW, everywhere in this table.
                        Stacked name/description/badge made every row three
                        lines tall, so eight jobs filled a screen and the
                        columns stopped lining up as anything scannable. The
                        description is still here — as the cell's title, where
                        it costs no height. */}
                    <td className="jb-cell-job" title={job.description || job.name}>
                      <span className="jb-name">{job.name}</span>
                      <StatePill state={state} />
                      {/* WHAT IT HAS DONE SO FAR, next to the pill that says it
                          is running. Absent until the first throttled write
                          lands, and absent forever for an action that reports
                          nothing — so "Running" on its own stays a complete
                          answer rather than looking like a number failed to
                          load.

                          A count, not a bar: there is no total to divide by
                          (a query source has no row count without running it
                          twice), and a bar would have to invent one. */}
                      {liveRun && progressLabel(liveRun) && (
                        <span
                          className={progressStale(liveRun) ? 'jb-progress jb-progress--stale' : 'jb-progress'}
                          title={progressStale(liveRun)
                            ? 'No update recently — the run may be in a long final write, or the worker may have died.'
                            : `Rows read so far. Last update ${new Date(liveRun.progress.at).toLocaleTimeString()}.`}
                        >
                          {progressLabel(liveRun)}
                        </span>
                      )}
                    </td>
                    <td><code className="jb-code">{job.actionName}</code></td>
                    <td>
                      {/* The phrase reads; the cron is the exact answer you
                          want only when the phrase looks wrong. Title, not a
                          second line. */}
                      {job.schedule
                        ? <span title={job.schedule}>{describeCron(job.schedule) || 'Custom'}</span>
                        : <span className="jb-dim">—</span>}
                    </td>
                    <td>
                      {/* THREE ANSWERS, NOT TWO. This used to show a bare em
                          dash for anything that was not an active job with a
                          next run — so a paused job and a manual-only job
                          looked identical, and both looked like a missing
                          value rather than an explanation.

                          A paused job HAS a nextRunAt (the model computes one
                          on save regardless of status), and showing it would
                          be a promise nothing intends to keep. Saying "Paused"
                          is the honest answer: there is no next run, and here
                          is why. */}
                      {!job.schedule
                        ? <span className="jb-dim" title="Manual only — this job has no schedule">—</span>
                        : state === 'paused'
                          ? <span className="jb-dim">Paused</span>
                          : job.nextRunAt
                            ? nextRunLabel(job.nextRunAt, Date.now())
                            : <span className="jb-dim">—</span>}
                    </td>
                    {/* The last run is also the way IN to every run. A history
                        behind a separate button would be a second thing to
                        find; the cell that already answers "how did it go
                        last time" is where somebody asks "and before that?" */}
                    <td>
                      {last ? (
                        <button type="button" className="jb-lastrun jb-lastrun--btn"
                          aria-expanded={open}
                          title={open ? 'Hide this job’s runs' : 'Show this job’s runs'}
                          onClick={() => setOpenRuns(open ? null : job.id)}>
                          <RunPill status={last.status} />
                          <span className="jb-dim">{relativeTime(last.startedAt, Date.now())}</span>
                          <span className={`jb-caret${open ? ' jb-caret--open' : ''}`}>
                            <Icon path={ICON_CHEVRON} size={14} />
                          </span>
                        </button>
                      ) : <span className="jb-dim">never</span>}
                    </td>
                    {/* ON means the scheduler picks this up. A switch rather
                        than a Pause/Resume button because the two buttons
                        showed the ACTION and left the state to be inferred
                        from it — the reverse of what a list is for. A job with
                        no schedule has nothing to enable, so the switch is off
                        and disabled rather than absent, which would leave a
                        hole in the column. */}
                    <td className="jb-row-toggle">
                      <label className="jb-switch"
                        title={!job.schedule
                          ? 'No schedule — there is nothing for the scheduler to pick up'
                          : job.status === 'pause'
                            ? 'Paused — turn on to let the schedule run again'
                            : 'Running on its schedule — turn off to pause it'}>
                        <input type="checkbox" role="switch"
                          checked={Boolean(job.schedule) && job.status !== 'pause'}
                          disabled={busy || !job.schedule}
                          onChange={(e) => act(
                            job.id,
                            e.target.checked ? resumeJob : pauseJob,
                            e.target.checked ? 'Could not resume' : 'Could not pause'
                          )} />
                        <span className="jb-switch-track" aria-hidden="true"><span className="jb-switch-thumb" /></span>
                        <span className="jb-switch-label">
                          {!job.schedule ? 'No schedule' : job.status === 'pause' ? 'Paused' : 'On'}
                        </span>
                      </label>
                    </td>
                    {/* ICONS, with the words moved into title/aria-label.
                        Three labelled buttons per row is a paragraph of text
                        repeated down the page, and it is the widest column in
                        a table whose actual content is the job. The label is
                        still there for anyone who needs it — on hover, and to
                        a screen reader always. */}
                    <td className="jb-row-actions">
                      <button type="button" disabled={busy} title="Run now" aria-label="Run now"
                        onClick={() => act(job.id, triggerJob, 'Could not trigger the job')}>
                        <Icon path={ICON_RUN} size={14} />
                      </button>
                      <button type="button" disabled={busy} title="Edit" aria-label="Edit"
                        onClick={() => setEditing(job)}>
                        <Icon path={ICON_EDIT} />
                      </button>
                      <button type="button" className="jb-danger" disabled={busy}
                        title="Delete" aria-label="Delete" onClick={() => remove(job)}>
                        <Icon path={ICON_DELETE} />
                      </button>
                    </td>
                  </tr>
                  {open && (
                    <tr className="jb-runs-row">
                      <td colSpan={7}>
                        <JobRuns jobId={job.id} refreshKey={runsVersion} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
          {rows.length === 0 && (
            <div className="jb-empty jb-empty--inline">
              <p className="muted">Nothing matches “{query}”.</p>
              <button type="button" onClick={() => setQuery('')}>Clear the search</button>
            </div>
          )}
        </div>
      )}

      {/* THE HISTORY, on the same page. A list of jobs cannot tell you a
          nightly job has been failing all week; a list of runs cannot tell you
          what was meant to happen. Both, or neither is much use. */}
      {recent.length > 0 && (
        <>
          <h2 className="jb-section">Recent runs</h2>
          <div className="jb-runs">
            {recent.map((run) => (
              <div className="jb-run" key={run.id}>
                <RunPill status={run.status} />
                <span className="jb-run-name">{jobsById[run.jobId]?.name || 'Deleted job'}</span>
                <span className="jb-dim">
                  {relativeTime(run.startedAt, Date.now())}
                  {durationLabel(run.durationMs) ? ` · ${durationLabel(run.durationMs)}` : ''}
                  {run.triggeredBy?.type ? ` · ${run.triggeredBy.type}` : ''}
                </span>
                {/* The message, not the stack. What went wrong belongs on the
                    row; where it went wrong belongs in the server log. */}
                {run.error && <span className="jb-run-error">{run.error.message || 'Failed'}</span>}
              </div>
            ))}
          </div>
        </>
      )}

      <p className="muted jb-footnote">
        Loading a file into a table is recorded separately — see{' '}
        {/* Loading a FILE is a different product and not necessarily present
            — a host that has one passes a link, and one that does not gets a
            sentence that still reads correctly without it. */}
        {uploadLink || 'the upload screen'}.
      </p>
    </section>
  )
}
