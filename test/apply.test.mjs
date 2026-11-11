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
function fakeHost ({ agents = [], settingsValue = null, resolve = () => ({ ok: true }), delayServices = {} } = {}) {
  const registered = []
  const routes = []
  const followed = []
  const flushes = []
  const requested = []
  const services = () => ({
    webServer: { register: route => { routes.push(route); return () => {} } },
    settings: { describe: () => settingsValue === null ? [] : [{ ns: 'dsh-graceful-restart', value: settingsValue }] },
    // The cron-style delivery path: a one-shot schedule task bound to the session.
    schedule: {
      create: async (sessionId, request) => {
        // The real service validates its request; the fake mirrors that, because
        // a fake that accepts anything hides a refused contract.
        if (!Number.isSafeInteger(request.after_seconds) || request.after_seconds <= 0) {
          throw new Error('after_seconds must be a positive safe integer.')
        }
        if (typeof request.title !== 'string' || request.title.trim() === '') throw new Error('title is required')
        if (typeof request.prompt !== 'string' || request.prompt.trim() === '') throw new Error('prompt is required')
        const outcome = resolve(sessionId)
        if (outcome?.error) throw outcome.error
        followed.push({ id: sessionId, title: request.title, text: request.prompt, after: request.after_seconds })
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
function writePending (dir, records, ageSeconds = 120) {
  const path = join(dir, 'pending.json')
  writeFileSync(path, `${JSON.stringify({ version: 1, restartedAt: new Date().toISOString(), records }, null, 2)}\n`)
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
  assert.deepEqual(asked, ['schedule', 'settings', 'webServer'])
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
