# dsh-graceful-restart

Restart the DSH host **from inside a session** without cutting the answer.

`systemctl --user restart dsh-server` from a tool call kills the process that is
still writing your reply: the user gets nothing, and the session looks crashed.
This plugin turns the restart into a recorded request that happens when nothing
is running.

## What it does

1. `dsh_restart` registers a request with its own id and returns at once. The
   agent is told, in plain words, not to wait for it.
2. A watcher polls every live agent (subagents included) once a second. While
   anything is `running`, nothing happens.
3. When nothing is running it opens a **quiet window** (`quietSeconds`, default
   10) and keeps re-checking every second that no new session appeared. A new
   session — or work that starts again — restarts the window.
4. When the window has passed, every cause an agent supplied is written to the
   event log and to the state file, and the host ends itself the configured way.
5. On the next start the plugin reads that state file, logs the causes again and
   wakes the sessions that passed `need_notify: true` with a short note naming
   the causes, so the interrupted work can continue.

## Tools

Both tools are registered globally: the main session and every subagent see the
same description and the same contract.

### `dsh_restart`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `cause` | string, required | One short line: what exactly changed. Logged, quoted in the notification and in the start-up report. |
| `need_notify` | boolean | Wake this session after the restart with a note naming the cause. |

Answer:

```json
{
  "status": "ok",
  "message": "The restart is scheduled and will run as soon as the host is idle. Do not wait for it: waiting only lengthens the delay and cannot change the result. Cancel it with dsh_restart_cancel(id) if it is no longer needed.",
  "id": "1765432100123",
  "pending": 1
}
```

Repeated calls register separate requests: the host restarts at most once, but
every request carries its own id and has to be cancelled on its own.

### `dsh_restart_cancel`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `id` | string, required | Exact id returned by `dsh_restart`. |

The restart is cancelled only when **every** registered request has been
cancelled — while one request is still pending, the host restarts even if you
cancelled another.

```json
{ "status": "ok", "message": "Request 1765432100123 is cancelled. No requests are left, so the restart is cancelled too.", "cancelled": true, "pending": 0 }
```

An unknown id is an error, never a silent success:

```json
{ "status": "error", "message": "No pending restart request has id nope. Nothing was cancelled.", "cancelled": false, "pending": 0 }
```

## Configuration

Everything is edited on the plugin's own page: **Plugins → dsh-graceful-restart**.
The card is rendered by `client.js` against the plugin's `Config` schema, so the
fields are the same ones the config file holds (`volatile()` fields are the ones
the settings service persists). Language: English, Russian, Chinese.

| Field | Default | Meaning |
| --- | --- | --- |
| `exitMethod` | `systemctl` | `systemctl` — `systemctl --user restart <serviceUnit>`, the only method that comes back by itself under a systemd user unit. `command` — run `exitCommand`. `kill` — SIGTERM to itself. `exit` — `process.exit(0)`. |
| `serviceUnit` | `dsh-server` | Unit restarted by `systemctl`. |
| `exitCommand` | — | Shell command for `command`, started detached from the dying process. |
| `quietSeconds` | `10` | How long the host must stay idle after the last activity, re-checked every second. |
| `waitForJobs` | `false` | Hold the restart while a background job (`run_in_background`, `job_*`) is running or stopping. Off by default on purpose: a dev server that never ends would postpone the restart forever. When it is on, the job id and label are logged once, and they are counted in the card's status line. |
| `reasonFile` | — | Optional file that receives the causes before the restart, one line. On a host where the unit's `ExecStartPost` prints a start-up report, point this at the file that report reads (for example `/home/dsh/.cache/dsh-restart-reason.txt`). |
| `language` | `en` | Language of tool descriptions, tool answers and the post-restart note: `en`, `ru`, `zh`. |
| `stateDir` | `$DSH_HOME/graceful-restart` | Requests, event log and pending notifications. |

## Uptime on the settings card

The card shows the uptime of the host process, ticking every second, next to a
one-line state: either "restart pending: N request(s)" with the quiet window
(`idle for 7s of 10s`) or the number of working sessions, or "no restart
pending". The host answers `GET /api/graceful-restart/status` with the counters
the browser cannot read itself (`process.uptime()`, pid, pending requests, busy
agents). The route exposes no causes and no session ids; it is mounted only when
the host has a `webServer` service.

## Files it leaves behind

| File | Contents |
| --- | --- |
| `<stateDir>/events.log` | Every request, cancel, window event, cause and exit decision, one line each. Survives journald rotation. |
| `<stateDir>/pending.json` | Requests of the restart that just happened, kept until the sessions are woken. |

## Install

```bash
dsh plugin add @dr-co/dsh-graceful-restart
```

Or pin the bundle in the profile (`~/.dsh/profiles/web/package.json`):

```json
{
  "dependencies": { "@dr-co/dsh-graceful-restart": "^1.0.0" },
  "dsh": { "profile": { "bundles": ["@dr-co/dsh-graceful-restart"] } }
}
```

Two identities in `cordis.patch.yml`, and both are load-bearing:

- `name` is the module specifier and must equal `package.json` `name`, because the
  client-modules scan matches the nearest manifest name against it — that is how
  the browser card gets loaded at all;
- `id` is the Loader entry, and the settings namespace *is* the entry id (the
  settings service answers `Plugin entry <id> has no volatile fields`, and the
  Plugins page writes a bundle's values into `cordis.patch.yml` under this id).
  It stays short: `dsh-graceful-restart`.

## Notes

- Optional host services (`webServer`, `settings`, `sessionController`, `sessions`)
  are taken through `ctx.inject`, never `ctx.get`: cordis grants a plugin only the
  services it declared, and questioning a service it was not granted answers
  `undefined`. That is what kept the status route unmounted and the post-restart
  note undelivered in 0.1.3.

- `kill` and `exit` end the process; under `Restart=on-failure` a clean exit or
  SIGTERM is not a failure, so the host stays down unless something else starts
  it. Use `systemctl` unless you know your supervisor restarts on clean exits.
- An unusable exit method is caught at request time: `command` with an empty
  command refuses the request with `status: "error"` and names the field to fix,
  instead of scheduling a restart that would only die in the log. If the settings
  become unusable between the request and the quiet window, the restart is
  refused at that last step, the requests stay pending and the watcher pauses.
- A `pending.json` newer than the running process is dropped at start: it can
  only come from an exit that never happened, and announcing that restart would
  be a lie.
- Background jobs are opt-in: with `waitForJobs` off a restart kills them silently. `ctx.jobs.list()` without a caller returns only *unowned* jobs (the registry filters by `job.owner === caller`), so the plugin collects session-owned ones per live agent.
- The plugin does not watch HTTP requests, only agents. A user typing a follow-up
  after the quiet window opened does not cancel the restart; the next request
  from an agent does.
- The post-restart note is a durable one-shot **schedule task**, the same
  mechanism cron uses for its reminders: `ctx.schedule.create(sessionId, {title,
  prompt, after_seconds: 0})`. The schedule service owns the timer, resumes the
  session itself and retries on its own terms, so this plugin never races host
  start-up. It is an ordinary turn, so it costs one model call — the price of a
  notification the session can act on. Subagent sessions are refused by the
  service and skipped with a warning: nothing can wake them.
- No IM plugin is involved: dsh-im has no part in the note. Whether the answer
  ever reaches a chat is the IM plugin's own delivery setting.
- A note that could not be placed yet is carried over to the next restart
  instead of being erased by it.

## Кратко по-русски

`dsh_restart` не перезапускает хост сразу: заявка ждёт, пока не останется ни
одного работающего агента (включая субагентов), потом выдерживает окно тишины
(`quietSeconds`, по умолчанию 10), каждую секунду проверяя, что новых сессий не
появилось, пишет причины в журнал и завершает процесс выбранным способом
(`systemctl` по умолчанию). После старта сессии, попросившие `need_notify`,
получают записку с причиной. Снять заявку — `dsh_restart_cancel(id)`; перезапуск
отменяется, когда сняты все заявки.

## 中文简述

`dsh_restart` 不会立刻重启：请求会等到没有任何代理（含子代理）在运行，然后保持
静默窗口（`quietSeconds`，默认 10 秒），每秒复查没有新会话出现，记录原因并按
配置的方式结束进程（默认 `systemctl`）。宿主恢复后，请求了 `need_notify` 的会话
会收到写明原因的消息。用 `dsh_restart_cancel(id)` 撤销请求；只有当所有请求都被
撤销时，重启才会取消。

## License

MIT
