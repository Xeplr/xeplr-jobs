import { describeCron } from '../pages/jobsList.js'
import './CronScheduleField.css'

// One cron schedule, picked from a few presets or typed by hand. Extracted
// from Jobs.jsx's own JobEditor (where it was inline, tightly coupled to
// that form's draft/patch closure) so Move Data's own wizard can offer the
// exact same picker for "run this on a schedule" — same idea as
// RunLogPanel's own generalization earlier: two screens wanting identical
// behavior shouldn't carry two slightly-drifting implementations of it.
//
// Deliberately just `{ value, onChange }` — no fetching, no page-specific
// copy. A caller that needs to explain WHY a schedule is required (or
// optional, or not applicable) wraps this with its own text; this component
// only ever describes the schedule itself.
export const CRON_PRESETS = [
  { value: '', label: 'Manual only — no schedule' },
  { value: '*/15 * * * *', label: 'Every 15 minutes' },
  { value: '0 * * * *', label: 'Hourly, on the hour' },
  { value: '0 2 * * *', label: 'Daily at 02:00' },
  { value: '0 6 * * 1', label: 'Weekly, Monday at 06:00' },
  { value: '0 3 1 * *', label: 'Monthly, the 1st at 03:00' }
]

export default function CronScheduleField({ value, onChange, id = 'csf-sched' }) {
  return (
    <div className="csf-field">
      <label htmlFor={id}>Schedule</label>
      <select id={id}
        value={CRON_PRESETS.some((p) => p.value === value) ? value : 'custom'}
        onChange={(e) => { if (e.target.value !== 'custom') onChange(e.target.value) }}>
        {CRON_PRESETS.map((p) => <option key={p.value || 'none'} value={p.value}>{p.label}</option>)}
        <option value="custom">Custom cron…</option>
      </select>
      <input className="csf-cron" value={value || ''} placeholder="* * * * *"
        onChange={(e) => onChange(e.target.value)} />
      <span className="csf-help">
        {value
          // A wrong plain-English reading of a cron is worse than the cron
          // itself, because you cannot tell it is wrong — so it is only
          // offered for expressions this actually understands.
          ? (describeCron(value) || 'Five cron fields: minute, hour, day of month, month, day of week.')
          : 'No schedule set.'}
      </span>
    </div>
  )
}
