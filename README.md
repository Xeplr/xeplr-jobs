# @xeplr/jobs

**Scheduled and manual runs of [`@xeplr/actions`](https://www.npmjs.com/package/@xeplr/actions).** A job is a row naming a registered action, its inputs and an optional cron schedule. A scheduler loop picks due jobs, runs each one inside its own tenant's context, and records every run as an occurrence row — with retries, timeouts, live progress, incremental windows and an optional callback when the run ends.

Use it when an app needs "run this action every hour", "run it now", or "run it for last March, and tell this URL when it is done" — with a history of what ran, with which inputs, and how it ended.

| what | where |
|---|---|
| Job definitions (action, inputs, schedule, retry, timeout) | `jobs` table |
| One row per run: status, input, output, error, progress | `jobOccurrences` table |
| What a job may run | the `@xeplr/actions` registry — safe built-ins by default, plus the host's own |
| HTTP: CRUD, run now, pause, what is running | `router()` |
| Picking due jobs and reaping dead runs | `startScheduler()` |

## Install

```sh
npm i @xeplr/jobs express
```

Peer: `express` (4 or 5). Dependencies: `@xeplr/actions`, `@xeplr/base-apis`, `@xeplr/db`, `@xeplr/schema-handler`, `@xeplr/utils`, `cron-parser`. Postgres (the connection is opened by `@xeplr/db` with the `pg` client). `@xeplr/logs` is used for logging when it can be resolved; otherwise the console.

## Quick start

Embedded in an Express app:

```js
var jobs = require('@xeplr/jobs')

await jobs.init({
  database: process.env.DB_JOBS,            // required (or set DB_JOBS)
  connection: appConnection,                // encrypted blob (needs ENCRYPTION_KEY) or { host, port, user, password }
  mts: appMtConfig,                         // the registerMTs() config — omit if this process already registered it
  resolveConnection: async function (connectionInfoId, { field, inputs }) {
    return { dbType: 'postgres', connection: { host, port, user, password, database } }
  }
})

jobs.registerAction({
  name: 'say-hello',
  inputSchema: [{ name: 'who', type: 'string', required: true }],
  execute: async function ({ input, system }) { return { said: 'hello ' + input.who } }
})

app.use('/api', jobs.router({ auth: authMiddleware }))
jobs.startScheduler()                       // leave out in a process that only serves the UI
```

Once, before the first start:

```sh
DB_JOBS=myapp_jobs JOBS_CONNECTION=<encrypted blob> ENCRYPTION_KEY=… npx xeplr-jobs-migrate up
```

Standalone (API + scheduler in one process):

```sh
DB_JOBS=myapp_jobs JOBS_CONFIG='{"connection":{"host":"localhost","port":5432,"user":"postgres","password":"…"}}' \
AUTH_URL=http://localhost:19141 npx xeplr-jobs-server
```

## API

| export | what |
|---|---|
| `init(config)` | Register tenancy (`mts`), set up the executor, register the default actions, connect to the jobs database (created if missing). Resolves to the knex connection. Call once, first. |
| `router(options?)` | Express router with the [routes](#routes). `options.auth`: one middleware, or `{ list, getById, save, delete }`. |
| `startScheduler(config?)` | Start the picker/reaper loop. Warns if tenancy is not registered. Returns `{ stop }`. Throws if already started. |
| `stopScheduler()` | Stop the loop and remove its SIGTERM/SIGINT handlers. |
| `start(config?)` | `init()`, then an Express server from `@xeplr/base-apis` with `router()` at `/`, then `startScheduler()` unless `startScheduler: false`. Resolves to the app. |
| `models` | `{ Job, JobOccurrence }` — **unbound** Objection classes (no connection attached). |
| `boundModels()` | `{ Job, JobOccurrence }` bound to the jobs connection. Use these to query jobs yourself, after `init()` resolved. |
| `registerDefaultActions(logger?)` | Register the safe built-ins from `@xeplr/actions` (see [Actions](#which-actions-a-job-can-run)). `init()` calls it unless `defaultActions: false`. Returns the names registered. |
| `warnIfUnscoped(logger?)` | Logs a warning and returns `false` when multi-tenancy is not registered in this process. |
| `requiredEnv` | `['DB_JOBS']` — spread into your app's required-env list. |
| `registerAction`, `listActions`, `runAction` | Re-exports of `@xeplr/actions` `register`, `list`, `runAction`. |
| `ActionNotRegisteredError`, `TransientError` | Re-exports from `@xeplr/actions`. |

`require('@xeplr/jobs/bin/server')` is also exported; requiring it **starts** the standalone server.

### `init(config)`

| option | meaning |
|---|---|
| `database` | Jobs database name. Falls back to `DB_JOBS`. Missing both **throws**. |
| `connection` (or `db`) | Server login: an encrypted string (decrypted with `ENCRYPTION_KEY` by `@xeplr/db`) or `{ host, port, user, password }`. Required — no environment fallback. |
| `connectionName` | Name the connection is registered under. Default `'jobs'`. |
| `mts` | Passed to `registerMTs()` from `@xeplr/db`. |
| `resolveConnection` | `async (id, { field, inputs }) => login` or `{ dbType, connection }`. See [saved connections](#saved-connections-never-credentials-in-a-job). |
| `maxConcurrent` | Executor concurrency cap. Default 20. |
| `logger` | Object with `info`, `important`, `error`, `critical`. Default: `@xeplr/logs` `createLogger('jobs')`, else console. |
| `defaultActions` | `false` to skip `registerDefaultActions()`. |

### `startScheduler(config)`

| option | default | meaning |
|---|---|---|
| `intervalMs` | 5000 | Tick interval. |
| `maxConcurrent` | 20 | Cap on runs in flight; a tick picks at most the free capacity. |
| `timeoutMinutes` | 30 | How long an occurrence may stay `running` before it is reaped. A job's own `timeoutMinutes` wins. |
| `onTimeout` | — | `async ({ job, occurrence, toleranceMinutes, ranForMinutes })`, called after a run is marked `timedOut` and its lock released, inside the job's tenant context. Errors are logged, never stop the reaper. |
| `logger` | as `init` | |

`start(config)` accepts everything `init()` and `startScheduler()` take, plus `port` (default `JOBS_PORT`, then 19003), `auth`, `corsOptions`, `middleware` (passed to `@xeplr/base-apis` `createApp`), `routerOptions`, and `startScheduler: false`.

## Jobs and occurrences

`jobs` columns you set:

| column | meaning |
|---|---|
| `name`, `description` | Labels. |
| `actionName` | A registered action. |
| `inputs` | JSON handed to the action (validated against its `inputSchema` by `@xeplr/actions`). |
| `schedule` | Cron expression (`cron-parser`). `NULL` = manual only — the scheduler never picks it. |
| `status` | `ready` (default) or `pause`. Only `ready` jobs are picked. |
| `startAt` | Not picked before this time. `NULL` = as soon as the schedule says. |
| `retryLimit` | Extra attempts after a failed one. Default 0. |
| `timeoutMinutes` | Reaper tolerance for this job. `NULL` = the scheduler's default. |
| `incrementalMode` | `NULL` (not incremental) or `period`. `watermark` is accepted by the model but **refused at run time** (not implemented). |

Maintained by the package: `running` (the per-job lock), `nextRunAt` (computed from `schedule` on insert when not given, and after every cron run), `coveredTo` (end of the last successfully covered window), plus `id`, `isActive`, `mtId1–4` and the audit columns.

A job is picked when `status = 'ready' AND running = false AND schedule IS NOT NULL AND (nextRunAt IS NULL OR nextRunAt <= now) AND (startAt IS NULL OR startAt <= now)`.

`jobOccurrences.status`:

| status | written by | means |
|---|---|---|
| `running` | executor | In flight. `progress` may hold `{ rowsRead, batches, at }`. |
| `success` | executor | The action returned. `output` holds its return value. |
| `failed` | executor | The action (or the framework before it) reported an error. `error` holds `{ name, message, stack? }`. |
| `skipped` | executor | A manual trigger found the job locked (`error.message = 'target busy'`). Cron ticks that lose the lock record nothing. |
| `timedOut` | reaper | Still `running` past the tolerance — the worker never reported. If it later finishes, `lateFinish` records `{ status, durationMs, ranForMinutes, finishedAt, note }` and the status stays `timedOut`. |
| `interrupted` | shutdown handler | The process received SIGTERM/SIGINT while the run was in flight. |

Also on each occurrence: `input` (the merged, **unresolved** inputs the run used), `retryCount`, `triggeredBy` (`{ type: 'cron' | 'manual' }`), `durationMs`, `startedAt`, `endedAt`, `callbackUrl`.

### What the action receives

```js
execute({
  input,        // job.inputs, + the computed window, + the trigger's overrides, with *ConnectionInfoId resolved
  system: { jobId, occurrenceId, startedAt, triggeredBy: { type }, onProgress }   // same object on every retry
})
```

`system.onProgress({ rowsRead, batches })` writes the occurrence's `progress`, at most once every 2 seconds, only while it is `running`.

## Routes

Relative to where `router()` is mounted. Responses use xeplr's `{ code, message, error, dataArray }`.

| route | does |
|---|---|
| `GET /jobs` | List jobs (`@xeplr/base-apis` `genericRoute`, paginated `?page=&limit=`). |
| `GET /jobs/:id` | One job. |
| `POST /jobs/save` | Save a changeset (`genericRoute`). |
| `POST /jobs/delete` | Soft-delete by ids (`genericRoute`). |
| `GET /jobs/:id/occurrences?limit=` | This job's runs, newest first. Default 50, max 500. |
| `GET /jobs/active` | Occurrences with `status = 'running'`, oldest first: `{ id, jobId, jobName, status, startedAt, retryCount, progress }`. For polling. |
| `POST /jobs/:id/trigger` | Run now. Body `{ inputs?, callbackUrl? }` — `inputs` may only replace the keys in `overridableInputs` (default `window`); any other key answers **400**, naming it. Answers at once with `{ occurrenceId, jobId, status: 'running' }`; **409 `busy`** if the job is already running; 404 if not found. |
| `POST /jobs/run` | Run several now. Body `{ jobIds: [...], inputs?: { <jobId>: {...} } }`, each checked like `trigger`'s. Returns `{ triggered, missing }`; 400 without `jobIds` or with a key that may not be overridden. |
| `POST /jobs/:id/pause` | `status = 'pause'`. |
| `POST /jobs/:id/resume` | `status = 'ready'`. |
| `GET /job-occurrences` | List occurrences (`genericRoute`). |
| `GET /job-occurrences/:id` | One occurrence. |
| `POST /job-occurrences/save`, `POST /job-occurrences/delete` | `genericRoute` save / soft delete. |
| `GET /actions` | The action registry: `[{ name, description, inputSchema, outputSchema, requires }]`. |

**Auth on the router.** `genericRoute` paths get `options.auth` as given (one middleware, or per operation). Every other route above — including the `GET`s — is gated by the single middleware, or by `auth.save` when an object is passed; an object without `save` leaves them ungated.

Queries go through the tenant-scoped models, so a caller sees and triggers only its own tenant's jobs.

### Permissions (`migrations-auth/`)

SQL for the **consuming app's auth database** — jobs never runs it. Add the folder to `XEPLR_AUTH_MIGRATIONS` (comma-separated) and run the auth migrations:

```sh
XEPLR_AUTH_MIGRATIONS=node_modules/@xeplr/jobs/migrations-auth npx xeplr-auth-migrate up
```

Idempotent inserts into `roles`, `menus`, `apis`, `apisRolesMapping`, `menuRolesMapping` (Postgres; uses `gen_random_bytes`):

| api group | apis | granted to |
|---|---|---|
| `jobs:view` | List jobs, Get job, List job occurrences, Get job occurrence, List actions, List active job runs | Super Admin, CompanyAdmin, Creator, Viewer |
| `jobs:create` | Save job, Delete job | Super Admin, CompanyAdmin, Creator |
| `jobs:run` | Trigger job, Batch trigger jobs | Super Admin, CompanyAdmin, Creator |
| `jobs:manage` | Pause job, Resume job | Super Admin, CompanyAdmin |

Menus: `Jobs`, `Job Runs` (`jobs:view`). `0002` grants "List active job runs" to every role that already holds a `jobs:view` api. The router itself does not check these names — enforcing them is the auth gate's job.

## Callbacks

Pass `callbackUrl` to `POST /jobs/:id/trigger` and the outcome is POSTed there when the run ends in **any** terminal state — success, failure, `skipped` (the lock was taken between the busy check and the run), timeout (from the reaper, even if the worker died) or interruption. A 409 `busy` answer is the refusal itself; no callback follows it.

```json
{
  "status": "success | failed",
  "error": null,
  "output": { "status": "success", "jobId": "…", "occurrenceId": "…", "startedAt": "…", "endedAt": "…", "durationMs": 1234, "output": {}, "error": null }
}
```

Top-level `status` is `success` only when the occurrence status is `success`; otherwise `failed`, with the occurrence's `error` or `{ name: 'JobNotCompleted' }`. Up to 3 attempts, 10 s timeout each, waiting 2 s then 4 s. A 4xx answer is not retried. Final failure is logged at error level.

## Environment variables

| name | required? | meaning |
|---|---|---|
| `DB_JOBS` | yes, unless `database` is passed | Jobs database name. Read by `init()`, `xeplr-jobs-server` and `xeplr-jobs-migrate`. Listed in `requiredEnv`. |
| `JOBS_CONNECTION` | for `xeplr-jobs-migrate` | Server login as an encrypted connection string, read by `@xeplr/db` `resolveConfig('jobs')`. With `--connection-name X` the variable is `X_CONNECTION`. |
| `ENCRYPTION_KEY` | when a connection is an encrypted string | Read by `@xeplr/db` to decrypt it. |
| `XEPLR_JOBS_MIGRATIONS` | no | Extra migration directories (comma-separated) run after the package's own by `xeplr-jobs-migrate`. |
| `JOBS_CONFIG` | no | `xeplr-jobs-server`: JSON passed to `start()`. The server reads no connection variable — put `connection` here. |
| `JOBS_PORT` | no | `xeplr-jobs-server` / `start()` port. Default 19003. |
| `JOBS_MTS` | no | `xeplr-jobs-server`: JSON for `registerMTs()`, used when `JOBS_CONFIG` has no `mts`. |
| `AUTH_URL` | for `start()` / `xeplr-jobs-server` unless `auth` is given | Read by `@xeplr/base-apis` `createApp`: with `auth` omitted every route requires a token validated there, and boot fails without it. |

Not read here: functions (`resolveConnection`, `onTimeout`, `logger`) cannot be passed through `JOBS_CONFIG`, so the standalone server cannot resolve saved connections.

## Database and migrations

Knex migrations in `migrations/`, run against the jobs database:

| file | does |
|---|---|
| `0001_jobs` | `jobs` table, picker index. |
| `0002_jobOccurrences` | `jobOccurrences` table. |
| `0003_jobs_mt` | `mtId1–4` on both tables; existing rows set to `'*'` (visible to every tenant, as before); tenant-leading picker index. |
| `0004_jobs_start_retry_timeout` | `startAt`, `retryLimit` (default 0), `timeoutMinutes`; indexes for picker and reaper. |
| `0005_late_finish` | `jobOccurrences.lateFinish`. |
| `0006_jobs_covered_to` | `coveredTo`, `incrementalMode`. |
| `0007_occurrence_progress` | `jobOccurrences.progress`. |
| `0008_occurrence_callback` | `jobOccurrences.callbackUrl`. |

### `xeplr-jobs-migrate`

```sh
npx xeplr-jobs-migrate up        [--db <name>] [--ext-dir <dirs>] [--connection-name <name>]
npx xeplr-jobs-migrate rollback  [--db <name>]
npx xeplr-jobs-migrate status    [--db <name>]
```

Options are space-separated (`--db myapp_jobs`, not `--db=myapp_jobs`). Reads only `process.env` — load your `.env` yourself. Exits 1 when no database is named. `up` creates the database first if it does not exist. Package migrations run first, then `XEPLR_JOBS_MIGRATIONS` / `--ext-dir`.

### `xeplr-jobs-server`

```sh
npx xeplr-jobs-server
```

Reads `JOBS_CONFIG`, `JOBS_PORT`, `DB_JOBS`, `JOBS_MTS`; calls `start()`. Exits 1 on invalid JSON or a failed start. When run as a child process it sends `{ status: 'ready', port }` once the server is up.

## Which actions a job can run

`init()` registers every built-in from `@xeplr/actions` that has a `name` and an `execute` function, **except** `spawnProgram` and `dbMove`. Placeholders with no implementation are skipped and named in one startup log line. With the current `@xeplr/actions` that registers `email-send`, `db-fetch`, `db-push`, `db-procedure`, `db-list-tables`, `db-list-views`, `db-list-procedures`, `db-list-columns`, `file-upload`, `email-read`, `email-move`, `email-delete`, `email-download-email`, `email-download-attachments`. Add your own with `registerAction()`.

## Rules the code enforces, and why

| rule | why |
|---|---|
| **No default database.** No `DB_JOBS` and no `database` → `init()` throws; the CLI exits. | A guessed name would create tables and run jobs in a database nobody chose, which then looks empty from the app meant to own them. |
| Jobs' models are bound to their **own** connection (`bind: false`), never the process-global Objection binding. | Embedded in a host app, a global bind would re-point the host's models at the jobs database. |
| **Tenancy must be registered in the process that runs jobs** (`mts`); `startScheduler()` warns if it is not. | `registerMTs()` is process-local. Without it the tenant filter is a no-op and every tenant's jobs are visible to every other — with no error. |
| The picker and reaper query **unscoped**; each run executes inside **the job's own** `mtId1–4` context (`runWithMt`). | A timer has no request context, and a scoped query would find nothing (`where 1 = 0`). Running in the job's context scopes the occurrence rows and everything the action reads or writes. |
| `spawnProgram` and `dbMove` are never offered by default. | `spawnProgram` runs arbitrary executables — on a cron that is a remote shell. `dbMove` needs connection objects, a column mapping and a window that no generic form can collect; register a host action that takes a saved move id instead. |
| **Saved connections, never credentials, in a job** — see below. | Job inputs reach the browser and are copied into every occurrence row. |
| **A request may override only `overridableInputs`** (`router({ overridableInputs })`, default `['window']`). `sql`, `where`, `table`, `procedure`, connections and the rest stay as the job was saved. | A job's inputs include its SQL and its connection. Letting any caller of `/trigger` replace them turns "run this job" into "run this SQL there". Server code calling `executeJob` is not limited. |
| One lock per job (`running`). A manual trigger on a running job answers **409 busy** — it is a refusal, not a queue. A race lost after that check is recorded as `skipped` and reported to the callback. | A caller told "triggered" would carry on as if a second run had started. |
| **Retries are opt-in** (`retryLimit`, default 0), and only a *returned* failure is retried, not a thrown framework error. All attempts share one occurrence row and one `system` object. | Silently re-running something that moves data is worse than leaving it failed and visible; a retry is the same due slot, not a new run. |
| **`timedOut` is not `failed`.** The reaper marks runs still `running` past `timeoutMinutes` (job, then scheduler, then 30), releases the lock and moves `nextRunAt` on. No heartbeat. | `running` is a lock with no expiry: a SIGKILLed or OOM-killed worker would leave the job locked forever. `failed` means the process reported an error; `timedOut` means nobody came back. The user knows how long their job takes; the system does not. |
| A finish that arrives after a timeout does not overwrite `timedOut`; it adds `lateFinish`. Every terminal write is conditional on `status = 'running'`. | The lock was already handed back, so "success" would be a claim nothing checked — and `lateFinish.ranForMinutes` is exactly the number to raise the tolerance to. |
| **Only cron runs move `nextRunAt`.** `startAt` is a separate column. | A manual run crossing a slot used to eat that slot. `nextRunAt` is rewritten from the cron expression, so a start date stored there would be overwritten. |
| **Incremental windows** (`incrementalMode: 'period'`): the action's `inputs.window` gets `from = coveredTo`, `to = now` (half-open, `from <= x < to`), keeping the job's other window fields. `coveredTo` advances **only on success**, only if the reaper had not already written the run off, and **not** when the trigger supplied its own `window`. | A failed 10:00 run leaves coverage at 09:00 so the 11:00 run covers 09:00–11:00 by itself. No +1 second: on a half-open window it would open a gap. A caller's window is a backfill whose `to` is in the past. |
| `watermark` or an unknown `incrementalMode` fails the run with a message. | Running it as a period or with no window would move rows the job was configured not to move. |
| **Trigger overrides are shallow**: each top-level key in `inputs` replaces the job's key; `undefined` is ignored, `null` is kept. The job row is not changed. | Half-merging a `window` or a column mapping produces a shape nobody authored. |
| `POST /jobs/run` takes overrides **per job id**. | The jobs share nothing; one shared object would land a window meant for one job on another with a same-named field. |
| Progress writes are throttled to one per 2 s, fire-and-forget, and only while `running`. | A long move reports thousands of batches; a reaped run must not look alive. |
| **Every terminal state is reported** to `callbackUrl`, which is stored on the occurrence. Status goes in the body; the HTTP code only says whether delivery worked. | A waiting workflow step must learn about failures, refusals, timeouts and shutdowns too — and after a SIGKILL only the reaper, in another process, can tell it. |
| On SIGTERM/SIGINT the scheduler stops picking, marks this process's runs `interrupted`, releases their locks and fires their callbacks. It never calls `process.exit()`; if it is the only listener it re-sends the signal to itself. | A deploy should not look like a crash, the embedding host decides when to exit, and attaching a listener otherwise disables Node's default exit. |
| A scheduler tick that throws is logged at `critical`. | A broken tick means no job is picked or reaped anywhere — the one failure worth an email. |
| The standalone server passes `auth` through unchanged, so omitted means `@xeplr/base-apis`' gate (`AUTH_URL`). Pass `auth: false` to open it deliberately. | It exposes "run this action now"; unauthenticated, anyone could execute registered actions. |

### Saved connections, never credentials in a job

A job stores ids; the executor swaps them for credentials just before calling the action, **after** the occurrence row (with the unresolved inputs) is written:

| input key | becomes |
|---|---|
| `connectionInfoId` | `connection` (and `dbType` when the resolver returns `{ dbType, connection }`) |
| `<x>ConnectionInfoId` | `<x>Connection` (and `<x>ConnectionDbType`) |

The resolver gets the id and `{ field, inputs }`, so it can read companion ids such as `dbInfoId`. The `*ConnectionInfoId` key is removed from what the action receives. A job naming a connection with no `resolveConnection` configured, or an id the resolver returns nothing for, **fails** — a literal `connection` in inputs is used only when no id was given, so a deleted or foreign connection never silently falls back to a different one.

## Tests

There is no test suite yet: `package.json` has no `test` script and the repo has no test files. CI (`.github/workflows/ci.yml`) reports "No test script — nothing verified."

## License

MIT
