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
  composeNotice,
  composeNotes,
  createTools,
  dictionary,
  elapsedText,
  exitPlan,
  format,
  mergeJobLoss,
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

test('a running background job holds the restart only when the option asks for it', () => {
  const running = [{ id: 'bash-1', label: 'npm run dev', status: 'running' }]
  const agents = [{ id: 'a', status: 'idle' }]

  const ignored = new RestartQueue({
    quietMs: 0,
    pollMs: 1000,
    now: () => 5000,
    listAgents: () => agents,
    listJobs: () => running,
    waitForJobs: () => false,
    onReady: () => {},
    setTimer: () => ({ fake: true }),
    clearTimer: () => {},
  })
  ignored.request({ cause: 'update' })
  ignored.tick() // the first heartbeat only opens the window
  assert.equal(ignored.tick().fire, true, 'by default a job does not postpone anything')

  const counted = new RestartQueue({
    quietMs: 0,
    pollMs: 1000,
    now: () => 5000,
    listAgents: () => agents,
    listJobs: () => running,
    waitForJobs: () => true,
    onReady: () => {},
    setTimer: () => ({ fake: true }),
    clearTimer: () => {},
  })
  counted.request({ cause: 'update' })
  counted.tick()
  const tick = counted.tick()
  assert.equal(tick.fire, false, 'the job holds the window')
  assert.deepEqual(tick.busy, ['bash-1'])
})

test('a settled job releases the window', () => {
  let jobs = [{ id: 'bash-1', label: 'build', status: 'running' }]
  const queue = new RestartQueue({
    quietMs: 0,
    pollMs: 1000,
    now: () => 5000,
    listAgents: () => [],
    listJobs: () => jobs,
    waitForJobs: () => true,
    onReady: () => {},
    setTimer: () => ({ fake: true }),
    clearTimer: () => {},
  })
  queue.request({ cause: 'update' })
  queue.tick()
  assert.equal(queue.tick().fire, false, 'a running job holds the window')
  jobs = [{ id: 'bash-1', label: 'build', status: 'completed' }]
  queue.tick() // the window reopens now that the job is gone
  assert.equal(queue.tick().fire, true, 'a completed job is not work any more')
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
    waitForJobs: false,
    notifyJobOwners: true,
    restartNotice: false,
    restartNoticeSessionId: '',
    restartNoticeMode: 'standard',
    restartNoticeText: '',
    language: 'en',
    stateDir: '',
  })
  assert.equal(normalizeConfig({ exitMethod: 'nonsense' }).exitMethod, 'systemctl')
  assert.equal(normalizeConfig({ quietSeconds: 99999 }).quietSeconds, 600)
  assert.equal(normalizeConfig({ quietSeconds: -5 }).quietSeconds, 10)
  assert.equal(normalizeConfig({ exitCommand: '  reboot  ' }).exitCommand, 'reboot')
  assert.equal(normalizeConfig({ language: 'RU' }).language, 'RU')
  assert.equal(normalizeConfig({}).waitForJobs, false)
  assert.equal(normalizeConfig({ waitForJobs: true }).waitForJobs, true)
  assert.equal(normalizeConfig({}).notifyJobOwners, true, 'the owner note is on unless explicitly refused')
  assert.equal(normalizeConfig({ notifyJobOwners: false }).notifyJobOwners, false)
  assert.equal(normalizeConfig({ notifyJobOwners: 'no' }).notifyJobOwners, true)
  assert.equal(normalizeConfig({ restartNotice: 'yes' }).restartNotice, false, 'only a real true switches the notice on')
  assert.equal(normalizeConfig({ restartNotice: true, restartNoticeSessionId: '  sess-1 ' }).restartNoticeSessionId, 'sess-1')
  assert.equal(normalizeConfig({ restartNoticeMode: 'nonsense' }).restartNoticeMode, 'standard')
  assert.equal(normalizeConfig({ restartNoticeMode: 'CUSTOM' }).restartNoticeMode, 'custom')
  assert.equal(normalizeConfig({ restartNoticeText: '\n привет\n\n' }).restartNoticeText, 'привет', 'inner line breaks survive, outer whitespace does not')
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

test('the fixed-session notice names every cause, even of requests that wanted no note', () => {
  const records = [
    { id: '1', cause: 'обновили плагин', needNotify: false, sessionId: 'sess-1' },
    { id: '2', cause: 'поправили конфиг', needNotify: true, sessionId: 'sess-2' },
    { id: '3', cause: 'обновили плагин', needNotify: true, sessionId: 'sess-3' },
  ]
  const notice = composeNotice({ records }, { enabled: true, sessionId: 'sess-boss' }, dictionary('ru'))
  assert.equal(notice.sessionId, 'sess-boss')
  assert.match(notice.prompt, /обновили плагин; поправили конфиг/, 'every distinct cause, once each')
  assert.ok(notice.title.length > 0, 'a schedule task needs a title')
})

test('a custom notice is the user text, a blank line, then the causes', () => {
  const records = [{ id: '1', cause: 'обновили плагин' }, { id: '2', cause: 'поправили конфиг' }]
  const notice = composeNotice({ records }, { enabled: true, sessionId: 's', mode: 'custom', text: '  Сервер поднялся.  ' }, dictionary('ru'))
  assert.deepEqual(notice.prompt.split('\n'), [
    'Сервер поднялся.',
    '',
    'Причины:',
    '— обновили плагин',
    '— поправили конфиг',
  ])
})

test('a custom notice without causes keeps the blank line off', () => {
  const notice = composeNotice({ records: [] }, { enabled: true, sessionId: 's', mode: 'custom', text: 'Готово.' }, dictionary('ru'))
  assert.equal(notice.prompt, 'Готово.')
})

test('no notice without the switch or without a session id', () => {
  const records = [{ id: '1', cause: 'причина' }]
  assert.equal(composeNotice({ records }, { enabled: false, sessionId: 's' }), null)
  assert.equal(composeNotice({ records }, { enabled: true, sessionId: '   ' }), null)
  assert.equal(composeNotice({ records }, {}), null)
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

test('a refused registration becomes an error result, not a thrown call', async () => {
  const [restart] = createTools({
    dict: () => dictionary('ru'),
    register: () => { throw new Error(dictionary('ru').badExit) },
    cancel: () => ({ found: false, remaining: 0 }),
    pending: () => 0,
  })
  const value = await restart.execute({ cause: 'x' }, {})
  assert.equal(value.status, 'error')
  assert.equal(value.id, '')
  assert.match(value.message, /команда/)
})

test('a restart refused at the last step leaves the requests pending', () => {
  let calls = 0
  const queue = new RestartQueue({
    quietMs: 0,
    pollMs: 1000,
    now: () => 5000,
    listAgents: () => [],
    onReady: () => { calls += 1; return false },
    setTimer: () => ({ fake: true }),
    clearTimer: () => {},
  })
  queue.request({ cause: 'update' })
  const first = queue.tick()
  assert.equal(first.fire, false, 'a refused restart is not reported as fired')
  assert.equal(queue.pending().length, 1, 'the request survives a refused exit')
  assert.equal(calls, 1)
  // The paused queue does not keep hammering on its own: the next request
  // re-arms it, which is what a fixed setting followed by a new call looks like.
  queue.request({ cause: 'again' })
  assert.equal(queue.tick().fire, false)
  assert.equal(calls, 2)
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

test('the job-owner switch is on by default and can be turned off', () => {
  assert.equal(normalizeConfig({}).notifyJobOwners, true)
  assert.equal(normalizeConfig({ notifyJobOwners: false }).notifyJobOwners, false)
  assert.equal(normalizeConfig({ notifyJobOwners: 'no' }).notifyJobOwners, true, 'only an explicit false disables it')
})

test('a duration reads in seconds, minutes or hours', () => {
  const en = dictionary('en')
  assert.equal(elapsedText(4200, en), '4s')
  assert.equal(elapsedText(65000, en), '1m 5s')
  assert.equal(elapsedText(3 * 3600 * 1000 + 120000, en), '3h 2m')
  assert.equal(elapsedText(-5000, en), '0s', 'a clock that went backwards is not a negative duration')
  assert.equal(elapsedText(65000, dictionary('ru')), '1 мин 5 с')
})

test('job losses fold into one entry per session, jobs deduplicated by id', () => {
  const merged = mergeJobLoss(
    [{ sessionId: 's1', jobs: [{ id: 'bash-1', elapsedMs: 10 }, { id: 'bash-2', elapsedMs: 20 }] }],
    [
      { sessionId: 's1', jobs: [{ id: 'bash-2', elapsedMs: 20 }, { id: 'bash-3', elapsedMs: 30 }] },
      { sessionId: 's2', jobs: [{ id: 'bash-4', elapsedMs: 40 }] },
      { sessionId: 's3', jobs: [] },
      { jobs: [{ id: 'bash-5' }] },
    ],
  )
  assert.deepEqual(merged.map(group => group.sessionId), ['s1', 's2'])
  assert.deepEqual(merged[0].jobs.map(job => job.id), ['bash-1', 'bash-2', 'bash-3'])
})

test('notes: one per session, the cause and its own jobs, never another session\'s', () => {
  const d = dictionary('ru')
  const notes = composeNotes({
    records: [
      { id: '1', cause: 'обновили плагин', needNotify: true, sessionId: 's1' },
      { id: '2', cause: 'тихая установка', needNotify: false, sessionId: 's2' },
      { id: '3', cause: 'второй повод', needNotify: true, sessionId: 's1' },
    ],
    jobLoss: [
      { sessionId: 's1', jobs: [{ id: 'bash-1', kind: 'bash', label: 'build', elapsedMs: 65000 }, { id: 'bash-2', kind: 'bash', label: '', elapsedMs: 3000 }] },
      { sessionId: 's2', jobs: [{ id: 'bash-3', kind: 'bash', label: 'sync', elapsedMs: 500 }] },
      { sessionId: 's4', jobs: [{ id: 'bash-9', kind: 'bash', label: 'ночная', elapsedMs: 1000 }] },
    ],
  }, d)
  assert.equal(notes.length, 3, 'two sessions that asked, plus the one that only lost a job')
  const s1 = notes.find(note => note.sessionId === 's1')
  assert.match(s1.prompt, /обновили плагин; второй повод/)
  assert.match(s1.prompt, /bash-1/)
  assert.match(s1.prompt, /bash-2/)
  assert.doesNotMatch(s1.prompt, /bash-3/)
  assert.match(s1.prompt, /«build»/)
  assert.doesNotMatch(s1.prompt, /«»/, 'a job without a label is not quoted into «»')
  const s2 = notes.find(note => note.sessionId === 's2')
  assert.doesNotMatch(s2.prompt, /перезапущен по запросу/, 'need_notify was off: only the job part')
  assert.match(s2.prompt, /bash-3/)
  assert.equal(s2.title, d.jobLossTitle)
  const s4 = notes.find(note => note.sessionId === 's4')
  assert.equal(s4.title, d.jobLossTitle)
  assert.match(s4.prompt, /ночная/)
})

test('a note keeps its cause when no cause was given at all', () => {
  const d = dictionary('ru')
  const notes = composeNotes({ records: [{ id: '1', cause: '   ', needNotify: true, sessionId: 's1' }] }, d)
  assert.equal(notes.length, 1)
  assert.match(notes[0].prompt, new RegExp(d.noCause))
})
