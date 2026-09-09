# Jobs: agreed work, not yet built

Agreed 2026-08-14. Nothing here is implemented.

## 1. Status / pause — UI ONLY

Save a job **paused**, and toggle active/paused from the list.

- `jobs.status` already drives the picker: `status = 'ready' AND running =
  false AND (nextRunAt IS NULL OR nextRunAt <= now)` — see
  `lib/scheduler.js:45`. A non-`ready` status is therefore already "paused".
- **Pause job** / **Resume job** endpoints ALREADY EXIST — they are in the
  permissions catalog under `jobs:manage`.

So this is surfacing what is there, not building it.

## 2. "Expected run at" — UI ONLY

Display `jobs.nextRunAt`, **only when the job is active**. For a paused job it
is meaningless or stale, so it should not be shown at all. Column already
exists and is already what the scheduler picks on.

## 3. Start date

"Runs every 15 minutes, but not before 1 Jan 2027."

FIRST CHECK whether setting `nextRunAt` to the start date is sufficient — the
picker already refuses to run a job whose `nextRunAt` is in the future, so it
may need no schema change at all.

The thing that decides it: **does the scheduler recompute `nextRunAt` from the
cron expression on save or on its first pass?** If it does, it overwrites the
start date and the job fires immediately — and then a real `startAt` column is
needed, checked in the picker alongside `nextRunAt`.

## 4. Retry on failure

Per-job: retry or not, and how many times. `jobOccurrences.retryCount` already
exists (`migrations/0002_jobOccurrences.js`).

## 5. Timeout / expiry

**Default 30 minutes, overridable per job.** The scheduler marks any occurrence
still `running` past its tolerance as `timedOut`.

`timedOut` is a DISTINCT STATUS from `failed`, and the distinction is the whole
point:

- `failed` — the process caught the error and told us what went wrong.
- `timedOut` — nobody ever came back. An uncatchable death: SIGKILL, OOM,
  power loss, the container vanishing. No handler runs, so the row is the only
  evidence it happened.

Collapsing them throws away the one signal that says an edge case occurred.

**No heartbeat.** A slow job is the user's responsibility to configure — they
know their job's runtime, the system does not. Default 30, override per job.

### Why this is needed at all

`jobs.running` is a boolean lock with **no expiry** (see `migrations/
0001_jobs.js:5` — "running — lock flag; the scheduler skips rows where
running=true"). A worker killed mid-run leaves it `true` forever and that job
never runs again, silently.

The same hole existed in `cube_builds` and in the (now deleted)
`warehouse_tasks`. It is fixed HERE, once, because an action always belongs to
a job and the job layer is the only thing that knows whether a process is
still alive.

## Not wanted

Schedule presets / cron are fine as they are. Cron is the escape hatch; no
work needed there.

## Related, decided elsewhere

- Cube building and warehouse loading are now ACTIONS a job can name
  (`cube-build` → cubeId, `warehouse-load` → tableId), registered in
  xeplr-bi's `db/jobsSetup.js`. The warehouse has no scheduler of its own any
  more — that was the reason to fix timeouts here rather than in three places.
- Evaluated `zepto-labs/scherry` (open-sourced 2026-08-14) as a replacement:
  NO. It is a Go library needing Kafka + Redis, has no multi-tenancy, and
  solves job→task fan-out rather than the single-unit scheduling done here.
