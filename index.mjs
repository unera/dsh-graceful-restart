/**
 * dsh-graceful-restart — deferred, idle-aware restart of the DSH host.
 *
 * Restarting dsh-server from inside a session is normally a footgun: the
 * process that answers the turn dies, and the answer dies with it. This plugin
 * makes it a recorded request instead of a signal:
 *
 *   - `dsh_restart` registers a request with its own id and returns at once;
 *   - a watcher polls every live agent (subagents included) and only opens a
 *     quiet window when nothing is running; it then re-checks once a second
 *     that no new session appeared before ending the process;
 *   - every cause an agent supplied is written to the event log before the
 *     process goes down, and the pending notifications are persisted so that
 *     the freshly started host can wake the sessions that asked for one;
 *   - `dsh_restart_cancel(id)` drops one request; the restart is cancelled only
 *     once every registered request is gone.
 *
 * A post-restart note is a durable schedule task: `ctx.schedule.create()` bound
 * to the session that asked for it, exactly how cron delivers its reminders. The
 * note therefore survives the restart as a one-shot reminder the schedule service
 * delivers on its own, with no dependency on dsh-im and no race against the
 * host's start-up order.
 *
 * @module dsh-graceful-restart
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import z from '@deepseek-ai/schemastery'

/** Stable Loader identity; must equal the package name so the bundle row and the client row agree. */
export const name = 'dsh-graceful-restart'

/** Services the tools need; `agents` also answers "is anything still working". */
export const inject = ['tools', 'agents']

/** Poll period of the watcher. The spec asks for a one-second heartbeat. */
const POLL_MS = 1000

/** Path the settings card polls for uptime and the quiet-window counters. */
export const STATUS_PATH = '/api/graceful-restart/status'

/** How long a note keeps trying to reach its session before it is kept for later. */
const NOTIFY_DEADLINE_MS = 20000

/** How often a note re-checks whether the schedule service has come up yet. */
const NOTIFY_POLL_MS = 250

/** Delay between attempts against a service that is up but refusing. */
const NOTIFY_RETRY_MS = 2000

/** Sleep that never keeps the process alive on its own. */
function sleep (ms) {
  return new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() })
}

const DEFAULT_QUIET_SECONDS = 10

/* ------------------------------------------------------------------ config */

/**
 * Plugin config. Every field is `volatile()` on purpose: the settings service
 * only persists volatile fields, and the browser form on the bundle page edits
 * exactly this namespace, so a non-volatile field would make every save fail.
 */
export const Config = z.object({
  exitMethod: z.string().default('systemctl')
    .description('How the process is ended: systemctl (the only method that comes back by itself under a systemd user unit), command (run `exitCommand`), kill (SIGTERM to itself), exit (process.exit(0)).')
    .volatile(),
  serviceUnit: z.string().default('dsh-server')
    .description('systemd user unit restarted by exitMethod=systemctl.')
    .volatile(),
  exitCommand: z.string().default('')
    .description('Shell command for exitMethod=command, started detached from the dying process. Example: `systemctl --user restart dsh-server`.')
    .volatile(),
  quietSeconds: z.number().min(0).max(600).step(1).default(DEFAULT_QUIET_SECONDS)
    .description('How long the host must stay idle after the last activity before it restarts, with a re-check every second.')
    .volatile(),
  reasonFile: z.string().default('')
    .description('Optional file that receives the causes before the restart, one line. On this host /home/dsh/.cache/dsh-restart-reason.txt is read by the start-up report.')
    .volatile(),
  language: z.string().default('en')
    .description('Language of tool descriptions, tool answers and the post-restart note: en (default), ru, zh.')
    .volatile(),
  stateDir: z.string().default('')
    .description('Where requests, the event log and the pending notifications live. Empty = $DSH_HOME/graceful-restart.')
    .volatile(),
})

/* ------------------------------------------------------------ dictionaries */

/**
 * Three languages, English as the default. The model-facing text and the
 * browser card share one dictionary shape; the card keeps its own copy because
 * it runs in the browser and cannot import this module.
 */
const DICT = {
  en: {
    restartTitle: 'Restart the DSH host when it is idle',
    restartDescription: [
      'Ask the host to restart itself gracefully — the only safe way to restart DSH from inside a session. The restart is deferred, never immediate: a watcher watches every live agent (subagents included), opens a quiet window only when nothing is running, keeps re-checking once a second that no new session appeared, and ends the process after the quiet window has passed.',
      '',
      'Your own turn is activity too, so the restart happens after you finish answering: call this tool, tell the human that the restart is scheduled, and end the turn. Never sleep, poll or otherwise wait for it — waiting keeps the host busy (your turn is what it waits for), so it only lengthens the delay and cannot change the result.',
      '',
      'Use it after installing or updating a plugin, library or dependency, after editing configuration that is only read at boot, or after a service or nginx change — anything that does not take effect in an already running process.',
      '',
      'Every call registers its own request with its own id: repeated calls create separate requests, and the host restarts at most once. The restart stays pending while at least one request is registered; dsh_restart_cancel drops one, and cancelling the last one cancels the restart.',
      '',
      'Set need_notify=true when you want to be told that the restart happened: the session is woken afterwards with a short note naming the causes, so the work you were in the middle of can continue.',
    ].join('\n'),
    restartCause: 'Why the restart is needed, in one short line: what exactly changed (for example "dsh-im updated to 5.10.0"). It is logged and is what the notification and the start-up report quote.',
    restartNotify: 'Wake this session after the restart with a note naming the cause. On = you get a fresh turn once the host is up again; off = the restart stays silent.',
    cancelTitle: 'Cancel one registered restart request',
    cancelDescription: [
      'Drop one restart request that dsh_restart registered. Pass the exact id the call returned.',
      '',
      'The restart itself is cancelled only when every registered request has been cancelled: while one request is still pending, the host restarts even if you cancelled another. Ask dsh_restart again if you need an id you no longer have — that costs one more registration, not a second restart.',
    ].join('\n'),
    cancelId: 'Exact id returned by dsh_restart.',
    scheduled: 'The restart is scheduled and will run as soon as the host is idle. Do not wait for it: waiting only lengthens the delay and cannot change the result. Cancel it with dsh_restart_cancel(id) if it is no longer needed.',
    cancelled: 'Request {id} is cancelled. Pending requests: {pending}.',
    cancelledAll: 'Request {id} is cancelled. No requests are left, so the restart is cancelled too.',
    cancelMissing: 'No pending restart request has id {id}. Nothing was cancelled. Call dsh_restart to register a new one.',
    badExit: 'Nothing was registered: exit method "command" cannot end the host while the exit command is empty, so the request would only die in the log. Set the command on the plugin page (Plugins → dsh-graceful-restart), or switch the exit method to systemctl.',
    notifyTitle: 'DSH restarted on request',
    notify: '🔁 The DSH host restarted on request ({causes}). The process is up again — continue the work you were doing.',
    notifyCauseSeparator: '; ',
    noCause: 'no cause given',
  },
  ru: {
    restartTitle: 'Перезапустить DSH, когда он освободится',
    restartDescription: [
      'Попросить хост аккуратно перезапуститься — единственный безопасный способ перезапустить DSH изнутри сессии. Перезапуск отложенный, не мгновенный: наблюдатель смотрит на всех живых агентов (включая субагентов), открывает окно тишины только когда не работает никто, каждую секунду проверяет, что новых сессий не появилось, и завершает процесс после окна тишины.',
      '',
      'Твой собственный ход — тоже работа, поэтому перезапуск случится после того, как ты ответишь: вызови инструмент, скажи человеку, что перезапуск запланирован, и закончи ход. Не спи, не опрашивай, не жди его — ожидание держит хост занятым (он ждёт именно твой ход), поэтому только удлиняет задержку и ничего не меняет.',
      '',
      'Когда использовать: после установки или обновления плагина, библиотеки, зависимости; после правки конфигурации, которая читается только при старте; после изменения сервиса или nginx — всё, что не подхватывается в уже запущенном процессе.',
      '',
      'Каждый вызов регистрирует собственную заявку со своим id: повторы создают отдельные заявки, а перезапуск случается не более одного раза. Пока жива хоть одна заявка, перезапуск ждёт; dsh_restart_cancel снимает одну, а когда снята последняя — отменяется и перезапуск.',
      '',
      'need_notify=true — попросить разбудить эту сессию после перезапуска: придёт короткая записка с причиной, и работу можно будет продолжить.',
    ].join('\n'),
    restartCause: 'Зачем нужен перезапуск, одной короткой строкой: что именно изменилось (например, «обновлён dsh-im до 5.10.0»). Попадает в лог, в уведомление и в отчёт о старте.',
    restartNotify: 'Разбудить эту сессию после перезапуска запиской с причиной. Вкл = после подъёма хоста придёт новый ход; выкл = перезапуск пройдёт молча.',
    cancelTitle: 'Снять одну заявку на перезапуск',
    cancelDescription: [
      'Снять заявку, которую зарегистрировал dsh_restart. Передай ровно тот id, который вернул вызов.',
      '',
      'Сам перезапуск отменяется только тогда, когда сняты все заявки: пока хоть одна жива, хост перезапустится, даже если другую ты снял. Если id потерялся, вызови dsh_restart снова — это добавит заявку, но не второй перезапуск.',
    ].join('\n'),
    cancelId: 'Точный id, который вернул dsh_restart.',
    scheduled: 'Перезапуск будет выполнен как только это станет возможным. Не пытайтесь его ожидать — это только увеличит интервал ожидания, но к результату не приведёт! Отменить: dsh_restart_cancel(id).',
    cancelled: 'Заявка {id} снята. Осталось заявок: {pending}.',
    cancelledAll: 'Заявка {id} снята. Других заявок нет, поэтому перезапуск отменён.',
    cancelMissing: 'Заявки с id {id} нет. Ничего не отменено. Вызови dsh_restart, чтобы зарегистрировать новую.',
    badExit: 'Заявка не создана: способ выхода "command" не может завершить хост, пока команда пуста — заявка умерла бы только в логе. Заполни команду на странице плагина (Плагины → dsh-graceful-restart) или переключи способ на systemctl.',
    notifyTitle: 'DSH перезапущен по запросу',
    notify: '🔁 DSH перезапущен по запросу ({causes}). Процесс снова работает — можно продолжать работу.',
    notifyCauseSeparator: '; ',
    noCause: 'причина не указана',
  },
  zh: {
    restartTitle: '空闲时重启 DSH 宿主',
    restartDescription: [
      '请宿主自行优雅重启——这是在会话内部重启 DSH 的唯一安全方式。重启是延迟的、不是立即的：看守会观察所有在线代理（含子代理），只有在无人运行时才打开静默窗口，并每秒复查没有新会话出现，静默窗口结束后才结束进程。',
      '',
      '你自己这一轮也属于活动，所以重启发生在你回答之后：调用本工具，告诉人类重启已排期，然后结束这一轮。不要 sleep、不要轮询、不要等待——等待会让宿主保持忙碌（它等的就是你的这一轮），只会拉长延迟，不会改变结果。',
      '',
      '适用场景：安装或升级插件、库、依赖之后；修改了只在启动时读取的配置之后；修改服务或 nginx 之后——任何不会在已运行进程中生效的改动。',
      '',
      '每次调用都会登记一条带独立 id 的请求：重复调用会产生多条请求，而宿主最多重启一次。只要还有一条请求存在，重启就处于等待状态；dsh_restart_cancel 撤销一条，撤销最后一条才取消重启。',
      '',
      'need_notify=true 表示希望被叫醒：重启后会向该会话投递一条写明原因的简短消息，工作可以继续。',
    ].join('\n'),
    restartCause: '用一行说明为什么需要重启：具体改了什么（例如 “dsh-im 升级到 5.10.0”）。会写入日志、通知和启动报告。',
    restartNotify: '重启后叫醒本会话并附上原因。开 = 宿主恢复后会有新的一轮；关 = 重启静默进行。',
    cancelTitle: '撤销一条已登记的重启请求',
    cancelDescription: [
      '撤销 dsh_restart 登记的一条请求，传入调用返回的确切 id。',
      '',
      '只有所有请求都被撤销，重启才会被取消：只要还有一条在等待，即使撤销了另一条，宿主仍会重启。如果 id 丢了，再调用一次 dsh_restart 即可——那只会多一条请求，不会多一次重启。',
    ].join('\n'),
    cancelId: 'dsh_restart 返回的确切 id。',
    scheduled: '重启会在可能时立即执行。不要等待它：等待只会拉长间隔，不会改变结果。如不再需要，用 dsh_restart_cancel(id) 取消。',
    cancelled: '请求 {id} 已撤销。剩余请求：{pending}。',
    cancelledAll: '请求 {id} 已撤销。没有其他请求，因此重启也一并取消。',
    cancelMissing: '没有 id 为 {id} 的待处理请求，未做任何撤销。请调用 dsh_restart 重新登记。',
    badExit: '未登记：退出方式为 "command" 但命令为空，宿主无法结束，请求只会死在日志里。请在插件页面（插件 → dsh-graceful-restart）填写命令，或把退出方式改为 systemctl。',
    notifyTitle: 'DSH 已按请求重启',
    notify: '🔁 DSH 已按请求重启（原因：{causes}）。进程已恢复，可以继续工作。',
    notifyCauseSeparator: '；',
    noCause: '未说明原因',
  },
}

/** Pick the dictionary for a language tag, falling back to English. */
export function dictionary (language) {
  const key = String(language ?? '').trim().toLowerCase().split(/[-_]/)[0]
  return DICT[key] ?? DICT.en
}

/** Fill `{name}` placeholders without pulling in a formatter. */
export function format (template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) => (key in vars ? String(vars[key]) : whole))
}

/* ---------------------------------------------------------------- config io */

/**
 * Accept both a validated Config instance and a plain object, and always return
 * a fully populated option set.
 * @param raw - plugin config or a settings-document section.
 * @returns normalized options.
 */
export function normalizeConfig (raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const number = (candidate, fallback) => {
    const n = Number(candidate)
    return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 600) : fallback
  }
  const text = (candidate, fallback = '') => (typeof candidate === 'string' ? candidate.trim() : fallback)
  const method = text(value.exitMethod, 'systemctl').toLowerCase()
  return {
    exitMethod: ['systemctl', 'command', 'kill', 'exit'].includes(method) ? method : 'systemctl',
    serviceUnit: text(value.serviceUnit, 'dsh-server') || 'dsh-server',
    exitCommand: text(value.exitCommand, ''),
    quietSeconds: number(value.quietSeconds, DEFAULT_QUIET_SECONDS),
    reasonFile: text(value.reasonFile, ''),
    language: text(value.language, 'en') || 'en',
    stateDir: text(value.stateDir, ''),
  }
}

/** Directory holding the event log, the pending notifications and the requests. */
export function resolveStateDir (options, env = process.env) {
  if (options?.stateDir) return options.stateDir
  const home = env.DSH_HOME && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : join(homedir(), '.dsh')
  return join(home, 'graceful-restart')
}

/** One line per cause, without empty entries. */
export function causesOf (records, dict = DICT.en) {
  const causes = records.map(record => String(record.cause ?? '').trim()).filter(Boolean)
  return causes.length === 0 ? dict.noCause : causes.join(dict.notifyCauseSeparator)
}

/* ------------------------------------------------------------------- queue */

/**
 * The restart queue: registered requests, the quiet window and the single
 * moment when the process is allowed to end.
 *
 * Kept free of cordis and of `process` so it can be driven by a fake clock in
 * tests; the plugin wires it to `ctx.agents`, the logger and the real exit.
 */
export class RestartQueue {
  /** @type {Map<string, {id: string, cause: string, needNotify: boolean, sessionId: string|null, requestedAt: number}>} */
  requests = new Map()

  /** Timestamp the current quiet window opened, or null when it is not open. */
  quietSince = null

  /** Timer of the poll loop, or null when the queue is not armed. */
  timer = null

  /** Agent ids seen on the previous tick, to notice a session that appeared out of nowhere. */
  seen = new Set()

  /** Job ids already reported as holding the restart, so the log does not repeat them. */
  notedJobs = new Set()

  /** Set once the queue has fired; a fired queue never fires again. */
  fired = false

  /**
   * @param {object} options - queue behaviour.
   * @param {number|(() => number)} options.quietMs - quiet window in milliseconds.
   * @param {number} [options.pollMs] - poll period.
   * @param {() => Array<{id?: string, status?: string}>} [options.listAgents] - live agents.
   * @param {(records: Array<object>) => void} [options.onReady] - called once, when the host may restart.
   * @param {(level: string, text: string) => void} [options.log] - event sink.
   * @param {() => number} [options.now] - clock.
   * @param {(fire: () => void, ms: number) => unknown} [options.setTimer] - interval factory.
   * @param {(timer: unknown) => void} [options.clearTimer] - interval canceller.
   */
  constructor ({
    quietMs = DEFAULT_QUIET_SECONDS * 1000,
    pollMs = POLL_MS,
    listAgents = () => [],
    listJobs = () => [],
    onReady = () => {},
    log = () => {},
    now = () => Date.now(),
    setTimer = (fire, ms) => setInterval(fire, ms),
    clearTimer = timer => clearInterval(timer),
  } = {}) {
    this.quietMsOf = typeof quietMs === 'function' ? quietMs : () => quietMs
    this.pollMs = pollMs
    this.listAgents = listAgents
    this.listJobs = listJobs
    this.onReady = onReady
    this.log = log
    this.now = now
    this.setTimer = setTimer
    this.clearTimer = clearTimer
  }

  /**
   * Register one request.
   * @param {object} input - request facts.
   * @param {string} input.cause - one-line reason.
   * @param {boolean} [input.needNotify] - wake the session afterwards.
   * @param {string|null} [input.sessionId] - session to wake.
   * @returns {object} the stored request.
   */
  request ({ cause, needNotify = false, sessionId = null } = {}) {
    const id = `${this.now()}${String(Math.floor(Math.random() * 900) + 100)}`
    const record = {
      id,
      cause: String(cause ?? '').trim(),
      needNotify: needNotify === true,
      sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null,
      requestedAt: this.now(),
    }
    this.requests.set(id, record)
    // A fresh request restarts the quiet window: the caller is usually still
    // working, and a request must never inherit a window opened before it.
    this.quietSince = this.now()
    this.log('info', `restart request ${id} registered (${record.cause || 'no cause'}); pending ${this.requests.size}`)
    this.arm()
    return record
  }

  /**
   * Drop one request.
   * @param {string} id - request id.
   * @returns {{found: boolean, remaining: number}} outcome.
   */
  cancel (id) {
    const found = this.requests.delete(String(id))
    if (found) this.log('info', `restart request ${id} cancelled; pending ${this.requests.size}`)
    if (this.requests.size === 0) {
      this.quietSince = null
      this.stop()
    }
    return { found, remaining: this.requests.size }
  }

  /** @returns {object[]} registered requests, oldest first. */
  pending () {
    return [...this.requests.values()]
  }

  /** Start polling if there is anything to watch. */
  arm () {
    if (this.fired || this.timer !== null || this.requests.size === 0) return
    this.timer = this.setTimer(() => this.tick(), this.pollMs)
    this.log('info', `restart watcher armed (poll ${this.pollMs}ms, quiet ${this.quietMsOf()}ms)`)
  }

  /** Stop polling without touching the requests. */
  stop () {
    if (this.timer === null) return
    this.clearTimer(this.timer)
    this.timer = null
  }

  /**
   * One heartbeat: decide whether the host is quiet and whether the window has
   * already elapsed.
   * @returns {{busy: string[], quietMs: number, fire: boolean}} what this tick saw.
   */
  tick () {
    if (this.fired) return { busy: [], quietMs: 0, fire: false }
    const now = this.now()
    const agents = this.listAgents() || []
    const ids = new Set(agents.map(agent => String(agent.id ?? '')))
    const appeared = [...ids].some(id => id && !this.seen.has(id))
    this.seen = ids
    const running = agents.filter(agent => agent.status === 'running').map(agent => String(agent.id ?? ''))
    // A background job is work that a restart would kill mid-flight, so it holds
    // the window exactly like a running agent. Never interruptable, no setting.
    const jobs = (this.listJobs() || []).filter(job => job && (job.status === 'running' || job.status === 'stopping'))
    for (const job of jobs) {
      const jobId = String(job.id ?? job.label ?? 'job')
      if (!this.notedJobs.has(jobId)) {
        this.notedJobs.add(jobId)
        this.log('info', `background job ${jobId} (${job.label ?? job.kind ?? 'job'}) is holding the restart`)
      }
    }
    const busy = [...running, ...jobs.map(job => String(job.id ?? job.label ?? 'job'))]
    const quietMs = this.quietMsOf()
    if (busy.length > 0) {
      this.quietSince = null
      return { busy, quietMs, fire: false }
    }
    if (appeared) {
      // A session that appeared during the window means the host is not quiet
      // after all: the window restarts instead of counting through it.
      this.quietSince = now
      this.log('info', `new session appeared, quiet window restarted (${quietMs}ms)`)
      return { busy, quietMs, fire: false }
    }
    if (this.quietSince === null) {
      this.quietSince = now
      this.log('info', `no session is running, quiet window opened (${quietMs}ms)`)
      return { busy, quietMs, fire: false }
    }
    if (now - this.quietSince < quietMs) return { busy, quietMs, fire: false }
    this.fired = true
    this.stop()
    this.log('info', `quiet window passed, restarting (${this.requests.size} request(s))`)
    const settled = this.onReady(this.pending())
    if (settled === false) {
      // The restart could not happen (an unusable exit method, for instance).
      // Keeping the requests and dropping the window means a later request — or
      // a fix in the settings — still gets a restart, instead of a queue that
      // quietly believes it has already fired.
      this.fired = false
      this.quietSince = null
      this.log('warn', 'restart refused at the last step; requests stay pending, watcher paused')
      return { busy, quietMs, fire: false }
    }
    return { busy, quietMs, fire: true }
  }
}

/* -------------------------------------------------------------------- exit */

/**
 * Turn an exit method into something runnable, so the caller never guesses.
 *
 * `systemctl` is the only method that brings the host back by itself on a host
 * whose unit is `Restart=on-failure`: `kill` and `exit` end the process without
 * a restart unless a supervisor decides otherwise.
 *
 * @param {object} options - normalized options.
 * @returns {{kind: string, detail: string, run: (spawnDetached: Function) => void, self?: string}} plan.
 */
export function exitPlan (options) {
  switch (options.exitMethod) {
    case 'command': {
      if (!options.exitCommand) throw new Error('exitMethod=command needs exitCommand')
      return {
        kind: 'command',
        detail: options.exitCommand,
        run: spawnDetached => spawnDetached('/bin/sh', ['-c', options.exitCommand]),
      }
    }
    case 'kill':
      return { kind: 'kill', detail: 'SIGTERM to the host process', self: 'SIGTERM', run: () => {} }
    case 'exit':
      return { kind: 'exit', detail: 'process.exit(0)', self: 'exit', run: () => {} }
    case 'systemctl':
    default:
      return {
        kind: 'systemctl',
        detail: `systemctl --user restart ${options.serviceUnit}`,
        run: spawnDetached => spawnDetached('systemctl', ['--user', 'restart', options.serviceUnit]),
      }
  }
}

/** Start a detached command that outlives this process. */
export function spawnDetached (command, args) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
  return child
}

/* -------------------------------------------------------------------- tools */

const RESTART_PARAMETERS = {
  type: 'object',
  properties: {
    cause: {
      type: 'string',
      description: 'Why the restart is needed, one short line: what exactly changed.',
    },
    need_notify: {
      type: 'boolean',
      description: 'Wake this session after the restart with a note naming the cause.',
    },
  },
  required: ['cause'],
  additionalProperties: false,
}

const RESTART_OUTPUT = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok', 'error'] },
    message: { type: 'string' },
    id: { type: 'string' },
    pending: { type: 'integer' },
  },
  required: ['status', 'message', 'id', 'pending'],
  additionalProperties: false,
}

const CANCEL_PARAMETERS = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Exact id returned by dsh_restart.' },
  },
  required: ['id'],
  additionalProperties: false,
}

const CANCEL_OUTPUT = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok', 'error'] },
    message: { type: 'string' },
    cancelled: { type: 'boolean' },
    pending: { type: 'integer' },
  },
  required: ['status', 'message', 'cancelled', 'pending'],
  additionalProperties: false,
}

/** Text-only model-facing projection of a tool value. */
function renderJson (value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Build the two tool definitions for one language. Written as raw JSON Schema
 * instead of `defineTool`, because `@deepseek-ai/dsh-tools` is not resolvable
 * from a profile plugin on this installation — the registry accepts exactly
 * this shape.
 *
 * @param {object} input - wiring.
 * @param {() => object} input.dict - current dictionary.
 * @param {(request: object) => object} input.register - register one request.
 * @param {(id: string) => {found: boolean, remaining: number}} input.cancel - cancel one request.
 * @param {() => number} input.pending - pending count.
 * @returns {object[]} tool definitions.
 */
export function createTools ({ dict, register, cancel, pending }) {
  const restart = {
    name: 'dsh_restart',
    description: (() => {
      const d = dict()
      return [`${d.restartTitle}.`, '', d.restartDescription].join('\n')
    })(),
    parameters: {
      type: 'object',
      properties: {
        cause: { type: 'string', description: dict().restartCause },
        need_notify: { type: 'boolean', description: dict().restartNotify },
      },
      required: ['cause'],
      additionalProperties: false,
    },
    output: { schema: RESTART_OUTPUT, render: (args, value) => renderJson(value) },
    async execute (args, exec) {
      const d = dict()
      let record
      try {
        record = register({
          cause: args.cause,
          needNotify: args.need_notify === true,
          sessionId: exec?.agent?.session?.id ?? null,
        })
      } catch (error) {
        return { status: 'error', message: String(error?.message ?? error), id: '', pending: pending() }
      }
      return { status: 'ok', message: d.scheduled, id: record.id, pending: pending() }
    },
  }
  const cancelTool = {
    name: 'dsh_restart_cancel',
    description: (() => {
      const d = dict()
      return [`${d.cancelTitle}.`, '', d.cancelDescription].join('\n')
    })(),
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: dict().cancelId } },
      required: ['id'],
      additionalProperties: false,
    },
    output: { schema: CANCEL_OUTPUT, render: (args, value) => renderJson(value) },
    async execute (args) {
      const d = dict()
      const result = cancel(args.id)
      if (!result.found) {
        return {
          status: 'error',
          message: format(d.cancelMissing, { id: args.id }),
          cancelled: false,
          pending: result.remaining,
        }
      }
      return {
        status: 'ok',
        message: result.remaining === 0
          ? format(d.cancelledAll, { id: args.id, pending: 0 })
          : format(d.cancelled, { id: args.id, pending: result.remaining }),
        cancelled: true,
        pending: result.remaining,
      }
    },
  }
  return [restart, cancelTool]
}

/* -------------------------------------------------------------------- host */

/** Read one namespace section out of a settings service, or null. */
export function settingsSectionOf (settings) {
  if (!settings || typeof settings.describe !== 'function') return null
  try {
    const entry = settings.describe().find(candidate => String(candidate?.ns) === name)
    return entry?.value && typeof entry.value === 'object' ? entry.value : null
  } catch {
    return null
  }
}

/**
 * Build the status route answer: the counters the settings card cannot read on
 * its own. Kept pure so the route stays a one-liner and the shape is testable.
 * @param input - process and queue facts.
 * @returns the JSON body object.
 */
export function statusSnapshot ({
  uptimeMs = Math.round(process.uptime() * 1000),
  pid = process.pid,
  now = Date.now(),
  quietSeconds = DEFAULT_QUIET_SECONDS,
  exitMethod = 'systemctl',
  pending = 0,
  busy = 0,
  jobs = 0,
  quiet = null,
} = {}) {
  return {
    ok: true,
    pid,
    startedAt: new Date(now - uptimeMs).toISOString(),
    uptimeMs,
    quietSeconds,
    exitMethod,
    pending,
    busy,
    jobs,
    quiet,
  }
}

/**
 * Wire the plugin: two global tools, the watcher, the exit, and the
 * post-restart wake-up.
 * @param ctx - plugin context.
 * @param config - validated Config instance.
 */
export function apply (ctx, config = {}) {
  let initial = normalizeConfig(config)

  // cordis hands a plugin only the services it declared: `ctx.get('webServer')`
  // asks for something never granted and answers undefined, which is exactly how
  // the uptime route and the post-restart note went missing once. Every optional
  // service is taken through `inject`, and its disappearance is undone with it.
  let liveSettings = null
  let scheduling = null
  let jobRegistry = null

  const options = () => {
    const live = settingsSectionOf(liveSettings)
    return live ? normalizeConfig({ ...initial, ...live }) : initial
  }
  const stateDir = () => resolveStateDir(options())
  const pendingFile = () => join(stateDir(), 'pending.json')
  const eventsFile = () => join(stateDir(), 'events.log')

  const logger = (() => {
    try {
      return typeof ctx.logger === 'function' ? ctx.logger(name) : null
    } catch {
      return null
    }
  })()

  /** One event: to stderr/journald through the cordis logger and to a file that survives rotation. */
  const log = (level, text) => {
    try {
      mkdirSync(stateDir(), { recursive: true })
      appendFileSync(eventsFile(), `${new Date().toISOString()} ${level} ${text}\n`)
    } catch {}
    try {
      const writer = logger?.[level] ?? logger?.info
      if (typeof writer === 'function') writer.call(logger, text)
      else if (level === 'error' || level === 'warn') process.stderr.write(`${name}: ${text}\n`)
    } catch {}
  }

  const dict = () => dictionary(options().language)

  /** Why the configured exit method cannot end the host right now, or null. */
  function exitProblem (current) {
    if (current.exitMethod === 'command' && !current.exitCommand) return 'command'
    return null
  }

  /**
   * Background jobs that are still working.
   *
   * `jobs.list()` without a caller answers only unowned jobs: the registry filters
   * by `job.owner === caller`. Session-owned jobs are therefore collected per live
   * agent, which is the only seam the public API offers.
   *
   * @returns running and stopping job views, deduplicated.
   */
  function runningJobs () {
    if (!jobRegistry || typeof jobRegistry.list !== 'function') return []
    const collected = new Map()
    const take = list => {
      for (const job of list || []) {
        if (job && (job.status === 'running' || job.status === 'stopping')) collected.set(String(job.id ?? job.label), job)
      }
    }
    try {
      take(jobRegistry.list())
      for (const agent of ctx.agents.list()) {
        const sessionId = agent?.session?.id
        if (!sessionId) continue
        try {
          take(jobRegistry.list(sessionId))
        } catch {}
      }
    } catch {}
    return [...collected.values()]
  }

  const queue = new RestartQueue({
    quietMs: () => options().quietSeconds * 1000,
    listAgents: () => ctx.agents.list(),
    listJobs: () => runningJobs(),
    log,
    now: () => Date.now(),
    onReady: records => finish(records),
  })

  /**
   * Persist what the next start must know, then end the host the configured way.
   * @param {object[]} records - requests that made the restart happen.
   */
  function finish (records) {
    const current = options()
    const d = dict()
    const causes = causesOf(records, d)
    let plan
    try {
      plan = exitPlan(current)
    } catch (error) {
      // Refuse before anything durable is written: a pending file from an exit
      // that never happened would wake sessions on a restart that did not occur.
      log('error', `exit plan refused: ${error?.message ?? error}`)
      return false
    }
    log('info', `restarting now; causes: ${causes}`)
    // Notes kept from an earlier restart ride along: a note that could not be
    // placed yet must not be erased by the next restart, or the session that
    // asked for it is forgotten for good.
    let carried = []
    try {
      if (existsSync(pendingFile())) {
        const previous = JSON.parse(readFileSync(pendingFile(), 'utf8'))
        carried = Array.isArray(previous?.records) ? previous.records : []
      }
    } catch {}
    const merged = [...carried.filter(old => old?.id && !records.some(fresh => fresh.id === old.id)), ...records]
    try {
      mkdirSync(stateDir(), { recursive: true })
      writeFileSync(pendingFile(), `${JSON.stringify({
        version: 1,
        restartedAt: new Date().toISOString(),
        causes,
        records: merged,
      }, null, 2)}\n`)
    } catch (error) {
      log('warn', `cannot persist the pending notifications: ${error?.message ?? error}`)
    }
    if (current.reasonFile) {
      try {
        writeFileSync(current.reasonFile, `${records.map(record => record.cause).filter(Boolean).join('; ') || causes}\n`)
      } catch (error) {
        log('warn', `cannot write ${current.reasonFile}: ${error?.message ?? error}`)
      }
    }
    log('info', `exit method: ${plan.kind} (${plan.detail})`)
    if (plan.self === 'SIGTERM') {
      process.kill(process.pid, 'SIGTERM')
      return true
    }
    if (plan.self === 'exit') {
      process.exit(0)
      return true
    }
    try {
      plan.run(spawnDetached)
    } catch (error) {
      log('error', `exit command failed: ${error?.message ?? error}`)
      return false
    }
    return true
  }

  /**
   * Place one durable one-shot reminder on the session that asked for a note.
   *
   * The reminder is a schedule task — the same mechanism cron uses for its own
   * deliveries. `ScheduleService` owns the timer, resumes the session itself and
   * retries on its own terms, so this plugin no longer races session start-up:
   * it asks, and the service answers when it can.
   *
   * @param record - the request that asked for a note.
   * @param dict - the dictionary of the configured language.
   * @returns true when the reminder exists (placed, or refused for good), false to keep it for later.
   */
  async function placeReminder (record, dict) {
    const d = dict()
    const request = {
      title: d.notifyTitle,
      prompt: format(d.notify, { causes: record.cause ? String(record.cause) : d.noCause }),
      // The service refuses zero: `after_seconds` must be a positive safe
      // integer, and one second is as close to "now" as a reminder gets.
      after_seconds: 1,
    }
    const deadline = Date.now() + NOTIFY_DEADLINE_MS
    let announced = false
    while (Date.now() < deadline) {
      if (!scheduling || typeof scheduling.create !== 'function') {
        if (!announced) {
          announced = true
          log('info', 'schedule service is not up yet; waiting for it before placing the reminder')
        }
        await sleep(NOTIFY_POLL_MS)
        continue
      }
      try {
        await scheduling.create(String(record.sessionId), request)
        log('info', `reminder placed for session ${record.sessionId}`)
        return true
      } catch (error) {
        const message = String(error?.message ?? error)
        if (/subagent/i.test(message)) {
          // A delegated child has no delivery path at all; retrying forever would
          // only hide that fact.
          log('warn', `cannot wake ${record.sessionId}: ${message}`)
          return true
        }
        log('info', `reminder for ${record.sessionId} not placed yet: ${message}`)
        await sleep(NOTIFY_RETRY_MS)
      }
    }
    log('warn', `gave up on the reminder for ${record.sessionId} after ${Math.round(NOTIFY_DEADLINE_MS / 1000)}s`)
    return false
  }

  /** Guards against a second delivery running beside the first (start timer, service arrival). */
  let delivering = false

  /** Read the pending file of a previous life, log its causes and wake the sessions. */
  async function deliverPending () {
    if (delivering) return
    delivering = true
    try {
      await deliverPendingOnce()
    } finally {
      delivering = false
    }
  }

  async function deliverPendingOnce () {
    let state
    try {
      if (!existsSync(pendingFile())) return
      const startedAt = Date.now() - Math.floor(process.uptime() * 1000)
      if (statSync(pendingFile()).mtimeMs > startedAt) {
        // Written after this process started: the previous exit was refused, so
        // the process never restarted and there is nothing to announce.
        log('warn', 'pending.json is newer than this process: the earlier restart never happened, dropping it')
        rmSync(pendingFile(), { force: true })
        return
      }
      state = JSON.parse(readFileSync(pendingFile(), 'utf8'))
    } catch (error) {
      log('warn', `cannot read ${pendingFile()}: ${error?.message ?? error}`)
      return
    }
    const records = Array.isArray(state?.records) ? state.records : []
    const d = dict()
    log('info', `previous run restarted at ${state?.restartedAt ?? 'unknown time'}; causes: ${causesOf(records, d)}`)
    const keep = []
    for (const record of records) {
      if (record?.needNotify !== true || !record?.sessionId) {
        log('info', `notification for request ${record?.id ?? '?'} skipped: ${record?.needNotify === true ? 'no session id' : 'need_notify was off'}`)
        continue
      }
      const ok = await placeReminder(record, dict)
      if (!ok) {
        log('warn', `notification for session ${record.sessionId} stayed pending`)
        keep.push(record)
      }
    }
    try {
      if (keep.length === 0) rmSync(pendingFile(), { force: true })
      else writeFileSync(pendingFile(), `${JSON.stringify({ ...state, records: keep }, null, 2)}\n`)
    } catch (error) {
      log('warn', `cannot rewrite ${pendingFile()}: ${error?.message ?? error}`)
    }
  }

  // A tiny status route for the settings card: the browser cannot read
  // `process.uptime()` itself, and the card shows the uptime of the process the
  // plugin lives in. Registered as its own exact path, so it never touches the
  // app's session routes; it exposes no causes, only counters.
  function mountStatus (server) {
    const route = {
      kind: 'exact',
      path: STATUS_PATH,
      handler: (request, response) => {
        const current = options()
        const pending = queue.pending()
        const busy = ctx.agents.list().filter(agent => agent.status === 'running')
        const body = JSON.stringify(statusSnapshot({
          quietSeconds: current.quietSeconds,
          exitMethod: current.exitMethod,
          pending: pending.length,
          busy: busy.length,
          jobs: runningJobs().length,
          quiet: queue.quietSince === null ? null : Math.round((Date.now() - queue.quietSince) / 1000),
        }))
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(body)
      },
    }
    try {
      const dispose = server.register(route)
      log('info', `status route mounted at ${STATUS_PATH}`)
      return () => { try { dispose?.() } catch {} }
    } catch (error) {
      log('warn', `cannot mount ${STATUS_PATH}: ${error?.message ?? error}`)
      return () => {}
    }
  }

  ctx.inject(['webServer'], child => {
    if (!child.webServer || typeof child.webServer.register !== 'function') return () => {}
    const dispose = child.effect(() => mountStatus(child.webServer), `${name}: status route`)
    return () => { try { dispose?.() } catch {} }
  })

  ctx.inject(['settings'], child => {
    liveSettings = child.settings
    log('info', 'settings service available: the card edits are read live')
    return () => { liveSettings = null }
  })

  ctx.inject(['jobs'], child => {
    jobRegistry = child.jobs
    log('info', 'jobs service available: a running job holds a restart')
    return () => { jobRegistry = null }
  })

  ctx.inject(['schedule'], child => {
    scheduling = child.schedule
    log('info', 'schedule service available: post-restart notes become reminders')
    // A note still waiting for this service gets its second chance here instead
    // of waiting for the next restart.
    if (existsSync(pendingFile())) {
      const retry = setTimeout(() => { void deliverPending() }, 250)
      retry.unref?.()
    }
    return () => { scheduling = null }
  })

  // Tools are registered globally, so every agent — the main session and every
  // subagent — sees them with the same description and the same contract.
  ctx.effect(() => {
    const disposers = createTools({
      dict,
      register: request => {
        const current = options()
        const problem = exitProblem(current)
        if (problem) throw new Error(format(dict().badExit, { method: problem }))
        return queue.request(request)
      },
      cancel: id => queue.cancel(id),
      pending: () => queue.pending().length,
    }).map(tool => ctx.tools.register(tool))
    log('info', 'tools dsh_restart and dsh_restart_cancel registered')
    return () => { for (const dispose of disposers) try { dispose() } catch {} }
  }, `${name}: tools`)

  ctx.effect(() => () => queue.stop(), `${name}: watcher`)

  // The host needs a moment before a session can be resumed; the note is not
  // urgent, and a failed attempt is retried rather than lost. `notifyDelayMs` is
  // a test knob only: the Loader passes nothing but the Config schema fields.
  const notifyDelayMs = Number.isFinite(config?.notifyDelayMs) ? config.notifyDelayMs : 2000
  const startTimer = setTimeout(() => { void deliverPending() }, notifyDelayMs)
  startTimer.unref?.()
  ctx.effect(() => () => clearTimeout(startTimer), `${name}: pending notifications`)

  initial = normalizeConfig({ ...initial, ...(settingsSectionOf(liveSettings) ?? {}) })
  log('info', `ready: exitMethod=${initial.exitMethod} quietSeconds=${initial.quietSeconds} language=${initial.language}`)
}

export default Object.freeze({ name, inject, apply, Config, normalizeConfig, RestartQueue, createTools, exitPlan })
