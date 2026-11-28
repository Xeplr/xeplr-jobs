# @xeplr/jobs — map

Cron + manual runner: a `jobs` row names an `@xeplr/actions` action and its inputs; the scheduler
picks due rows and runs them, one `jobOccurrences` row per run. Embedded by BI (and by the workflow
engine's host for schedules); also runs standalone (`bin/server.js`). It is NOT the workflow engine —
it knows nothing about steps; it only reports each finished run (`onFinish` / callbackUrl).

## Where things are
- `index.js` — public API: `init()`, `start()`, `router()`, `startScheduler()`/`stopScheduler()`, `trigger()`, `keepSchedule()`, `boundModels`, `registerDefaultActions()` (deny list `NEVER_OFFER`: spawnProgram, dbMove), `requiredEnv` (`DB_JOBS`), re-exports `registerAction`/`runAction`
- `lib/db.js` — `connectJobsDb()` (secondary connection, `bind:false`, creates the DB if missing, refuses without `DB_JOBS`), `conn()`, `boundModels()`
- `lib/scheduler.js` — `startScheduler()` (the one `setInterval` tick, default 5 s), `reapTimedOut()` (stuck `running` → `timedOut`, `onTimeout`), `registerShutdownHandlers()` (SIGTERM closes in-flight)
- `lib/execute.js` — `executeJob()` → `executeJobScoped()` (lock, occurrence, retries, release + next `nextRunAt`), `mergeInputs()`, `buildWindow()`, `resolveInputs()` (`*ConnectionInfoId` → credentials via host `resolveConnection`), `buildActionCall()` (`system.dueAt`, `onProgress`), `shutdownInFlight()`
- `lib/trigger.js` — `triggerJob()`, `allowedInputsFor()`, `refusedInputs()` — the one rule for what a trigger may override (`window` + job's `acceptsInputs`)
- `lib/keep.js` — `keepSchedule(id, spec, {system})`: create/update/remove a job another product owns; keeps pause and a due `nextRunAt`; system jobs stored with mtIds `'*'`
- `lib/cron.js` — `computeNextRun(cron, from, timezone)`, `isValidCron()` (cron-parser, `tz` = job's `timezone`, server zone when blank)
- `lib/runContract.js` — `CONTRACT` (`window.*`, `previous.given.*`, `previous.used.*`), `bindRunValues()` replaces `{window.from}`-style bindings in inputs
- `lib/notify.js` — `setOnFinish()`, `reportFinished()`, `notifyCallback()` (POST to callbackUrl, timeout + retries, timers unref'd), `outcomeOf()`
- `lib/jobRouter.js` — `createJobRouter()`: all routes; `refuseSystem()` guards system jobs; `DEFAULT_OVERRIDABLE_INPUTS`
- `lib/migrate.js` — `migrateUp()`; `bin/migrate.js` (CLI `xeplr-jobs-migrate`, env only), `bin/server.js` (`JOBS_CONFIG`, `JOBS_MTS`, `JOBS_PORT`)
- `models/Job.js` (recomputes `nextRunAt` on insert/update from `schedule` + `timezone`), `models/JobOccurrence.js`
- `migrations/` — knex JS, jobs' own DB; `migrations-auth/` — `apis`/role rows for the routes

## Flow
- Cron: `startScheduler()` tick → `reapTimedOut()` → `Job.unscopedQuery()` where ready, not running, `nextRunAt <= now`, `startAt <= now` → `executeJob(models, job, {type:'cron'})` → re-enters the job's own tenant (`mtOf`) → lock `running=true` → `actions.runAction(buildActionCall())` → occurrence final status → release + `computeNextRun()` → `reportFinished()` (onFinish + callbackUrl).
- Manual: `POST /jobs/:id/trigger` or `index.trigger()` → `trigger.triggerJob()` (input rule) → `executeJob()` with `{inputs, callbackUrl, chain}` → returns `occurrenceId` at once.
- Owned schedule: workflow host calls `keepSchedule(id, {name, actionName, inputs, cron, timezone})` on save; the job then runs like any other.

## Routes (`lib/jobRouter.js`)
`GET /jobs/:id/occurrences` (newest first, ≤500), `GET /jobs/active`, `GET /jobs/run-contract`, `POST /jobs/save|delete` (system refused), generic CRUD `/jobs`, `/job-occurrences`, `GET /actions`, `POST /jobs/:id/trigger`, `POST /jobs/run`, `POST /jobs/:id/pause|resume`. Specific routes are registered BEFORE the generic `/jobs` mount, or `/:id` swallows them.

## To change X, edit Y
- Add/refuse a default action → `index.js` → `NEVER_OFFER` / `registerDefaultActions()`
- What a run's inputs look like to the action → `lib/execute.js` → `buildActionCall()`
- What a trigger may override → `lib/trigger.js` → `allowedInputsFor()`
- New binding like `{window.from}` → `lib/runContract.js` → `CONTRACT`, `valueOf()`
- Next-run / time zone math → `lib/cron.js` → `computeNextRun()`
- Stuck-run handling → `lib/scheduler.js` → `reapTimedOut()`
- Finished-run envelope → `lib/notify.js` → `outcomeOf()`
- Owned/system schedule rules → `lib/keep.js` → `keepSchedule()`
- New route → `lib/jobRouter.js` + a new `migrations-auth/000N_*.sql` (`apis` row, group, role mappings) in the same change
- New column → new `migrations/00NN_*.js` + `models/Job.js` jsonSchema

## Rules and traps
- Always use `boundModels()` (after `await init()`), never `models` — the raw classes have no knex; jobs never binds Objection globally (`lib/db.js`).
- Picker and reaper are unscoped (a timer has no tenant; scoped query = `where 1 = 0`); each job runs inside its own tenant context. A worker process must pass `mts` to `init()` or every tenant's jobs are shared — `warnIfUnscoped()` logs it.
- `resolveConnection` is set in `init()`, not `startScheduler()`, because manual runs happen in processes with no scheduler.
- `init({migrate:true})` only in the process that serves the API; a second scheduler process must not race it.
- A refusal ("target busy") and a failure are reported through `reportFinished()` exactly like success — a waiting workflow step depends on it.
- System jobs: `refuseSystem()` blocks save/delete/pause/resume; Run now is allowed.
- `nextRunAt` is recomputed on every save/run; never store a start date in it (that is `startAt`).
- Workspace rules: no DB-name default (`DB_JOBS` required); every route gets its `migrations-auth` row; README per change (see /CLAUDE.md of the workspace).

## Test
- `npm test` (`node --test test/*.test.js`). `test/triggerInputs.test.js` runs without a DB.
- `JOBS_TEST_PG='{"host":"localhost","port":5432,"user":"vikasbhandari","password":""}' npm test` — `test/keepSchedule.test.js` (keepSchedule, system jobs, timezone, `migrate:true`) and `test/chains.test.js` (onFinish envelope, trigger input rule, callbackUrl) create and drop scratch databases; skipped without `JOBS_TEST_PG`.
