window.__ModuleLoader__.load({
	id: "@dr-co/dsh-graceful-restart",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var h = React.createElement;

		var NS = "dsh-graceful-restart";
		// The bundle package name keys the config slot on the Plugins page; the
		// settings namespace is the short Loader entry id. Scoping the package
		// splits the two, so both are spelled out.
		var PACKAGE = "@dr-co/dsh-graceful-restart";
		var ENTRY = "dsh-graceful-restart";
		var STATUS_PATH = "/api/graceful-restart/status";

		var DICTIONARIES = {
			en: {
				"title": "Graceful restart",
				"intro": "How dsh_restart ends the host, and how long it waits for silence first. Changes apply to the next request.",
				"exitMethod": "Exit method",
				"exitMethod.hint": "systemctl is the only method that comes back by itself under a systemd user unit. kill and exit end the process without a restart unless a supervisor decides otherwise.",
				"serviceUnit": "Service unit",
				"serviceUnit.hint": "systemd user unit restarted by the systemctl method.",
				"exitCommand": "Exit command",
				"exitCommand.hint": "Shell command for the command method, started detached from the dying process.",
				"quietSeconds": "Quiet window, seconds",
				"quietSeconds.hint": "How long the host must stay idle after the last activity before it restarts, re-checked every second.",
				"reasonFile": "Reason file",
				"reasonFile.hint": "Optional file that receives the causes before the restart, one line.",
				"waitForJobs": "Wait for background jobs",
				"waitForJobs.hint": "Hold the restart while a background job is running. Off by default: a dev server that never ends would postpone the restart forever.",
				"notifyJobOwners": "Notify the job owner about the restart",
				"notifyJobOwners.hint": "After the host is up, the session that started a background job gets one note listing every job of its own that the restart killed. One note per session, however many jobs.",
				"notifyJobOwners.hintOff": "Unavailable while \"Wait for background jobs\" is on: then the restart waits for the jobs instead of killing them.",
				"restartNotice": "Notify about restarts",
				"restartNotice.hint": "One fixed session hears about every restart, whatever it was for: the causes of all dsh_restart calls are collected into one message. This replaces a start-up hook script, and needs no systemd drop-in.",
				"restartNoticeSessionId": "Session ID",
				"restartNoticeSessionId.hint": "Session that receives the notice, e.g. session-03da57ce-… Leave it empty for no notice.",
				"restartNoticeMode": "Notice text",
				"restartNoticeMode.hint": "standard sends the built-in note with every cause. Your own text is sent first, then a blank line, then the causes one per line.",
				"restartNoticeMode.standard": "standard notice",
				"restartNoticeMode.custom": "your own text",
				"restartNoticeText": "Your text",
				"restartNoticeText.hint": "The causes are appended after a blank line, so this text needs no placeholders.",
				"language": "Language",
				"language.hint": "Language of tool descriptions, tool answers and the post-restart note.",
				"readonly": "Configuration is read-only here.",
				"uptime": "Uptime",
				"uptime.hint": "How long the host process has been running, updated every second.",
				"uptimeIdle": "idle for {quiet}s of {need}s",
				"uptimeBusy": "{busy} session(s) working",
				"uptimePending": "restart pending: {pending} request(s)",
				"uptimeNoRestart": "no restart pending",
				"uptimeUnknown": "not available",
			},
			ru: {
				"title": "Аккуратный перезапуск",
				"intro": "Как dsh_restart завершает хост и сколько он ждёт тишины. Изменения действуют со следующей заявки.",
				"exitMethod": "Способ выхода",
				"exitMethod.hint": "systemctl — единственный способ, после которого хост поднимается сам (systemd user unit). kill и exit просто завершают процесс, если только им не управляет супервизор.",
				"serviceUnit": "Юнит сервиса",
				"serviceUnit.hint": "systemd user unit, который перезапускает способ systemctl.",
				"exitCommand": "Команда выхода",
				"exitCommand.hint": "Shell-команда для способа command, запускается отдельно от умирающего процесса.",
				"quietSeconds": "Окно тишины, секунд",
				"quietSeconds.hint": "Сколько хост должен простоять без активности перед перезапуском; проверяется каждую секунду.",
				"reasonFile": "Файл причины",
				"reasonFile.hint": "Необязательный файл, куда перед перезапуском пишутся причины одной строкой.",
				"waitForJobs": "Ждать завершение job",
				"waitForJobs.hint": "Держать перезапуск, пока работает фоновая задача. По умолчанию выключено: вечный процесс вроде dev-сервера иначе отложит перезапуск навсегда.",
				"notifyJobOwners": "Уведомлять запустившего job агента о перезапуске",
				"notifyJobOwners.hint": "После подъёма хоста сессия, запустившая фоновую задачу, получит записку со списком всех своих задач, которые оборвал перезапуск. Одна записка на сессию, сколько бы задач ни было.",
				"notifyJobOwners.hintOff": "Недоступно, пока включено «Ждать завершение job»: тогда перезапуск дожидается задач, а не обрывает их.",
				"restartNotice": "Уведомлять о перезапусках",
				"restartNotice.hint": "Одна заданная сессия узнаёт о каждом перезапуске, зачем бы он ни был: причины всех вызовов dsh_restart собираются в одно сообщение. Замена скрипту на ExecStartPost — drop-in в systemd не нужен.",
				"restartNoticeSessionId": "ID сессии",
				"restartNoticeSessionId.hint": "Сессия, которая получит уведомление, например session-03da57ce-…. Пусто — уведомлений нет.",
				"restartNoticeMode": "Текст уведомления",
				"restartNoticeMode.hint": "Стандартное — встроенная записка со всеми причинами. Своё — сначала твой текст, потом пустая строка и причины по одной в строке.",
				"restartNoticeMode.standard": "стандартное уведомление",
				"restartNoticeMode.custom": "своё уведомление",
				"restartNoticeText": "Свой текст",
				"restartNoticeText.hint": "Причины дописываются после пустой строки, подставлять их в текст не нужно.",
				"language": "Язык",
				"language.hint": "Язык описаний инструментов, ответов инструментов и записки после перезапуска.",
				"readonly": "Настройки доступны только для чтения.",
				"uptime": "Время работы",
				"uptime.hint": "Сколько работает процесс хоста; обновляется каждую секунду.",
				"uptimeIdle": "простой {quiet} с из {need} с",
				"uptimeBusy": "работают сессии: {busy}",
				"uptimePending": "ожидает перезапуска: заявок {pending}",
				"uptimeNoRestart": "перезапуск не запланирован",
				"uptimeUnknown": "недоступно",
			},
			zh: {
				"title": "优雅重启",
				"intro": "dsh_restart 如何结束宿主，以及它先等待多久的静默。改动从下一次请求开始生效。",
				"exitMethod": "退出方式",
				"exitMethod.hint": "systemctl 是唯一会自行恢复的方式（systemd user unit）。kill 与 exit 只结束进程，除非由外部守护进程拉起。",
				"serviceUnit": "服务单元",
				"serviceUnit.hint": "systemctl 方式重启的 systemd user 单元。",
				"exitCommand": "退出命令",
				"exitCommand.hint": "command 方式使用的 shell 命令，独立于即将结束的进程启动。",
				"quietSeconds": "静默窗口（秒）",
				"quietSeconds.hint": "重启前宿主必须保持空闲的时长，每秒复查一次。",
				"reasonFile": "原因文件",
				"reasonFile.hint": "可选：重启前把原因写成一行写入该文件。",
				"waitForJobs": "等待后台任务结束",
				"waitForJobs.hint": "有后台任务运行时暂缓重启。默认关闭：常驻进程（如开发服务器）否则会无限推迟重启。",
				"notifyJobOwners": "重启后通知任务发起者",
				"notifyJobOwners.hint": "宿主恢复后，发起后台任务的会话会收到一条消息，列出被重启中断的全部任务。每个会话只发一条，无论任务多少。",
				"notifyJobOwners.hintOff": "开启「等待后台任务结束」时不可用：此时重启会等任务结束，而不是中断它们。",
				"restartNotice": "重启通知",
				"restartNotice.hint": "指定会话会收到每次重启的通知：所有 dsh_restart 调用的原因合并成一条消息。可替代 ExecStartPost 钩子脚本，无需 systemd drop-in。",
				"restartNoticeSessionId": "会话 ID",
				"restartNoticeSessionId.hint": "接收通知的会话，例如 session-03da57ce-…。留空则不发通知。",
				"restartNoticeMode": "通知文本",
				"restartNoticeMode.hint": "标准：内置消息并列出全部原因。自定义：先发送你的文本，然后空一行，再逐行列出原因。",
				"restartNoticeMode.standard": "标准通知",
				"restartNoticeMode.custom": "自定义文本",
				"restartNoticeText": "你的文本",
				"restartNoticeText.hint": "原因会追加在空行之后，文本中无需占位符。",
				"language": "语言",
				"language.hint": "工具描述、工具回复以及重启后消息的语言。",
				"readonly": "此处配置为只读。",
				"uptime": "运行时间",
				"uptime.hint": "宿主进程已运行的时长，每秒刷新。",
				"uptimeIdle": "已静默 {quiet} 秒（共 {need} 秒）",
				"uptimeBusy": "正在工作的会话：{busy}",
				"uptimePending": "等待重启：{pending} 条请求",
				"uptimeNoRestart": "没有等待中的重启",
				"uptimeUnknown": "不可用",
			},
		};

		function apply(ctx) {
			var t = function(key) { return key; };
			try {
				t = ctx.locale.bind(NS);
			} catch (error) {
				console.warn("[dsh-graceful-restart] locale unavailable: " + (error && error.message));
			}
			try {
				ctx.effect(function() {
					ctx.locale.register(NS, "en", DICTIONARIES.en);
					ctx.locale.register(NS, "ru", DICTIONARIES.ru);
					ctx.locale.register(NS, "zh", DICTIONARIES.zh);
					return function() {};
				}, "dsh-graceful-restart: dictionaries");
			} catch (error) {
				console.warn("[dsh-graceful-restart] dictionaries failed: " + (error && error.message));
			}
			try {
				ctx.effect(function() {
					var disposers = [];
					[["ru", "Русский"], ["zh", "中文"]].forEach(function(pair) {
						try {
							disposers.push(ctx.locale.addLanguage({ id: pair[0], label: pair[1], fallback: "en" }));
						} catch (error) {
							if (!/already/i.test(String((error && error.message) || error))) throw error;
						}
					});
					return function() {
						disposers.forEach(function(dispose) {
							try { if (typeof dispose === "function") dispose(); } catch (e) {}
						});
					};
				}, "dsh-graceful-restart: languages");
			} catch (error) {
				console.warn("[dsh-graceful-restart] languages failed: " + (error && error.message));
			}

			var scope = null;
			try {
				scope = ctx.configForms.get(ENTRY);
			} catch (error) {
				console.warn("[dsh-graceful-restart] config form unavailable: " + (error && error.message));
			}
			if (!scope) return;

			try {
				ctx.slots.inject("plugins.bundle.config", function() {
					return ctx.slots.register({
						name: "plugins.bundle.config",
						key: PACKAGE,
						inject: function() { return { scope: scope }; },
					}, Card);
				});
			} catch (error) {
				console.warn("[dsh-graceful-restart] bundle config slot failed: " + (error && error.message));
			}

			function Card(props) {
				var bound = props.scope || scope;
				var snapshot = React.useSyncExternalStore(
					function(listener) { return bound.subscribe(listener); },
					function() { return bound.getSnapshot(); },
				);
				var value = (snapshot && snapshot.value) || {};
				var writable = snapshot && snapshot.writable === true;
				var rows = FIELDS.filter(function(field) {
					return field.visible ? field.visible(value) : true;
				}).map(function(field) {
					return h(Row, {
						key: field.key,
						field: field,
						value: value[field.key],
						form: value,
						writable: writable,
						scope: bound,
						t: t,
					});
				});
				return h("div", { style: { display: "grid", gap: "4px" } },
					h("div", { style: { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary, inherit)", padding: "2px 0 4px" } }, t("title")),
					h("div", { style: { fontSize: "12px", lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary, rgba(127,127,127,.8))", padding: "0 0 6px" } }, t("intro")),
					h(Uptime, { key: "uptime", t: t }),
					rows,
					writable ? null : h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, rgba(127,127,127,.8))", paddingTop: "4px" } }, t("readonly")),
				);
			}

			// The uptime of the process the plugin lives in: the browser cannot read
			// it, so the host answers on its own small route. The clock ticks locally
			// every second and the route is re-read every five, so the number keeps
			// moving even while a request is in flight or the host is busy.
			function Uptime(props) {
				var t2 = props.t;
				var stored = React.useState(null);
				var data = stored[0];
				var setData = stored[1];
				var ticker = React.useState(0);
				var setTick = ticker[1];
				React.useEffect(function() {
					var alive = true;
					function read() {
						try {
							Promise.resolve(fetch(STATUS_PATH, { cache: "no-store", headers: { accept: "application/json" } }))
								.then(function(response) { return response && response.ok ? response.json() : null; })
								.then(function(payload) { if (alive && payload && payload.ok === true) setData(payload); })
								.catch(function() {});
						} catch (error) {}
					}
					read();
					var poll = setInterval(read, 5000);
					var tick = setInterval(function() { setTick(function(n) { return n + 1; }); }, 1000);
					return function() { alive = false; clearInterval(poll); clearInterval(tick); };
				}, []);
				var value = "—";
				var detail = t2("uptimeUnknown");
				if (data && data.startedAt) {
					value = formatDuration(Date.now() - Date.parse(data.startedAt));
					var parts = [];
					if (data.pending > 0) {
						parts.push(formatText(t2("uptimePending"), { pending: data.pending }));
						if (data.busy > 0) parts.push(formatText(t2("uptimeBusy"), { busy: data.busy }));
						else if (data.quiet != null) parts.push(formatText(t2("uptimeIdle"), { quiet: data.quiet, need: data.quietSeconds }));
					} else {
						parts.push(t2("uptimeNoRestart"));
					}
					detail = parts.join(" · ");
				}
				return h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "8px 0 10px", borderTop: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2))" } },
					h("div", { style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 } },
						h("span", { style: { fontSize: "13px", color: "var(--dsw-alias-label-primary, inherit)" } }, t2("uptime")),
						h("span", { style: { fontSize: "12px", lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary, rgba(127,127,127,.8))" } }, detail),
					),
					h("span", { style: { fontVariantNumeric: "tabular-nums", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "14px", color: "var(--dsw-alias-label-primary, inherit)" } }, value),
				);
			}

			// A pill switch, drawn with the same design tokens the host UI uses for
			// its own toggles: a native checkbox reads as another application.
			function Switch(props) {
				var on = props.checked === true;
				var disabled = props.writable !== true;
				return h("button", {
					type: "button",
					role: "switch",
					"aria-checked": on,
					"aria-label": props.ariaLabel || "",
					disabled: disabled,
					style: {
						flex: "0 0 auto",
						width: "38px",
						height: "22px",
						padding: 0,
						boxSizing: "border-box",
						position: "relative",
						cursor: disabled ? "default" : "pointer",
						borderRadius: "999px",
						border: "1px solid transparent",
						background: on ? "var(--dsw-alias-bg-brand, #3a76f0)" : "var(--dsw-alias-bg-module-platform, rgba(127,127,127,.28))",
						opacity: disabled ? 0.55 : 1,
						transition: "background .16s ease, opacity .16s ease",
					},
					onClick: function() { props.onToggle(!on); },
				}, h("span", {
					style: {
						position: "absolute",
						top: "1px",
						left: "1px",
						width: "18px",
						height: "18px",
						borderRadius: "999px",
						boxSizing: "border-box",
						background: "var(--dsw-alias-label-inverse, #fff)",
						boxShadow: "0 1px 2px rgba(0,0,0,.35)",
						transform: on ? "translateX(16px)" : "translateX(0)",
						transition: "transform .16s ease",
					},
				}));
			}

			function formatDuration(ms) {
				var total = Math.max(0, Math.floor(ms / 1000));
				var days = Math.floor(total / 86400);
				var hours = Math.floor((total % 86400) / 3600);
				var minutes = Math.floor((total % 3600) / 60);
				var seconds = total % 60;
				var pad = function(n) { return (n < 10 ? "0" : "") + n; };
				var clock = pad(hours) + ":" + pad(minutes) + ":" + pad(seconds);
				return days > 0 ? days + "d " + clock : clock;
			}

			function formatText(template, vars) {
				return String(template).replace(/\{(\w+)\}/g, function(whole, key) {
					return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole;
				});
			}

			function Row(props) {
				var field = props.field;
				var t2 = props.t;
				var form = props.form || {};
				// A field can be pointless in some configurations — notifying the owner
				// of a job makes no sense while the restart waits for jobs instead of
				// killing them. Such a field stays visible but cannot be switched.
				var locked = field.disabled ? field.disabled(form) === true : false;
				var disabled = props.writable !== true || locked;
				var hint = field.hintKey ? field.hintKey(form) : field.key + ".hint";
				var label = h("div", { style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 } },
					h("span", { style: { fontSize: "13px", color: "var(--dsw-alias-label-primary, inherit)" } }, t2(field.key)),
					h("span", { style: { fontSize: "12px", lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary, rgba(127,127,127,.8))" } }, t2(hint)),
				);
				var input;
				if (field.kind === "select") {
					var choices = field.options.map(function(option) {
						if (typeof option === "string") return { value: option, label: option };
						// A label can be translated: the mode select says "standard" or
						// "your own text", and neither word survives a literal.
						return { value: option.value, label: option.labelKey ? t2(option.labelKey) : (option.label || option.value) };
					});
					input = h("select", {
						value: String(props.value == null ? choices[0].value : props.value),
						disabled: disabled,
						style: INPUT_STYLE,
						onChange: function(event) { commit(props.scope, field.key, event.target.value); },
					}, choices.map(function(option) {
						return h("option", { key: option.value, value: option.value }, option.label);
					}));
				} else if (field.kind === "bool") {
					input = h(Switch, {
						checked: props.value === true,
						writable: props.writable === true && !locked,
						ariaLabel: t2(field.key),
						onToggle: function(next) { commit(props.scope, field.key, next); },
					});
				} else if (field.kind === "number") {
					input = h("input", {
						type: "number",
						min: 0,
						max: 600,
						step: 1,
						value: props.value == null ? "" : String(props.value),
						disabled: disabled,
						style: INPUT_STYLE,
						onChange: function(event) { commit(props.scope, field.key, Number(event.target.value)); },
					});
				} else if (field.kind === "textarea") {
					// The custom notice is prose, not a value: one line would hide it.
					input = h("textarea", {
						value: props.value == null ? "" : String(props.value),
						disabled: disabled,
						placeholder: field.placeholder || "",
						rows: field.rows || 4,
						style: Object.assign({}, INPUT_STYLE, {
							resize: "vertical",
							minHeight: "76px",
							lineHeight: 1.5,
						}),
						onChange: function(event) { commit(props.scope, field.key, event.target.value); },
					});
				} else {
					input = h("input", {
						type: "text",
						value: props.value == null ? "" : String(props.value),
						disabled: disabled,
						placeholder: field.placeholder || "",
						style: INPUT_STYLE,
						onChange: function(event) { commit(props.scope, field.key, event.target.value); },
					});
				}
				return h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "6px 0", borderTop: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2))", opacity: locked ? 0.6 : 1 } },
					label,
					h("div", { style: { flex: "0 0 auto", minWidth: "180px" } }, input),
				);
			}

			function commit(bound, field, value) {
				try {
					var pending = bound.set(field, value);
					if (pending && typeof pending.catch === "function") {
						pending.catch(function(error) {
							console.warn("[dsh-graceful-restart] write failed: " + (error && error.message));
						});
					}
				} catch (error) {
					console.warn("[dsh-graceful-restart] write failed: " + (error && error.message));
				}
			}
		}

		var INPUT_STYLE = {
			font: "inherit",
			color: "inherit",
			width: "100%",
			boxSizing: "border-box",
			background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,.08))",
			border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
			borderRadius: "8px",
			padding: "4px 8px",
		};

		// The two dependent fields follow the exit method: a unit only means
		// something to systemctl, a command only to command. Both are still
		// stored, so switching back and forth keeps what was typed.
		var FIELDS = [
			// Labels spell out what actually runs; the stored value stays short.
			{ key: "exitMethod", kind: "select", options: [
				{ value: "systemctl", label: "systemctl --user restart" },
				{ value: "command", label: "command" },
				{ value: "kill", label: "kill" },
				{ value: "exit", label: "exit" },
			] },
			{ key: "serviceUnit", kind: "text", placeholder: "dsh-server", visible: function(value) { return (value.exitMethod || "systemctl") === "systemctl"; } },
			{ key: "exitCommand", kind: "text", placeholder: "systemctl --user restart dsh-server", visible: function(value) { return value.exitMethod === "command"; } },
			{ key: "quietSeconds", kind: "number" },
			{ key: "waitForJobs", kind: "bool" },
			// Meaningless next to a restart that waits for the jobs: greyed out, not hidden,
			// so the option is discoverable before the other one is switched off.
			{ key: "notifyJobOwners", kind: "bool",
				disabled: function(value) { return value.waitForJobs === true; },
				hintKey: function(value) { return value.waitForJobs === true ? "notifyJobOwners.hintOff" : "notifyJobOwners.hint"; } },
			// The restart notice: one fixed session hears about every restart, with
			// the causes the dsh_restart calls carried. It replaces an
			// `ExecStartPost=` hook that had to guess the cause from the journal.
			{ key: "restartNotice", kind: "bool" },
			{ key: "restartNoticeSessionId", kind: "text", placeholder: "session-…",
				visible: function(value) { return value.restartNotice === true; } },
			{ key: "restartNoticeMode", kind: "select", options: [
				{ value: "standard", labelKey: "restartNoticeMode.standard" },
				{ value: "custom", labelKey: "restartNoticeMode.custom" },
			], visible: function(value) { return value.restartNotice === true && String(value.restartNoticeSessionId || "").trim() !== ""; } },
			{ key: "restartNoticeText", kind: "textarea", rows: 5,
				visible: function(value) { return value.restartNotice === true && value.restartNoticeMode === "custom"; } },
			{ key: "reasonFile", kind: "text", placeholder: "/home/user/.cache/dsh-restart-reason.txt" },
			{ key: "language", kind: "select", options: ["en", "ru", "zh"] },
		];

		exports.apply = apply;
		exports.inject = ["slots", "locale", "configForms"];
		exports.name = NS;
		return module.exports;
	}
});
