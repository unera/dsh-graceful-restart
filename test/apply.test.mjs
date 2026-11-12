/**
 * The wiring itself: does the plugin reach the services it needs, mount the
 * status route, register both tools, and deliver a past restart's note?
 *
 * These are the failures that a green unit suite missed once already: cordis
 * hands out only declared services, and every optional one is taken through
 * `inject`. A fake host that answers `inject` the same way is enough to catch it.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { STATUS_PATH, apply } from '../index.mjs'

/** A host that grants exactly the services the plugin asks for, and nothing else. */
function fakeHost ({ agents = [], settingsValue = null, resolve = () => ({ ok: true }), delayServices = {}, jobs = [], scheduleApi = 'typed' } = {}) {
  const registered = []
  const routes = []
  const followed = []
  const flushes = []
  const requested = []
  const services = () => ({
    webServer: { register: route => { routes.push(route); return () => {} } },
    settings: { describe: () => settingsValue === null ? [] : [{ ns: 'dsh-graceful-restart', value: settingsValue }] },
    // The registry contract: `list()` answers only unowned jobs, `list(caller)`
    // answers that owner's jobs plus the unowned ones.
    jobs: {
      list: caller => jobs.filter(job => job.owner === undefined || job.owner === caller),
    },
    // The core moved the call in 0.2.2: `create(sessionId, { after_seconds })`
    // became `create({ timing: { kind, ... }, target })`. The fake speaks the
    // shape the test names and refuses the other one the way the real service
    // does, because a fake that accepts anything hides exactly this breakage.
    schedule: {
      create: async (first, second) => {
        const typed = scheduleApi === 'typed'
        if (typed !== (typeof first === 'object' && first !== null)) {
          throw new Error('invalid_rule: timing must contain exactly kind and its matching selector.')
        }
        const request = typed ? first : second
        const sessionId = typed ? request?.target?.sessionId : first
        if (typeof request?.title !== 'string' || request.title.trim() === '') throw new Error('title is required')
        if (typeof request.prompt !== 'string' || request.prompt.trim() === '') throw new Error('prompt is required')
        const after = typed ? request.timing : request
        if (typed && (after?.kind !== 'after' || !('after_seconds' in after))) {
          throw new Error('invalid_rule: timing must contain exactly kind and its matching selector.')
        }
        // The service refuses zero: `after_seconds` must be a positive safe integer.
        if (!Number.isSafeInteger(after.after_seconds) || after.after_seconds <= 0) {
          throw new Error('after_seconds must be a positive safe integer.')
        }
        const outcome = resolve(sessionId)
        if (outcome?.error) throw outcome.error
        followed.push({ id: sessionId, title: request.title, text: request.prompt, after: after.after_seconds, request })
        return { id: 'sched-1', sessionId, record: request }
      },
    },
  })
  const ctx = {
    agents: { list: () => agents },
    tools: { register: definition => { registered.push(definition); return () => {} } },
    logger: () => ({ info () {}, warn () {}, error () {} }),
    effect: fn => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    // The real contract: the child context carries only the named services.
    inject: (deps, callback) => {
      requested.push(deps)
      const available = services()
      const child = { effect: ctx.effect }
      for (const key of deps) if (key in available) child[key] = available[key]
      const delay = Math.max(...deps.map(key => delayServices[key] ?? 0))
      let dispose
      if (delay > 0) {
        const timer = setTimeout(() => { dispose = callback(child) }, delay)
        timer.unref?.()
      } else {
        dispose = callback(child)
      }
      return () => { if (typeof dispose === 'function') dispose() }
    },
  }
  return { ctx, registered, routes, followed, flushes, requested }
}

/** Write a pending file dated in the past, so it counts as a previous run's. */
function writePending (dir, records, ageSeconds = 120, extra = {}) {
  const path = join(dir, 'pending.json')
  writeFileSync(path, `${JSON.stringify({ version: 2, restartedAt: new Date().toISOString(), records, ...extra }, null, 2)}\n`)
  const stamp = Date.now() / 1000 - ageSeconds
  utimesSync(path, stamp, stamp)
  return path
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('the status route is mounted and answers with uptime counters', () => {
  const host = fakeHost()
  apply(host.ctx, { stateDir: mkdtempSync(join(tmpdir(), 'gr-route-')), notifyDelayMs: 1 })
  assert.equal(host.routes.length, 1)
  const route = host.routes[0]
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, STATUS_PATH)
  let body = ''
  route.handler({ url: STATUS_PATH, method: 'GET' }, { writeHead () {}, end: chunk => { body = chunk } })
  const value = JSON.parse(body)
  assert.equal(value.ok, true)
  assert.equal(value.pid, process.pid)
  assert.ok(value.uptimeMs >= 0)
  assert.ok(Date.parse(value.startedAt) <= Date.now())
  assert.equal(value.pending, 0)
  assert.equal(value.quiet, null)
})

test('both tools are registered globally, and the optional services were asked for', () => {
  const host = fakeHost()
  apply(host.ctx, { stateDir: mkdtempSync(join(tmpdir(), 'gr-tools-')), notifyDelayMs: 1 })
  assert.deepEqual(host.registered.map(tool => tool.name), ['dsh_restart', 'dsh_restart_cancel'])
  const asked = host.requested.map(deps => deps.join('+')).sort()
  assert.deepEqual(asked, ['jobs', 'schedule', 'settings', 'webServer'])
})

test('a previous restart wakes the session that asked for a note', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-notify-'))
  const host = fakeHost()
  writePending(dir, [{ id: '42', cause: 'обновили библиотеку', needNotify: true, sessionId: 'sess-1' }])
  apply(host.ctx, { stateDir: dir, notifyDelayMs: 5, language: 'ru' })
  await wait(60)
  assert.equal(host.followed.length, 1)
  assert.equal(host.followed[0].id, 'sess-1')
  assert.match(host.followed[0].text, /обновили библиотеку/)
  assert.ok(Number.isSafeInteger(host.followed[0].after) && host.followed[0].after > 0, 'the service refuses a zero delay')
  assert.ok(host.followed[0].title.length > 0, 'a schedule task needs a title')
  assert.equal(existsSync(join(dir, 'pending.json')), false, 'a delivered note leaves no pending file')
})

test('a host on the older core still gets its note, through the old request shape', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-legacy-'))
  const host = fakeHost({ scheduleApi: 'legacy' })
  writePending(dir, [{ id: '47', cause: 'старое ядро', needNotify: true, sessionId: 'sess-2' }])
  apply(host.ctx, { stateDir: dir, notifyDelayMs: 5 })
  await wait(60)
  assert.equal(host.followed.length, 1, 'the refused typed request falls back to the flat one')
  assert.equal(host.followed[0].id, 'sess-2')
  assert.match(host.followed[0].text, /старое ядро/)
  assert.equal(existsSync(join(dir, 'pending.json')), false)
  rmSync(dir, { recursive: true, force: true })
})

test('the schedule request carries the 0.2.2 timing and target, not a flat delay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-shape-'))
  const host = fakeHost()
  writePending(dir, [{ id: '48', cause: 'форма запроса', needNotify: true, sessionId: 'sess-3' }])
  apply(host.ctx, { stateDir: dir, notifyDelayMs: 5 })
  await wait(60)
  assert.equal(host.followed.length, 1)
  const request = host.followed[0].request
  assert.deepEqual(request.timing, { kind: 'after', after_seconds: 1 })
  assert.deepEqual(request.target, { kind: 'session', sessionId: 'sess-3' })
  assert.equal('after_seconds' in request, false, 'the flat delay is the pre-0.2.2 shape only')
  rmSync(dir, { recursive: true, force: true })
})

test('the configured session hears about the restart with every cause', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-notice-'))
  const host = fakeHost()
  writePending(dir, [
    // Nobody asked for a note here, and the cause still belongs in the notice:
    // it reports the restart, not the request.
    { id: '60', cause: 'обновили плагин', needNotify: false, sessionId: 'sess-1' },
    { id: '61', cause: 'поправили конфиг', needNotify: true, sessionId: 'sess-2' },
  ])
  apply(host.ctx, {
    stateDir: dir,
    notifyDelayMs: 5,
    language: 'ru',
    restartNotice: true,
    restartNoticeSessionId: 'sess-boss',
  })
  await wait(150)
  const notice = host.followed.find(note => note.id === 'sess-boss')
  assert.ok(notice, 'the configured session was woken')
  assert.match(notice.text, /обновили плагин; поправили конфиг/)
  assert.equal(host.followed.filter(note => note.id === 'sess-boss').length, 1, 'one notice, not one per request')
  assert.ok(host.followed.some(note => note.id === 'sess-2'), 'the requesting session still gets its own note')
  assert.equal(existsSync(join(dir, 'pending.json')), false)
  rmSync(dir, { recursive: true, force: true })
})

test('a custom notice is the user text, a blank line, then the causes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-custom-'))
  const host = fakeHost()
  writePending(dir, [{ id: '62', cause: 'обновили плагин', needNotify: false, sessionId: 'sess-1' }])
  apply(host.ctx, {
    stateDir: dir,
    notifyDelayMs: 5,
    language: 'ru',
    restartNotice: true,
    restartNoticeSessionId: 'sess-boss',
    restartNoticeMode: 'custom',
    restartNoticeText: 'Сервер поднялся.',
  })
  await wait(150)
  const notice = host.followed.find(note => note.id === 'sess-boss')
  assert.ok(notice)
  assert.equal(notice.text, 'Сервер поднялся.\n\nПричины:\n— обновили плагин')
  rmSync(dir, { recursive: true, force: true })
})

test('no notice while the switch is off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-nonotice-'))
  const host = fakeHost()
  writePending(dir, [{ id: '63', cause: 'без уведомления', needNotify: false, sessionId: 'sess-1' }])
  apply(host.ctx, { stateDir: dir, notifyDelayMs: 5, restartNoticeSessionId: 'sess-boss' })
  await wait(150)
  assert.equal(host.followed.length, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('a note whose service comes up late is still delivered, without another restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-late-'))
  // sessionController appears after the first attempt has already given up:
  // exactly what happened on this host, where the service arrived two seconds
  // after the start-up delivery began.
  const host = fakeHost({ delayServices: { schedule: 30 } })
  writePending(dir, [{ id: '46', cause: 'поздний сервис', needNotify: true, sessionId: 'sess-9' }])
  apply(host.ctx, { stateDir: dir, notifyDelayMs: 1 })
  await wait(500)
  assert.equal(host.followed.length, 1)
  assert.equal(host.followed[0].id, 'sess-9')
  assert.equal(existsSync(join(dir, 'pending.json')), false)
  rmSync(dir, { recursive: true, force: true })
})

test('need_notify off means no wake-up, and the file is cleared', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-silent-'))
  const host = fakeHost()
  writePending(dir, [{ id: '43', cause: 'тихая установка', needNotify: false, sessionId: 'sess-1' }])
  apply(host.ctx, { stateDir: dir, notifyDelayMs: 5 })
  await wait(60)
  assert.equal(host.followed.length, 0)
  assert.equal(existsSync(join(dir, 'pending.json')), false)
})

test('a pending file newer than this process is dropped: that restart never happened', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-stale-'))
  const host = fakeHost()
  writePending(dir, [{ id: '44', cause: 'отказ по способу выхода', needNotify: true, sessionId: 'sess-1' }], 0)
  apply(host.ctx, { stateDir: dir, notifyDelayMs: 5 })
  await wait(60)
  assert.equal(host.followed.length, 0)
  assert.equal(existsSync(join(dir, 'pending.json')), false)
})

test('an undeliverable note is kept for the next question instead of being lost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-retry-'))
  const host = fakeHost({ resolve: () => ({ error: new Error('schedule: subagent_session') }) })
  writePending(dir, [{ id: '45', cause: 'повод', needNotify: true, sessionId: 'sess-1' }])
  apply(host.ctx, { stateDir: dir, notifyDelayMs: 5 })
  await wait(200)
  // A subagent session can never be woken, so retrying forever would only hide
  // it: the record is dropped with a warning.
  assert.equal(existsSync(join(dir, 'pending.json')), false)
  assert.equal(host.followed.length, 0)
  rmSync(dir, { recursive: true, force: true })
})

/** One running job view, as the registry hands it out. */
function job (id, owner, label, ageMs = 60000, status = 'running') {
  return { id, kind: 'bash', label, status, ...(owner ? { owner } : {}), startedAt: Date.now() - ageMs }
}

test('a restart that kills jobs writes them to the pending file, grouped by owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-kill-'))
  const host = fakeHost({
    // A job is reachable only through the live agent that owns it: `list()`
    // without a caller answers unowned jobs alone, so both owners stay listed.
    agents: [
      { id: 'a1', session: { id: 'sess-1' }, status: 'idle' },
      { id: 'a2', session: { id: 'sess-2' }, status: 'idle' },
    ],
    jobs: [
      job('bash-1', 'sess-1', 'build'),
      job('bash-2', 'sess-1', 'tests', 30000, 'stopping'),
      job('bash-3', 'sess-2', 'git fetch', 5000),
      // No owner: there is nobody to tell, so it must not end up in a note.
      job('bash-4', '', 'detached', 1000),
    ],
  })
  apply(host.ctx, {
    stateDir: dir,
    notifyDelayMs: 60000,
    quietSeconds: 0,
    exitMethod: 'command',
    exitCommand: 'true',
    language: 'ru',
  })
  const restart = host.registered.find(tool => tool.name === 'dsh_restart')
  const answer = await restart.execute({ cause: 'обновили плагин', need_notify: false })
  assert.equal(answer.status, 'ok')
  // Two heartbeats: the first opens the zero-length quiet window, the second fires.
  await wait(2600)
  const state = JSON.parse(readFileSync(join(dir, 'pending.json'), 'utf8'))
  assert.equal(state.version, 2)
  assert.equal(state.jobLoss.length, 2, 'one entry per owning session, none for the unowned job')
  const bySession = new Map(state.jobLoss.map(group => [group.sessionId, group.jobs.map(entry => entry.id)]))
  assert.deepEqual(bySession.get('sess-1'), ['bash-1', 'bash-2'])
  assert.deepEqual(bySession.get('sess-2'), ['bash-3'])
  rmSync(dir, { recursive: true, force: true })
})

test('one note per session carries the cause and every job that session lost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-onenote-'))
  const host = fakeHost()
  writePending(
    dir,
    [{ id: '50', cause: 'обновили плагин', needNotify: true, sessionId: 'sess-1' }],
    120,
    { jobLoss: [
      { sessionId: 'sess-1', jobs: [
        { id: 'bash-1', kind: 'bash', label: 'build', elapsedMs: 65000 },
        { id: 'bash-2', kind: 'bash', label: 'tests', elapsedMs: 20000 },
      ] },
      { sessionId: 'sess-2', jobs: [{ id: 'bash-3', kind: 'bash', label: 'sync', elapsedMs: 4000 }] },
    ] },
  )
  apply(host.ctx, { stateDir: dir, notifyDelayMs: 5, language: 'ru' })
  await wait(120)
  assert.equal(host.followed.length, 2, 'two sessions, two notes — not four')
  const first = host.followed.find(note => note.id === 'sess-1')
  assert.match(first.text, /обновили плагин/, 'the restart cause stays in the same note')
  assert.match(first.text, /bash-1/)
  assert.match(first.text, /bash-2/)
  assert.match(first.text, /1 мин 5 с/, 'a job that ran a minute is reported as such')
  assert.match(first.text, /оборвано фоновых задач: 2/)
  const second = host.followed.find(note => note.id === 'sess-2')
  assert.match(second.text, /bash-3/)
  assert.doesNotMatch(second.text, /bash-1/, 'a note never mentions another session\'s jobs')
  assert.equal(existsSync(join(dir, 'pending.json')), false, 'delivered notes leave no pending file')
  rmSync(dir, { recursive: true, force: true })
})

test('a killed job is reported even when its session asked for no restart note', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-jobonly-'))
  const host = fakeHost()
  writePending(dir, [], 120, { jobLoss: [{ sessionId: 'sess-7', jobs: [{ id: 'bash-9', kind: 'bash', label: 'deploy', elapsedMs: 3000 }] }] })
  apply(host.ctx, { stateDir: dir, notifyDelayMs: 5, language: 'ru' })
  await wait(120)
  assert.equal(host.followed.length, 1)
  assert.equal(host.followed[0].id, 'sess-7')
  assert.match(host.followed[0].text, /bash-9/)
  assert.doesNotMatch(host.followed[0].text, /перезапущен по запросу/, 'no restart request from that session, so no cause part')
  rmSync(dir, { recursive: true, force: true })
})

test('an undeliverable job note is kept, jobs and all, for the next start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-jobretry-'))
  const host = fakeHost({ resolve: () => ({ error: new Error('schedule: no such session') }) })
  writePending(dir, [], 120, { jobLoss: [{ sessionId: 'sess-8', jobs: [{ id: 'bash-5', kind: 'bash', label: 'x', elapsedMs: 1000 }] }] })
  apply(host.ctx, { stateDir: dir, notifyDelayMs: 5 })
  await wait(300)
  const kept = JSON.parse(readFileSync(join(dir, 'pending.json'), 'utf8'))
  assert.deepEqual(kept.jobLoss.map(group => group.sessionId), ['sess-8'])
  assert.equal(kept.records.length, 0)
  rmSync(dir, { recursive: true, force: true })
})
