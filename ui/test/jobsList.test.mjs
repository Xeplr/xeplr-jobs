// Jobs — reading a cron expression, describing a run, and deciding what a
// job's state actually IS.
//
// Every check here is a claim that can be wrong in a way a screenshot will not
// show you: "next run in 3 hours" when it is 3 days, "paused" over a job that
// is running right now, a plain-English reading of a cron that says the
// opposite of the cron.
import {
  jobState, describeCron, nextRunLabel, durationLabel, latestByJob, prepareJobs
} from '../src/pages/jobsList.js'

const results = []
const check = (name, cond) => { results.push([name, cond]); console.log((cond ? '  ok   ' : '  FAIL ') + name) }

console.log('\nwhat state a job is in')
{
  check('no schedule is manual-only', jobState({ actionName: 'a' }) === 'manual')
  check('a schedule makes it scheduled', jobState({ schedule: '0 2 * * *' }) === 'scheduled')
  check('paused is paused', jobState({ schedule: '0 2 * * *', status: 'pause' }) === 'paused')
  // RUNNING WINS over paused. The pause takes effect at the next pick, so a
  // paused job mid-run is still running — and saying "paused" over a live
  // action invites somebody to start a second one.
  check('running beats paused', jobState({ schedule: '* * * * *', status: 'pause', running: true }) === 'running')
  check('running beats scheduled', jobState({ schedule: '* * * * *', running: true }) === 'running')
  check('nothing at all is not a crash', jobState(null) === 'unknown')
}

console.log('\nreading a cron expression')
{
  check('every n minutes', describeCron('*/15 * * * *') === 'Every 15 minutes')
  check('every minute, stepped', describeCron('*/1 * * * *') === 'Every minute')
  check('every minute, starred', describeCron('* * * * *') === 'Every minute')
  check('hourly on the hour', describeCron('0 * * * *') === 'Every hour, at 0 past')
  check('every n hours', describeCron('30 */6 * * *') === 'Every 6 hours, at 30 past')
  check('daily', describeCron('0 2 * * *') === 'Every day at 02:00')
  check('...padded to two digits', describeCron('5 9 * * *') === 'Every day at 09:05')
  check('weekly names the day', describeCron('0 6 * * 1') === 'Every Monday at 06:00')
  check('...and Sunday is 0', describeCron('0 6 * * 0') === 'Every Sunday at 06:00')
  check('monthly', describeCron('0 3 1 * *') === 'Monthly on day 1 at 03:00')

  // ANYTHING IT DOES NOT UNDERSTAND COMES BACK NULL, and the caller shows the
  // expression itself. A wrong plain-English reading is worse than the cron,
  // because you cannot tell that it is wrong.
  check('a range is not guessed at', describeCron('0 9-17 * * *') === null)
  check('a list is not guessed at', describeCron('0 0 * * 1,3,5') === null)
  check('the wrong number of fields is refused', describeCron('0 2 * *') === null)
  check('six fields are refused too', describeCron('0 0 2 * * *') === null)
  check('nothing is null', describeCron('') === null && describeCron(null) === null)
  check('whitespace is tolerated', describeCron('  0   2 * * *  ') === 'Every day at 02:00')
}

console.log('\nwhen it next runs')
{
  const NOW = Date.UTC(2026, 7, 4, 12, 0, 0)
  const inMs = (ms) => new Date(NOW + ms).toISOString()
  check('minutes', nextRunLabel(inMs(20 * 60000), NOW) === 'in 20 minutes')
  check('one minute is singular', nextRunLabel(inMs(60000), NOW) === 'in 1 minute')
  check('hours', nextRunLabel(inMs(3 * 3600000), NOW) === 'in 3 hours')
  check('days', nextRunLabel(inMs(50 * 3600000), NOW) === 'in 2 days')
  check('seconds round down to "under a minute"', nextRunLabel(inMs(20000), NOW) === 'in under a minute')
  // A due time in the PAST means the scheduler has not picked it — paused, not
  // running, or `running` left true by a process that died. Worth seeing,
  // rather than rendered as "in -2 minutes".
  check('the past is "due now", not a negative number', nextRunLabel(inMs(-120000), NOW) === 'due now')
  check('no date is null', nextRunLabel(null, NOW) === null)
  check('a broken date is null rather than NaN', nextRunLabel('not a date', NOW) === null)
}

console.log('\nhow long it took')
{
  check('sub-second is milliseconds', durationLabel(240) === '240ms')
  check('seconds get one decimal', durationLabel(2400) === '2.4s')
  check('minutes and seconds', durationLabel(125000) === '2m 5s')
  check('zero is zero, not "unknown"', durationLabel(0) === '0ms')
  check('missing is null', durationLabel(null) === null && durationLabel(undefined) === null)
}

console.log('\nthe last run of each job')
{
  const runs = [
    { id: 'r1', jobId: 'j1', startedAt: '2026-08-01T10:00:00Z', status: 'success' },
    { id: 'r3', jobId: 'j1', startedAt: '2026-08-03T10:00:00Z', status: 'failed' },
    { id: 'r2', jobId: 'j1', startedAt: '2026-08-02T10:00:00Z', status: 'success' },
    { id: 'r4', jobId: 'j2', startedAt: '2026-08-01T10:00:00Z', status: 'success' }
  ]
  const latest = latestByJob(runs)
  // BY TIME, not by array position. Occurrences arrive in whatever order the
  // endpoint returns them, and "the last one we were sent" is not a fact about
  // when anything ran — here r3 is latest but r2 comes after it in the list.
  check('the latest is by time, not by position', latest.j1.id === 'r3')
  check('...per job', latest.j2.id === 'r4')
  check('a job with no runs is absent rather than null', latest.j3 === undefined)
  check('no runs at all is not a crash', Object.keys(latestByJob(undefined)).length === 0)
  check('a run with no job id is ignored', Object.keys(latestByJob([{ id: 'x' }])).length === 0)
}

console.log('\nsearch and sort')
{
  const JOBS = [
    { id: '1', name: 'Nightly refresh', description: 'pull orders', actionName: 'db-fetch', nextRunAt: '2026-08-05T02:00:00Z' },
    { id: '2', name: 'Archive', description: '', actionName: 'file-move', nextRunAt: '2026-08-04T23:00:00Z' },
    { id: '3', name: 'Manual export', description: '', actionName: 'db-push' }
  ]
  const ids = (o) => prepareJobs(JOBS, o).map((j) => j.id).join()
  check('by name', ids({ sort: 'name' }) === '2,3,1')
  check('by action', ids({ sort: 'action' }) === '1,3,2')
  // A job with no next run sorts LAST. A manual job is not "due before
  // everything else"; it is simply not due.
  check('by next run, with the undated last', ids({ sort: 'next' }) === '2,1,3')

  check('search matches a name', ids({ query: 'nightly' }) === '1')
  check('...a description', ids({ query: 'orders' }) === '1')
  // "Which jobs push to the database" is a real question and the action is the
  // answer to it. Name-sorted, like everything else — search narrows the list,
  // it does not reorder it into whatever order the server sent.
  check('...and the action', ids({ query: 'db-' }) === '3,1')
  check('an empty query keeps everything', prepareJobs(JOBS, {}).length === 3)
  check('no jobs is not a crash', prepareJobs(undefined, {}).length === 0)
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
