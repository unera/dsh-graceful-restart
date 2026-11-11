/**
 * The parts worth pinning down without a host: the quiet-window state machine,
 * the exit plan, the three dictionaries and the shape of the two tool
 * definitions. Everything here runs on a fake clock and a fake agent list.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  Config,
  RestartQueue,
  causesOf,
  createTools,
  dictionary,
  exitPlan,
  format,
  normalizeConfig,
  resolveStateDir,
} from '../index.mjs'

/** A queue with a hand-cranked clock and a mutable agent list. */
function harness ({ quietMs = 3000, agents = [], pollMs = 1000 } = {}) {
  let clock = 1000
  const state = { agents, fired: [] }
  const queue = new RestartQueue({
    quietMs,
    pollMs,
    now: () => clock,
    listAgents: () => state.agents,
    onReady: records => state.fired.push(records),
    setTimer: () => ({ fake: true }),
    clearTimer: () => {},
  })
  return {
    queue,
    state,
    tick: () => queue.tick(),
    advance: ms => { clock += ms },
  }
}

test('a request does not fire while an agent is running', () => {
  const { queue, state, tick, advance } = harness()
  state.agents = [{ id: 'a', status: 'running' }]
  queue.request({ cause: 'update' })
  advance(60000)
  assert.equal(tick().fire, false)
  assert.deepEqual(state.fired, [])
})

test('the quiet window must pass before anything happens', () => {
  const { queue, state, tick, advance } = harness({ quietMs: 3000 })
  state.agents = [{ id: 'a', status: 'idle' }]
  queue.request({ cause: 'update' })
  assert.equal(tick().fire, false) // window opens here
  advance(2000)
  assert.equal(tick().fire, false)
  advance(1001)
  assert.equal(tick().fire, true)
  assert.equal(state.fired.length, 1)
  assert.equal(state.fired[0][0].cause, 'update')
})

test('a session that appears during the window restarts the window', () => {
  const { queue, state, tick, advance } = harness({ quietMs: 3000 })
  state.agents = [{ id: 'a', status: 'idle' }]
  queue.request({ cause: 'update' })
  tick()
  advance(2500)
  state.agents = [{ id: 'a', status: 'idle' }, { id: 'b', status: 'idle' }]
  assert.equal(tick().fire, false)
  advance(1000)
  assert.equal(tick().fire, false, 'the old window must not carry over')
  advance(2001)
  assert.equal(tick().fire, true)
})

test('work that starts again during the window closes it', () => {
  const { queue, state, tick, advance } = harness({ quietMs: 2000 })
  state.agents = [{ id: 'a', status: 'idle' }]
  queue.request({ cause: 'update' })
  tick()
  advance(1500)
  state.agents = [{ id: 'a', status: 'running' }]
  assert.equal(tick().fire, false)
  state.agents = [{ id: 'a', status: 'idle' }]
  tick()
  advance(1999)
  assert.equal(tick().fire, false)
  advance(2)
  assert.equal(tick().fire, true)
})

test('cancelling the last request cancels the restart, one of two does not', () => {
  const { queue, state, tick, advance } = harness({ quietMs: 1000 })
  state.agents = [{ id: 'a', status: 'idle' }]
  const first = queue.request({ cause: 'one' })
  const second = queue.request({ cause: 'two' })
  assert.notEqual(first.id, second.id)
  assert.equal(queue.cancel(first.id).remaining, 1)
  tick()
  advance(1001)
  assert.equal(tick().fire, true, 'one live request still restarts the host')

  const { queue: clean, state: cleanState, tick: cleanTick } = harness({ quietMs: 1000 })
  cleanState.agents = [{ id: 'a', status: 'idle' }]
  const only = clean.request({ cause: 'one' })
  assert.deepEqual(clean.cancel(only.id), { found: true, remaining: 0 })
  assert.deepEqual(clean.cancel(only.id), { found: false, remaining: 0 })
})

test('a fired queue never fires twice', () => {
  const { queue, state, tick, advance } = harness({ quietMs: 0 })
  state.agents = []
  queue.request({ cause: 'update' })
  assert.equal(tick().fire, true, 'a zero window fires on the first heartbeat')
  advance(60000)
  assert.equal(tick().fire, false)
  assert.equal(state.fired.length, 1)
})

test('config normalization never throws and keeps values inside bounds', () => {
  assert.deepEqual(normalizeConfig({}), {
    exitMethod: 'systemctl',
    serviceUnit: 'dsh-server',
    exitCommand: '',
    quietSeconds: 10,
    reasonFile: '',
    language: 'en',
    stateDir: '',
  })
  assert.equal(normalizeConfig({ exitMethod: 'nonsense' }).exitMethod, 'systemctl')
  assert.equal(normalizeConfig({ quietSeconds: 99999 }).quietSeconds, 600)
  assert.equal(normalizeConfig({ quietSeconds: -5 }).quietSeconds, 10)
  assert.equal(normalizeConfig({ exitCommand: '  reboot  ' }).exitCommand, 'reboot')
  assert.equal(normalizeConfig({ language: 'RU' }).language, 'RU')
})

test('every field the Config schema declares is handled by normalizeConfig', () => {
  const declared = Object.keys(Config({})).sort()
  assert.deepEqual(declared, Object.keys(normalizeConfig({})).sort())
})

test('the state directory follows DSH_HOME', () => {
  assert.equal(resolveStateDir({ stateDir: '/tmp/x' }), '/tmp/x')
  assert.equal(resolveStateDir({}, { DSH_HOME: '/home/u/.dsh' }), '/home/u/.dsh/graceful-restart')
})

test('every exit method produces a runnable plan or a clear refusal', () => {
  assert.equal(exitPlan({ exitMethod: 'systemctl', serviceUnit: 'dsh-server' }).kind, 'systemctl')
  assert.equal(exitPlan({ exitMethod: 'kill' }).self, 'SIGTERM')
  assert.equal(exitPlan({ exitMethod: 'exit' }).self, 'exit')
  assert.equal(exitPlan({ exitMethod: 'command', exitCommand: 'reboot' }).detail, 'reboot')
  assert.throws(() => exitPlan({ exitMethod: 'command', exitCommand: '' }), /exitCommand/)
})

test('causes are joined, and an empty set says so', () => {
  assert.equal(causesOf([{ cause: 'a' }, { cause: ' b ' }, { cause: '' }], dictionary('en')), 'a;  b'.replace('  ', ' '))
  assert.equal(causesOf([], dictionary('en')), 'no cause given')
  assert.equal(causesOf([], dictionary('ru')), 'причина не указана')
})

test('the three dictionaries carry the same keys', () => {
  const en = Object.keys(dictionary('en')).sort()
  assert.deepEqual(Object.keys(dictionary('ru')).sort(), en)
  assert.deepEqual(Object.keys(dictionary('zh')).sort(), en)
  for (const language of ['en', 'ru', 'zh']) {
    const dict = dictionary(language)
    for (const key of ['restartDescription', 'cancelDescription']) {
      assert.ok(dict[key].length > 120, `${language}.${key} must explain the contract`)
    }
    assert.match(dict.restartDescription, /subagent/i.test(dict.restartDescription) ? /.*/ : /subagent|子代理|субагент/i)
  }
  assert.equal(dictionary('de').scheduled, dictionary('en').scheduled, 'unknown language falls back to English')
})

test('placeholders are filled, unknown ones survive', () => {
  assert.equal(format('x {a} y {b}', { a: 1 }), 'x 1 y {b}')
})

test('both tool definitions are model-facing and globally registrable', () => {
  const registered = []
  const tools = createTools({
    dict: () => dictionary('en'),
    register: request => { registered.push(request); return { id: '42' } },
    cancel: () => ({ found: true, remaining: 0 }),
    pending: () => 1,
  })
  assert.deepEqual(tools.map(tool => tool.name), ['dsh_restart', 'dsh_restart_cancel'])
  for (const tool of tools) {
    assert.ok(tool.description.length > 400, `${tool.name} must explain when and how to use it`)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }
})

test('dsh_restart records the cause, the notify flag and the calling session', async () => {
  const registered = []
  const [restart] = createTools({
    dict: () => dictionary('ru'),
    register: request => { registered.push(request); return { id: '77' } },
    cancel: () => ({ found: true, remaining: 0 }),
    pending: () => 1,
  })
  const value = await restart.execute(
    { cause: 'обновили dsh-im', need_notify: true },
    { agent: { session: { id: 'sess-1' } } },
  )
  assert.deepEqual(value, { status: 'ok', message: dictionary('ru').scheduled, id: '77', pending: 1 })
  assert.deepEqual(registered[0], { cause: 'обновили dsh-im', needNotify: true, sessionId: 'sess-1' })
})

test('dsh_restart_cancel reports an unknown id as an error, not as a cancel', async () => {
  const [, cancel] = createTools({
    dict: () => dictionary('zh'),
    register: () => ({ id: '1' }),
    cancel: () => ({ found: false, remaining: 2 }),
    pending: () => 2,
  })
  const value = await cancel.execute({ id: 'nope' })
  assert.equal(value.status, 'error')
  assert.equal(value.cancelled, false)
  assert.equal(value.pending, 2)
})
