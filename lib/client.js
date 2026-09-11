/* dsh-pdf2zh — browser half (built from src/client by tsdown.client.config.mjs) */
window.__ModuleLoader__.load({
	id: "dsh-pdf2zh",
	factory: function(require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		let react_dom_client = require("react-dom/client");
		//#region src/client/index.ts
		/**
		* Client entry for dsh-pdf2zh.
		*
		* Sidebar entry (plain DOM row, placed below the skill-explorer entry like
		* dsh-cron-explorer) + center-column panel taking over the conversation
		* column with the single-occupant protocol (task-board / cron-explorer /
		* ssh / token-usage-board eviction).
		*
		* Panel: translation board (running / done / failed counts with per-file
		* progress bars, auto-refreshed), PDF path input (+ recent paths from
		* localStorage, drag-drop upload), options (pages / 中英对照 / 含附录),
		* extract preview with stat chips, one-click session translation, glossary
		* preview/editor, and a status strip with green/red health dots.
		*
		* A header gear button opens a settings modal: translation model API picked
		* from the dsh LLM registry (all configured providers/models are listed, the
		* default resolves automatically and prefers the locally deployed one), the
		* output save directory, and the per-job timeout.
		*
		* Failure policy mirrors the reference plugins: DOM mounting problems are
		* logged, never thrown — a throwing client apply fails the whole web boot.
		*/
		const e = react.default.createElement;
		const API_PREFIX = "/api/pdf2zh";
		async function call(path, method, body) {
			const init = { method };
			if (body !== void 0) {
				init.headers = { "content-type": "application/json" };
				init.body = JSON.stringify(body);
			}
			const resp = await fetch(path, init);
			let data = null;
			try {
				data = await resp.json();
			} catch {}
			if (!resp.ok) throw new Error(data && data.error || `HTTP ${resp.status}`);
			return data;
		}
		const api = {
			health: () => call(`${API_PREFIX}/health`, "GET"),
			extract: (path, pages) => call(`${API_PREFIX}/extract`, "POST", {
				path,
				...pages ? { pages } : {}
			}),
			translate: (body) => call(`${API_PREFIX}/translate`, "POST", body),
			glossary: () => call(`${API_PREFIX}/glossary`, "GET"),
			glossarySave: (text) => call(`${API_PREFIX}/glossary`, "POST", { text }),
			settings: () => call(`${API_PREFIX}/settings`, "GET"),
			settingsSave: (body) => call(`${API_PREFIX}/settings`, "POST", body),
			models: () => call(`${API_PREFIX}/models`, "GET"),
			jobs: () => call(`${API_PREFIX}/jobs`, "GET"),
			jobDelete: (id) => call(`${API_PREFIX}/jobs/delete`, "POST", { id }),
			jobsClear: () => call(`${API_PREFIX}/jobs/clear`, "POST", {})
		};
		var PanelController = class {
			open = false;
			listeners = /* @__PURE__ */ new Set();
			getSnapshot = () => this.open;
			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			};
			setOpen = (value) => {
				if (value === this.open) return;
				this.open = value;
				for (const listener of this.listeners) listener();
			};
			show = () => {
				this.setOpen(true);
			};
			hide = () => {
				this.setOpen(false);
			};
			toggle = () => {
				this.setOpen(!this.open);
			};
		};
		const RECENT_KEY = "dsh-pdf2zh.recentPaths";
		const RECENT_MAX = 4;
		function readRecent() {
			try {
				const raw = localStorage.getItem(RECENT_KEY);
				if (!raw) return [];
				const arr = JSON.parse(raw);
				return Array.isArray(arr) ? arr.filter((x) => typeof x === "string").slice(0, RECENT_MAX) : [];
			} catch {
				return [];
			}
		}
		function pushRecent(path) {
			const next = [path, ...readRecent().filter((p) => p !== path)].slice(0, RECENT_MAX);
			try {
				localStorage.setItem(RECENT_KEY, JSON.stringify(next));
			} catch {}
			return next;
		}
		function fmtBeijing(ts) {
			try {
				return new Date(ts).toLocaleString("zh-CN", {
					timeZone: "Asia/Shanghai",
					month: "2-digit",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit"
				});
			} catch {
				return new Date(ts).toLocaleString();
			}
		}
		function fmtElapsed(ms) {
			const s = Math.max(0, Math.round(ms / 1e3));
			if (s < 60) return `${s} 秒`;
			const m = Math.floor(s / 60);
			if (m < 60) return `${m} 分 ${s % 60} 秒`;
			return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
		}
		const STATUS_LABEL = {
			running: "进行中",
			done: "已完成",
			failed: "已失败"
		};
		const INPUT_STYLE = {
			boxSizing: "border-box",
			width: "100%",
			padding: "9px 12px",
			fontSize: 14,
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-base)",
			color: "var(--dsw-alias-label-primary)",
			outline: "none"
		};
		/** Section card: title + optional note + body. `children` may be an array. */
		function Section(props) {
			const { title, note, accent, children } = props;
			return e("div", { className: `pdf2zh-section${accent ? ` pdf2zh-section-${accent}` : ""}` }, e("div", { className: "pdf2zh-section-head" }, e("span", { className: "pdf2zh-section-title" }, title), note ? e("span", { className: "pdf2zh-section-note" }, note) : null), e("div", { className: "pdf2zh-section-body" }, children));
		}
		/** A glossary term line: ASCII ':' with a CJK-free key side. */
		function isGlossaryTerm(line) {
			const i = line.indexOf(":");
			if (i <= 0) return false;
			return !/[\u4e00-\u9fff`]/.test(line.slice(0, i));
		}
		function StatChip({ label, value }) {
			return e("span", { className: "pdf2zh-chip" }, e("span", { className: "pdf2zh-chip-value" }, String(value)), e("span", { className: "pdf2zh-chip-label" }, label));
		}
		function HealthDot({ ok, label }) {
			return e("span", { className: "pdf2zh-status" }, e("span", { className: `pdf2zh-dot${ok ? " pdf2zh-dot-ok" : " pdf2zh-dot-bad"}` }), label);
		}
		function ProgressBar({ value, status }) {
			const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
			return e("div", { className: "pdf2zh-bar" }, e("div", {
				className: `pdf2zh-bar-fill pdf2zh-bar-${status}`,
				style: { width: `${pct}%` }
			}));
		}
		function GearIcon() {
			return e("svg", {
				viewBox: "0 0 24 24",
				fill: "currentColor",
				"aria-hidden": "true"
			}, e("path", { d: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" }));
		}
		function SettingsModal({ settings, onClose, onSaved }) {
			const [models, setModels] = (0, react.useState)(null);
			const [modelsError, setModelsError] = (0, react.useState)("");
			const [savingModel, setSavingModel] = (0, react.useState)("");
			const [outputDir, setOutputDir] = (0, react.useState)(settings?.outputDir ?? "");
			const [timeoutMinutes, setTimeoutMinutes] = (0, react.useState)(String(settings?.timeoutMinutes ?? 240));
			const [savingForm, setSavingForm] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)("");
			const [notice, setNotice] = (0, react.useState)("");
			(0, react.useEffect)(() => {
				if (settings !== null) {
					setOutputDir(settings.outputDir);
					setTimeoutMinutes(String(settings.timeoutMinutes));
				}
			}, [settings]);
			(0, react.useEffect)(() => {
				api.models().then(setModels).catch((err) => setModelsError(err?.message ?? String(err)));
			}, []);
			const saved = settings?.model ?? {
				provider: "",
				model: ""
			};
			const saveModel = (0, react.useCallback)(async (sel) => {
				setError("");
				setNotice("");
				setSavingModel(`${sel.provider}/${sel.model}`);
				try {
					onSaved(await api.settingsSave({ model: sel }));
					setNotice(sel.provider === "" ? "已切回自动选择（优先本地部署 API）" : `默认 API 已保存：${sel.provider} / ${sel.model}`);
				} catch (err) {
					setError(err?.message ?? String(err));
				} finally {
					setSavingModel("");
				}
			}, [onSaved]);
			const saveForm = (0, react.useCallback)(async () => {
				setError("");
				setNotice("");
				setSavingForm(true);
				try {
					const next = await api.settingsSave({
						outputDir: outputDir.trim(),
						timeoutMinutes: Number(timeoutMinutes) || void 0
					});
					onSaved(next);
					setNotice(next.outputDir ? `已保存：译文将保存到 ${next.outputDir}（超时 ${next.timeoutMinutes} 分钟）` : `已保存：译文保存在源 PDF 同目录（超时 ${next.timeoutMinutes} 分钟）`);
				} catch (err) {
					setError(err?.message ?? String(err));
				} finally {
					setSavingForm(false);
				}
			}, [
				outputDir,
				timeoutMinutes,
				onSaved
			]);
			const modelRow = (providerId, providerName, m, isAutoLocal) => {
				const active = saved.provider === providerId && saved.model === m.id;
				const key = `${providerId}/${m.id}`;
				return e("button", {
					key,
					type: "button",
					className: `pdf2zh-api-row${active ? " pdf2zh-api-row-active" : ""}`,
					disabled: savingModel !== "",
					title: m.description || m.id,
					onClick: () => {
						saveModel({
							provider: providerId,
							model: m.id
						});
					}
				}, e("span", { className: "pdf2zh-api-radio" }), e("span", { className: "pdf2zh-api-text" }, e("span", { className: "pdf2zh-api-name" }, m.name !== m.id ? `${m.name} · ${m.id}` : m.id), e("span", { className: "pdf2zh-api-provider" }, providerName !== providerId ? `${providerName} (${providerId})` : providerId)), isAutoLocal ? e("span", { className: "pdf2zh-api-tag" }, "本地") : null, active ? e("span", { className: "pdf2zh-api-tag pdf2zh-api-tag-active" }, "默认") : null, savingModel === key ? e("span", { className: "pdf2zh-api-tag" }, "保存中…") : null);
			};
			return e("div", {
				className: "pdf2zh-modal-mask",
				onClick: (ev) => {
					if (ev.target === ev.currentTarget) onClose();
				}
			}, e("div", {
				className: "pdf2zh-modal",
				role: "dialog",
				"aria-label": "pdf2zh 设置"
			}, e("div", { className: "pdf2zh-modal-head" }, e("span", { className: "pdf2zh-modal-title" }, "设置"), e("button", {
				type: "button",
				className: "pdf2zh-job-del",
				onClick: onClose,
				title: "关闭（Esc）"
			}, "×")), e("div", { className: "pdf2zh-modal-body" }, e("div", { className: "pdf2zh-modal-section-title" }, "翻译模型 API"), e("div", { className: "pdf2zh-mut" }, "与 dsh 本体共用同一份 API 注册表（在 dsh「设置 → 模型」里添加/配置 DeepSeek、Qwen 或本地部署的 API 后，此处自动同步可选）。开始翻译时会自动为新建会话选定该 API。"), e("button", {
				type: "button",
				className: `pdf2zh-api-row${saved.provider === "" ? " pdf2zh-api-row-active" : ""}`,
				disabled: savingModel !== "",
				onClick: () => {
					saveModel({
						provider: "",
						model: ""
					});
				}
			}, e("span", { className: "pdf2zh-api-radio" }), e("span", { className: "pdf2zh-api-text" }, e("span", { className: "pdf2zh-api-name" }, "自动（优先本地部署 API）"), e("span", { className: "pdf2zh-api-provider" }, models?.auto ? `当前解析为：${models.auto.provider}/${models.auto.model}` : "每次翻译时按模型目录实时解析")), saved.provider === "" ? e("span", { className: "pdf2zh-api-tag pdf2zh-api-tag-active" }, "默认") : null), models === null && modelsError === "" ? e("div", { className: "pdf2zh-mut" }, "正在读取模型目录…") : null, modelsError !== "" ? e("div", { className: "pdf2zh-error" }, modelsError) : null, models !== null ? e("div", { className: "pdf2zh-api-groups" }, models.providers.map((g) => e("div", {
				key: g.id,
				className: `pdf2zh-api-group${g.routable ? "" : " pdf2zh-api-group-off"}`
			}, e("div", { className: "pdf2zh-api-group-head" }, e("span", null, g.name !== g.id ? `${g.name}（${g.id}）` : g.id), g.routable ? null : e("span", { className: "pdf2zh-api-tag" }, "当前不可路由")), g.models.map((m) => modelRow(g.id, g.name, m, models.auto?.provider === g.id && models.auto?.model === m.id)))), (models.failures ?? []).length > 0 ? e("div", { className: "pdf2zh-mut" }, `部分 provider 读取失败：${models.failures.map((f) => f.id).join("、")}`) : null) : null, e("div", { className: "pdf2zh-modal-section-title" }, "翻译输出"), e("div", { className: "pdf2zh-field-row" }, e("span", { className: "pdf2zh-field-label" }, "保存路径"), e("input", {
				className: "pdf2zh-input",
				style: INPUT_STYLE,
				value: outputDir,
				placeholder: "留空 = 保存在源 PDF 同目录；例如 /data02/zhangqinhan/papers/translated",
				onChange: (ev) => setOutputDir(ev.target.value),
				spellCheck: false
			})), e("div", { className: "pdf2zh-field-row" }, e("span", { className: "pdf2zh-field-label" }, "任务超时（分钟，10–1440）"), e("input", {
				className: "pdf2zh-input",
				style: {
					...INPUT_STYLE,
					width: 130
				},
				value: timeoutMinutes,
				type: "number",
				min: 10,
				max: 1440,
				onChange: (ev) => setTimeoutMinutes(ev.target.value)
			})), e("div", { className: "pdf2zh-mut" }, "保存路径需为服务器上的绝对路径（自动创建）。若模型把译文写到了源 PDF 旁，任务完成时插件会兜底复制到这里。"), error !== "" ? e("div", { className: "pdf2zh-error" }, error) : null, notice !== "" ? e("div", { className: "pdf2zh-notice" }, notice) : null), e("div", { className: "pdf2zh-modal-foot" }, e("button", {
				type: "button",
				className: "pdf2zh-btn pdf2zh-btn-primary",
				disabled: savingForm,
				onClick: saveForm
			}, savingForm ? "保存中…" : "保存路径与超时"), e("button", {
				type: "button",
				className: "pdf2zh-btn",
				onClick: onClose
			}, "关闭"))));
		}
		function JobRow({ job, onDelete }) {
			const pct = Math.round(job.progress * 100);
			return e("div", {
				className: `pdf2zh-job pdf2zh-job-${job.status}`,
				key: job.id
			}, e("div", { className: "pdf2zh-job-head" }, e("span", {
				className: "pdf2zh-job-name",
				title: job.pdfPath
			}, job.pdfName), e("span", { className: `pdf2zh-badge pdf2zh-badge-${job.status}` }, STATUS_LABEL[job.status]), e("span", {
				className: "pdf2zh-job-time",
				title: `创建：${fmtBeijing(job.createdAt)}`
			}, job.status === "running" ? `已用时 ${fmtElapsed(job.elapsedMs)}` : fmtBeijing(job.endedAt ?? job.createdAt)), e("button", {
				type: "button",
				className: "pdf2zh-job-del",
				title: job.status === "running" ? "从看板移除（不会终止翻译会话）" : "从看板移除",
				onClick: () => {
					onDelete(job.id);
				}
			}, "×")), e("div", { className: "pdf2zh-job-bar" }, e(ProgressBar, {
				value: job.progress,
				status: job.status
			}), e("span", { className: `pdf2zh-job-pct pdf2zh-job-pct-${job.status}` }, `${pct}%`)), job.provider !== "" || job.modelNote !== void 0 ? e("div", { className: "pdf2zh-job-meta" }, job.provider !== "" ? e("span", null, `API ${job.provider}/${job.model}`) : null, job.modelNote ? e("span", { className: "pdf2zh-job-warn" }, job.modelNote) : null) : null, job.status === "done" && (job.outputPaths?.length ?? 0) > 0 ? e("div", { className: "pdf2zh-job-meta" }, job.outputPaths.map((p) => e("span", {
				key: p,
				className: "pdf2zh-job-out"
			}, `→ ${p}`))) : null, job.status === "done" && (job.outputPaths?.length ?? 0) === 0 ? e("div", { className: "pdf2zh-job-meta" }, job.note ?? "翻译已完成，输出文件见会话汇报。") : null, job.note && job.status !== "done" ? e("div", { className: "pdf2zh-job-meta" }, e("span", { className: "pdf2zh-job-warn" }, job.note)) : null, job.status === "failed" && job.error ? e("div", { className: "pdf2zh-job-meta" }, e("span", { className: "pdf2zh-job-error" }, job.error)) : null);
		}
		function Board({ jobs, summary, onDelete, onClear }) {
			const total = jobs.length;
			const overall = total > 0 ? jobs.reduce((acc, j) => acc + j.progress, 0) / total : 0;
			const overallStatus = summary.failed > 0 && summary.running === 0 && summary.done === 0 ? "failed" : summary.running === 0 && summary.done > 0 && summary.failed === 0 ? "done" : "overall";
			return Section({
				title: "翻译看板",
				note: "每 5 秒自动刷新",
				children: [
					e("div", { className: "pdf2zh-board-stats" }, e("span", { className: "pdf2zh-stat pdf2zh-stat-running" }, e("b", null, summary.running), "进行中"), e("span", { className: "pdf2zh-stat pdf2zh-stat-done" }, e("b", null, summary.done), "已完成"), e("span", { className: "pdf2zh-stat pdf2zh-stat-failed" }, e("b", null, summary.failed), "已失败"), total > 0 ? e("span", { style: { flex: 1 } }) : null, summary.done + summary.failed > 0 ? e("button", {
						type: "button",
						className: "pdf2zh-btn pdf2zh-btn-mini",
						onClick: onClear
					}, "清空已完成") : null),
					total > 0 ? e("div", { className: "pdf2zh-overall" }, e("span", { className: "pdf2zh-overall-label" }, `总体 ${Math.round(overall * 100)}%`), e(ProgressBar, {
						value: overall,
						status: overallStatus
					})) : null,
					total === 0 ? e("div", { className: "pdf2zh-mut" }, "暂无翻译任务：填好路径点「开始翻译」后，进度会在这里实时更新。") : e("div", { className: "pdf2zh-jobs" }, jobs.map((job) => e(JobRow, {
						key: job.id,
						job,
						onDelete
					})))
				]
			});
		}
		const GUIDE_STEPS = [
			"填 PDF 路径",
			"提取预览",
			"开始翻译",
			"看板看进度"
		];
		function Panel({ hide }) {
			const [health, setHealth] = (0, react.useState)(null);
			const [healthError, setHealthError] = (0, react.useState)("");
			const [path, setPath] = (0, react.useState)("");
			const [pages, setPages] = (0, react.useState)("");
			const [bilingual, setBilingual] = (0, react.useState)(false);
			const [appendix, setAppendix] = (0, react.useState)(false);
			const [recent, setRecent] = (0, react.useState)(() => readRecent());
			const [extracting, setExtracting] = (0, react.useState)(false);
			const [translating, setTranslating] = (0, react.useState)(false);
			const [extract, setExtract] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)("");
			const [notice, setNotice] = (0, react.useState)("");
			const [glossary, setGlossary] = (0, react.useState)(null);
			const [dragOver, setDragOver] = (0, react.useState)(false);
			const [uploading, setUploading] = (0, react.useState)(false);
			const [uploadName, setUploadName] = (0, react.useState)("");
			const [editingGlossary, setEditingGlossary] = (0, react.useState)(false);
			const [glossaryDraft, setGlossaryDraft] = (0, react.useState)("");
			const [savingGlossary, setSavingGlossary] = (0, react.useState)(false);
			const [jobs, setJobs] = (0, react.useState)([]);
			const [summary, setSummary] = (0, react.useState)({
				running: 0,
				done: 0,
				failed: 0
			});
			const [settings, setSettings] = (0, react.useState)(null);
			const [modalOpen, setModalOpen] = (0, react.useState)(false);
			const modalRef = (0, react.useRef)(false);
			modalRef.current = modalOpen;
			const fileRef = (0, react.useRef)(null);
			const healthTimer = (0, react.useRef)(null);
			const jobsTimer = (0, react.useRef)(null);
			const refreshHealth = (0, react.useCallback)(() => {
				api.health().then(setHealth).catch((err) => setHealthError(err?.message ?? String(err)));
			}, []);
			const refreshGlossary = (0, react.useCallback)(() => {
				api.glossary().then(setGlossary).catch(() => setGlossary(null));
			}, []);
			const refreshJobs = (0, react.useCallback)(() => {
				api.jobs().then((r) => {
					setJobs(r.jobs);
					setSummary(r.summary);
				}).catch(() => {});
			}, []);
			const refreshSettings = (0, react.useCallback)(() => {
				api.settings().then(setSettings).catch(() => {});
			}, []);
			(0, react.useEffect)(() => {
				refreshHealth();
				refreshGlossary();
				refreshJobs();
				refreshSettings();
				healthTimer.current = setInterval(refreshHealth, 3e4);
				jobsTimer.current = setInterval(refreshJobs, 5e3);
				const onKey = (ev) => {
					if (ev.key !== "Escape") return;
					if (modalRef.current) setModalOpen(false);
					else hide();
				};
				window.addEventListener("keydown", onKey);
				return () => {
					if (healthTimer.current !== null) clearInterval(healthTimer.current);
					if (jobsTimer.current !== null) clearInterval(jobsTimer.current);
					window.removeEventListener("keydown", onKey);
				};
			}, [
				hide,
				refreshHealth,
				refreshGlossary,
				refreshJobs,
				refreshSettings
			]);
			const remember = (0, react.useCallback)((p) => {
				setRecent(pushRecent(p));
			}, []);
			const uploadFile = (0, react.useCallback)(async (file) => {
				if (!/\.pdf$/i.test(file.name)) {
					setError("仅支持 .pdf 文件");
					return;
				}
				if (file.size > 104857600) {
					setError("PDF 不能超过 100 MB");
					return;
				}
				setError("");
				setNotice("");
				setUploading(true);
				setUploadName(file.name);
				try {
					const resp = await fetch(`${API_PREFIX}/upload`, {
						method: "POST",
						headers: {
							"content-type": "application/octet-stream",
							"x-pdf2zh-filename": encodeURIComponent(file.name)
						},
						body: file
					});
					let data = null;
					try {
						data = await resp.json();
					} catch {}
					if (!resp.ok) throw new Error(data && data.error || `HTTP ${resp.status}`);
					setPath(data.path);
					remember(data.path);
				} catch (err) {
					setError(err?.message ?? String(err));
				} finally {
					setUploading(false);
					setDragOver(false);
				}
			}, [remember]);
			const onSaveGlossary = (0, react.useCallback)(async () => {
				setSavingGlossary(true);
				setError("");
				try {
					await api.glossarySave(glossaryDraft);
					setEditingGlossary(false);
					refreshGlossary();
				} catch (err) {
					setError(err?.message ?? String(err));
				} finally {
					setSavingGlossary(false);
				}
			}, [glossaryDraft, refreshGlossary]);
			const onExtract = (0, react.useCallback)(async () => {
				if (!path.trim()) return;
				setError("");
				setNotice("");
				setExtract(null);
				setExtracting(true);
				try {
					const result = await api.extract(path.trim(), pages.trim() || void 0);
					setExtract(result);
					remember(path.trim());
				} catch (err) {
					setError(err?.message ?? String(err));
				} finally {
					setExtracting(false);
				}
			}, [
				path,
				pages,
				remember
			]);
			const onTranslate = (0, react.useCallback)(async () => {
				if (!path.trim()) return;
				setError("");
				setNotice("");
				setTranslating(true);
				try {
					const trimmed = path.trim();
					const result = await api.translate({
						path: trimmed,
						pages: pages.trim() || void 0,
						bilingual,
						appendix,
						sourceChars: extract !== null && extract.pdfPath === trimmed ? extract.chars : void 0
					});
					remember(trimmed);
					const via = result.provider ? `（API ${result.provider}/${result.model}）` : "";
					setNotice(`翻译任务已创建${via}，进度见上方「翻译看板」。`);
					refreshJobs();
				} catch (err) {
					setError(err?.message ?? String(err));
				} finally {
					setTranslating(false);
				}
			}, [
				path,
				pages,
				bilingual,
				appendix,
				extract,
				remember,
				refreshJobs
			]);
			const onJobDelete = (0, react.useCallback)((id) => {
				api.jobDelete(id).then(refreshJobs).catch((err) => setError(err?.message ?? String(err)));
			}, [refreshJobs]);
			const onJobsClear = (0, react.useCallback)(() => {
				api.jobsClear().then(refreshJobs).catch((err) => setError(err?.message ?? String(err)));
			}, [refreshJobs]);
			const onPathKeyDown = (0, react.useCallback)((ev) => {
				if (ev.key === "Enter") {
					ev.preventDefault();
					onExtract();
				}
			}, [onExtract]);
			const pathValid = path.trim().length > 0;
			const busy = extracting || translating;
			const glossaryLines = glossary ? glossary.text.split("\n").filter(isGlossaryTerm).slice(0, 5) : [];
			const modelLabel = settings === null ? "" : settings.model.provider !== "" ? ` · ${settings.model.provider}/${settings.model.model}` : " · API 自动";
			return e("div", {
				className: "pdf2zh-shell",
				role: "region",
				"aria-label": "PDF 英转中"
			}, e("header", { className: "pdf2zh-top" }, e("div", { className: "pdf2zh-top-inner" }, e("div", { className: "pdf2zh-heading" }, e("span", { className: "pdf2zh-logo" }, e("svg", {
				viewBox: "0 0 24 24",
				fill: "currentColor",
				"aria-hidden": "true"
			}, e("path", { d: "M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z" }))), e("div", { className: "pdf2zh-heading-text" }, e("div", { className: "pdf2zh-title" }, "PDF 英转中"), e("span", { className: "pdf2zh-tab" }, "pdf2zh · 轻量化学术论文 PDF 英转中"))), e("div", { className: "pdf2zh-top-actions" }, e("button", {
				type: "button",
				className: "pdf2zh-back",
				onClick: () => {
					setModalOpen(true);
				},
				title: "打开设置（翻译模型 API / 保存路径 / 超时）"
			}, e("span", { className: "pdf2zh-gear" }, GearIcon()), "设置"), e("button", {
				type: "button",
				className: "pdf2zh-back",
				onClick: hide
			}, "返回会话")))), e("main", { className: "pdf2zh-scroll" }, e("div", { className: "pdf2zh-content" }, e("div", { className: "pdf2zh-guide" }, GUIDE_STEPS.map((step, i) => e("span", {
				key: step,
				className: "pdf2zh-guide-step"
			}, e("span", { className: "pdf2zh-guide-num" }, String(i + 1)), step, i < GUIDE_STEPS.length - 1 ? e("span", { className: "pdf2zh-guide-arrow" }, "→") : null))), e(Board, {
				jobs,
				summary,
				onDelete: onJobDelete,
				onClear: onJobsClear
			}), Section({
				title: "翻译论文",
				note: "填服务器上的 PDF 绝对路径，或直接拖拽/选择本地 PDF 上传",
				children: [
					e("div", {
						className: `pdf2zh-drop${dragOver ? " pdf2zh-drop-hot" : ""}`,
						onClick: () => {
							fileRef.current?.click();
						},
						onDragOver: (ev) => {
							ev.preventDefault();
							setDragOver(true);
						},
						onDragLeave: () => setDragOver(false),
						onDrop: (ev) => {
							ev.preventDefault();
							setDragOver(false);
							const file = ev.dataTransfer?.files?.[0];
							if (file) uploadFile(file);
						}
					}, e("input", {
						ref: fileRef,
						type: "file",
						accept: ".pdf,application/pdf",
						style: { display: "none" },
						onChange: (ev) => {
							const file = ev.target?.files?.[0];
							if (file) uploadFile(file);
							if (ev.target) ev.target.value = "";
						}
					}), e("span", { className: "pdf2zh-drop-icon" }, e("svg", {
						viewBox: "0 0 24 24",
						fill: "currentColor",
						"aria-hidden": "true"
					}, e("path", { d: "M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z" }))), uploading ? e("span", null, `正在上传 ${uploadName}…`) : e("span", null, "拖拽 PDF 到此处，或点击选择文件上传到服务器")),
					e("input", {
						className: "pdf2zh-input",
						style: INPUT_STYLE,
						value: path,
						placeholder: "/data02/zhangqinhan/papers/attention.pdf",
						onChange: (ev) => setPath(ev.target.value),
						onKeyDown: onPathKeyDown,
						spellCheck: false
					}),
					recent.length > 0 ? e("div", { className: "pdf2zh-recent" }, e("span", { className: "pdf2zh-recent-label" }, "最近"), recent.map((p) => e("button", {
						key: p,
						type: "button",
						className: "pdf2zh-recent-chip",
						title: p,
						onClick: () => setPath(p)
					}, p.split("/").pop()))) : null,
					e("div", { className: "pdf2zh-options" }, e("label", { className: "pdf2zh-field" }, "页码（默认全文）", e("input", {
						style: {
							...INPUT_STYLE,
							width: 130
						},
						value: pages,
						placeholder: "默认全文",
						onChange: (ev) => setPages(ev.target.value)
					})), e("label", { className: "pdf2zh-check" }, e("input", {
						type: "checkbox",
						checked: bilingual,
						onChange: (ev) => setBilingual(ev.target.checked)
					}), "中英对照"), e("label", { className: "pdf2zh-check" }, e("input", {
						type: "checkbox",
						checked: appendix,
						onChange: (ev) => setAppendix(ev.target.checked)
					}), "含附录")),
					e("div", { className: "pdf2zh-actions" }, e("button", {
						type: "button",
						className: "pdf2zh-btn",
						disabled: !pathValid || busy,
						onClick: onExtract
					}, extracting ? "提取中…" : "提取预览"), e("button", {
						type: "button",
						className: "pdf2zh-btn pdf2zh-btn-primary",
						disabled: !pathValid || busy,
						onClick: onTranslate
					}, translating ? "创建任务中…" : "开始翻译（新建会话）"), !pathValid ? e("span", { className: "pdf2zh-hint" }, "回车 = 提取预览") : null)
				]
			}), notice !== "" ? e("div", { className: "pdf2zh-notice" }, notice) : null, error !== "" ? e("div", { className: "pdf2zh-error" }, error) : null, extract !== null ? Section({
				title: "提取完成",
				accent: "success",
				children: [e("div", { className: "pdf2zh-stats" }, e(StatChip, {
					label: "页数",
					value: extract.pages
				}), e(StatChip, {
					label: "字符",
					value: extract.chars.toLocaleString()
				}), e("span", {
					className: "pdf2zh-outpath",
					title: extract.outPath
				}, extract.outPath)), e("details", { className: "pdf2zh-preview" }, e("summary", null, "抽查提取文本（前 1200 字符）"), e("pre", null, extract.preview))]
			}) : null, Section({
				title: "术语表",
				note: "跨论文译名一致 · 可编辑",
				children: [glossary === null ? e("div", { className: "pdf2zh-mut" }, "暂不可用") : editingGlossary ? e("div", { className: "pdf2zh-glossary-edit" }, e("textarea", {
					className: "pdf2zh-glossary-textarea",
					value: glossaryDraft,
					spellCheck: false,
					onChange: (ev) => setGlossaryDraft(ev.target.value)
				}), e("div", { className: "pdf2zh-mut" }, "格式：每行一条 `英文: 中文`（# 开头为注释）。保存后直接写回技能目录的 glossary.md。"), e("div", { className: "pdf2zh-actions" }, e("button", {
					type: "button",
					className: "pdf2zh-btn pdf2zh-btn-primary",
					disabled: savingGlossary,
					onClick: onSaveGlossary
				}, savingGlossary ? "保存中…" : "保存"), e("button", {
					type: "button",
					className: "pdf2zh-btn",
					onClick: () => setEditingGlossary(false)
				}, "取消"))) : e("div", null, glossaryLines.length > 0 ? e("div", { className: "pdf2zh-glossary-sample" }, glossaryLines.map((l) => e("div", {
					key: l,
					className: "pdf2zh-glossary-line"
				}, l)), glossary.terms > glossaryLines.length ? e("div", { className: "pdf2zh-mut" }, `… 共 ${glossary.terms} 条`) : null) : e("div", { className: "pdf2zh-mut" }, "（空）"), e("div", { className: "pdf2zh-actions" }, e("button", {
					type: "button",
					className: "pdf2zh-btn",
					onClick: () => {
						setGlossaryDraft(glossary.text);
						setEditingGlossary(true);
					}
				}, "编辑术语表")), e("details", { className: "pdf2zh-preview" }, e("summary", null, `全文（${glossary.terms} 条）`), e("pre", null, glossary.text)))]
			}))), e("footer", { className: "pdf2zh-foot" }, health !== null ? e("div", { className: "pdf2zh-foot-inner" }, e("span", { className: "pdf2zh-foot-status" }, e(HealthDot, {
				ok: health.pymupdf.available,
				label: `PyMuPDF ${health.pymupdf.available ? health.pymupdf.version : "缺失"}`
			}), e(HealthDot, {
				ok: health.skill.synced,
				label: health.skill.synced ? "技能已同步" : "技能未同步"
			})), e("span", {
				className: "pdf2zh-foot-meta",
				title: health.skill.synced ? health.skill.dir : ""
			}, `v${health.version} · ${health.python}${modelLabel}`)) : healthError !== "" ? e("span", { className: "pdf2zh-error" }, healthError) : e("span", { className: "pdf2zh-mut" }, "连接中…")), modalOpen ? e(SettingsModal, {
				settings,
				onClose: () => setModalOpen(false),
				onSaved: setSettings
			}) : null);
		}
		const CONVERSATION_COLUMN_SELECTOR = "[data-pane=\"conversation\"], [class*=\"centerCol\"]";
		const ACTIVE_ATTR = "data-dsh-pdf2zh-active";
		/** Sibling panels of the single-occupant center column (activation attributes). */
		const SIBLING_ATTRS = [
			"data-dsh-taskboard-active",
			"data-dsh-ssh-active",
			"data-dsh-cev2-active",
			"data-dsh-taskboard-local-active",
			"data-dsh-token-usage-board-active"
		];
		/** Cross-plugin activation event details announcing the other center-column panels. */
		const SIBLING_DETAILS = [
			"taskboard",
			"ssh",
			"cron-explorer-v2",
			"token-usage-board"
		];
		const ACTIVATE_EVENT = "dsh-panel-activate";
		const PANEL_NAME = "pdf2zh";
		/** Sidebar context clicks hand the center column back to the conversation. */
		const SIDEBAR_ROW_SELECTOR = "[class*=\"sessionRow\"], [class*=\"projectRow\"], [class*=\"searchResultRow\"], [class*=\"searchResultWorkspace\"], [class*=\"newSession\"]";
		function mountPanel(controller) {
			let root;
			let container;
			const ensure = () => {
				if (container !== void 0) {
					if (container.isConnected) return;
					root?.unmount();
					root = void 0;
					container.remove();
					container = void 0;
				}
				const column = document.querySelector(CONVERSATION_COLUMN_SELECTOR);
				if (column === null) return;
				container = document.createElement("div");
				container.dataset.dshPdf2zhView = "";
				container.dataset.dshPlugin = "pdf2zh";
				column.appendChild(container);
				root = (0, react_dom_client.createRoot)(container);
				root.render(e(PanelView, { controller }));
			};
			const waitObserver = new MutationObserver(() => {
				ensure();
			});
			waitObserver.observe(document.body, {
				childList: true,
				subtree: true
			});
			let evicting = false;
			const applyActive = () => {
				if (controller.getSnapshot()) {
					evicting = true;
					try {
						document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: "ssh" }));
						document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }));
					} finally {
						evicting = false;
					}
					for (const attr of SIBLING_ATTRS) document.documentElement.removeAttribute(attr);
					document.documentElement.setAttribute(ACTIVE_ATTR, "");
				} else document.documentElement.removeAttribute(ACTIVE_ATTR);
			};
			const onOtherActivate = (event) => {
				if (evicting) return;
				const detail = event.detail;
				if (SIBLING_DETAILS.includes(detail) && controller.getSnapshot()) controller.hide();
			};
			const onClickSidebarRow = (event) => {
				if (!controller.getSnapshot()) return;
				const target = event.target;
				if (target === null) return;
				if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) controller.hide();
			};
			const onKey = (ev) => {
				if (ev.key === "Escape" && controller.getSnapshot() && document.querySelector(".pdf2zh-modal-mask") === null) controller.hide();
			};
			document.addEventListener("click", onClickSidebarRow, true);
			document.addEventListener(ACTIVATE_EVENT, onOtherActivate);
			document.addEventListener("keydown", onKey);
			const unsubscribe = controller.subscribe(applyActive);
			applyActive();
			ensure();
			return () => {
				document.removeEventListener("click", onClickSidebarRow, true);
				document.removeEventListener(ACTIVATE_EVENT, onOtherActivate);
				document.removeEventListener("keydown", onKey);
				waitObserver.disconnect();
				unsubscribe();
				document.documentElement.removeAttribute(ACTIVE_ATTR);
				root?.unmount();
				root = void 0;
				container?.remove();
				container = void 0;
			};
		}
		/**
		* React tree for the center-column view container. The Panel mounts only
		* while the panel is open, so each open refetches fresh state.
		*/
		function PanelView({ controller }) {
			return (0, react.useSyncExternalStore)(controller.subscribe, controller.getSnapshot) ? e(Panel, { hide: controller.hide }) : null;
		}
		const SKILL_SELECTOR = "[data-dsh-skill-explorer-entry]";
		function makeRow(onToggle) {
			const row = document.createElement("div");
			row.setAttribute("data-dsh-pdf2zh-entry", "");
			row.setAttribute("role", "button");
			row.setAttribute("tabindex", "0");
			row.className = "pdf2zh-entry";
			row.innerHTML = "<span class=\"pdf2zh-entryIcon\"><svg viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z\"/></svg></span><span class=\"pdf2zh-entryLabel\">PDF 英转中</span>";
			row.setAttribute("aria-label", "PDF 英转中");
			row.addEventListener("click", onToggle);
			row.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter" || ev.key === " ") {
					ev.preventDefault();
					onToggle();
				}
			});
			row.__dispose = () => {
				row.remove();
			};
			return row;
		}
		function placeRow(row) {
			if (row.isConnected) return true;
			const skill = document.querySelector(SKILL_SELECTOR);
			if (skill !== null && skill.parentNode !== null) {
				skill.parentNode.insertBefore(row, skill.nextSibling);
				return true;
			}
			const sidebar = document.querySelector("[data-pane=\"sidebar\"], [class*=\"sidebarCol\"]");
			if (sidebar === null) return false;
			const anchor = sidebar.querySelector("button[class*=\"newSession\"]");
			if (anchor !== null) anchor.insertAdjacentElement("afterend", row);
			else sidebar.insertBefore(row, sidebar.firstChild);
			return true;
		}
		const CSS = `
/* --- center-column takeover (global rules, attribute-scoped) ---------------- */

[data-dsh-pdf2zh-view] {
  position: absolute;
  inset: 0;
  display: none;
  z-index: 60;
  background: var(--dsw-alias-bg-base);
}

html[data-dsh-pdf2zh-active] [data-dsh-pdf2zh-view] {
  display: block;
}

html[data-dsh-pdf2zh-active] [data-pane='conversation'] > :not([data-dsh-pdf2zh-view]),
html[data-dsh-pdf2zh-active] [class*='centerCol'] > :not([data-dsh-pdf2zh-view]) {
  display: none !important;
}

/* --- panel shell ------------------------------------------------------------ */

.pdf2zh-shell {
  position: relative;
  box-sizing: border-box;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family, inherit);
}
.pdf2zh-shell *, .pdf2zh-shell *::before, .pdf2zh-shell *::after { box-sizing: border-box; }

.pdf2zh-top {
  flex: none;
  padding: 12px 20px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.pdf2zh-top-inner {
  max-width: 780px;
  margin: 0 auto;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.pdf2zh-heading { display: flex; align-items: center; gap: 10px; min-width: 0; }
.pdf2zh-logo {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.pdf2zh-logo svg { width: 19px; height: 19px; }
.pdf2zh-heading-text { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.pdf2zh-title { font-size: 17px; font-weight: 600; white-space: nowrap; }
.pdf2zh-tab {
  font-size: 13px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pdf2zh-top-actions { display: inline-flex; align-items: center; gap: 8px; flex: none; }
.pdf2zh-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 7px 14px;
  font-size: 13px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  transition: background-color .12s ease, color .12s ease;
}
.pdf2zh-back:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.pdf2zh-gear { display: inline-flex; }
.pdf2zh-gear svg { width: 14px; height: 14px; }

.pdf2zh-scroll { flex: 1; overflow-y: auto; }
.pdf2zh-content { max-width: 780px; margin: 0 auto; padding: 18px 20px 32px; display: flex; flex-direction: column; gap: 14px; }

/* --- workflow guide ---------------------------------------------------------- */

.pdf2zh-guide {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 6px;
  padding: 9px 14px;
  border-radius: 10px;
  border: 1px dashed var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
}
.pdf2zh-guide-step { display: inline-flex; align-items: center; gap: 5px; }
.pdf2zh-guide-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 600;
  color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.pdf2zh-guide-arrow { margin: 0 2px; opacity: .6; }

/* --- section cards ------------------------------------------------------------ */

.pdf2zh-section {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  overflow: hidden;
  background: var(--dsw-alias-bg-base);
}
.pdf2zh-section-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.pdf2zh-section-title { font-size: 14px; font-weight: 600; }
.pdf2zh-section-note { font-size: 13px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pdf2zh-section-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 11px; }

/* success accent for result cards */
.pdf2zh-section-success { border-color: var(--dsw-alias-state-success-primary); }
.pdf2zh-section-success .pdf2zh-section-title { color: var(--dsw-alias-state-success-primary); }

/* --- settings modal ------------------------------------------------------------- */

.pdf2zh-modal-mask {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, .42);
}
.pdf2zh-modal {
  width: 560px;
  max-width: 100%;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  box-shadow: 0 18px 48px rgba(0, 0, 0, .35);
}
.pdf2zh-modal-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.pdf2zh-modal-title { font-size: 15px; font-weight: 600; }
.pdf2zh-modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.pdf2zh-modal-section-title {
  margin-top: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
}
.pdf2zh-modal-section-title:first-child { margin-top: 0; }
.pdf2zh-modal-foot {
  flex: none;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 16px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.pdf2zh-api-groups { display: flex; flex-direction: column; gap: 8px; }
.pdf2zh-api-group { display: flex; flex-direction: column; gap: 4px; }
.pdf2zh-api-group-off { opacity: .5; }
.pdf2zh-api-group-head {
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-tertiary);
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
.pdf2zh-api-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  transition: background-color .12s ease, border-color .12s ease;
}
.pdf2zh-api-row:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.pdf2zh-api-row:disabled { cursor: default; opacity: .7; }
.pdf2zh-api-row-active { border-color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-interactive-bg-hover); }
.pdf2zh-api-radio {
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1.5px solid var(--dsw-alias-border-l2);
}
.pdf2zh-api-row-active .pdf2zh-api-radio {
  border-color: var(--dsw-alias-state-business-primary);
  background: radial-gradient(circle, var(--dsw-alias-state-business-primary) 0 4px, transparent 4.5px);
}
.pdf2zh-api-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.pdf2zh-api-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pdf2zh-api-provider { font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pdf2zh-api-tag {
  flex: none;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid currentColor;
  color: var(--dsw-alias-label-tertiary);
}
.pdf2zh-api-tag-active { color: var(--dsw-alias-state-business-primary); }

/* --- translation board --------------------------------------------------------- */

.pdf2zh-board-stats { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.pdf2zh-stat {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid currentColor;
  font-size: 12px;
}
.pdf2zh-stat b { font-size: 14px; font-weight: 700; }
.pdf2zh-stat-running { color: var(--dsw-alias-state-business-primary); }
.pdf2zh-stat-done { color: var(--dsw-alias-state-success-primary); }
.pdf2zh-stat-failed { color: var(--dsw-alias-state-error-primary); }
.pdf2zh-btn-mini { padding: 4px 11px; font-size: 12px; }

.pdf2zh-overall { display: flex; align-items: center; gap: 10px; }
.pdf2zh-overall-label { flex: none; width: 72px; font-size: 12px; color: var(--dsw-alias-label-secondary); }

.pdf2zh-bar {
  flex: 1;
  min-width: 0;
  height: 8px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  overflow: hidden;
}
.pdf2zh-bar-fill { height: 100%; border-radius: 999px; transition: width .6s ease; }
.pdf2zh-bar-running { background: var(--dsw-alias-state-business-primary); }
.pdf2zh-bar-done { background: var(--dsw-alias-state-success-primary); }
.pdf2zh-bar-failed { background: var(--dsw-alias-state-error-primary); }
.pdf2zh-bar-overall { background: linear-gradient(90deg, var(--dsw-alias-state-business-primary), var(--dsw-alias-state-success-primary)); }

.pdf2zh-jobs { display: flex; flex-direction: column; gap: 10px; }
.pdf2zh-job {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.pdf2zh-job-running { border-color: var(--dsw-alias-state-business-primary); }
.pdf2zh-job-done { border-color: var(--dsw-alias-state-success-primary); }
.pdf2zh-job-failed { border-color: var(--dsw-alias-state-error-primary); }
.pdf2zh-job-head { display: flex; align-items: center; gap: 8px; }
.pdf2zh-job-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pdf2zh-badge { flex: none; font-size: 11px; padding: 2px 9px; border-radius: 999px; border: 1px solid currentColor; }
.pdf2zh-badge-running { color: var(--dsw-alias-state-business-primary); }
.pdf2zh-badge-done { color: var(--dsw-alias-state-success-primary); }
.pdf2zh-badge-failed { color: var(--dsw-alias-state-error-primary); }
.pdf2zh-job-time { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.pdf2zh-job-del {
  flex: none;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 5px;
}
.pdf2zh-job-del:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.pdf2zh-job-bar { display: flex; align-items: center; gap: 9px; }
.pdf2zh-job-pct { flex: none; width: 38px; text-align: right; font-size: 12px; font-weight: 600; }
.pdf2zh-job-pct-running { color: var(--dsw-alias-state-business-primary); }
.pdf2zh-job-pct-done { color: var(--dsw-alias-state-success-primary); }
.pdf2zh-job-pct-failed { color: var(--dsw-alias-state-error-primary); }
.pdf2zh-job-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  word-break: break-all;
}
.pdf2zh-job-error { color: var(--dsw-alias-state-error-primary); }
.pdf2zh-job-warn { color: var(--dsw-alias-state-error-primary); opacity: .85; }

/* --- form ---------------------------------------------------------------------- */

.pdf2zh-input::placeholder { color: var(--dsw-alias-label-tertiary); }
.pdf2zh-input:focus { border-color: var(--dsw-alias-state-business-primary); }
.pdf2zh-options { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; }
.pdf2zh-field { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.pdf2zh-field-row { display: flex; flex-direction: column; gap: 6px; }
.pdf2zh-field-label { font-size: 13px; color: var(--dsw-alias-label-secondary); }
.pdf2zh-check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--dsw-alias-label-secondary); cursor: pointer; user-select: none; }
.pdf2zh-check input { accent-color: var(--dsw-alias-state-business-primary); }

/* drop zone */
.pdf2zh-drop {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border: 1.5px dashed var(--dsw-alias-border-l2);
  border-radius: 10px;
  cursor: pointer;
  font-size: 13px;
  color: var(--dsw-alias-label-tertiary);
  transition: border-color .12s ease, background-color .12s ease, color .12s ease;
}
.pdf2zh-drop:hover { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-secondary); }
.pdf2zh-drop-hot {
  border-color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.pdf2zh-drop-icon { display: inline-flex; flex: none; color: var(--dsw-alias-state-business-primary); }
.pdf2zh-drop-icon svg { width: 18px; height: 18px; }

/* recent paths */
.pdf2zh-recent { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.pdf2zh-recent-label { font-size: 12px; color: var(--dsw-alias-label-tertiary); margin-right: 2px; }
.pdf2zh-recent-chip {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 4px 11px;
  font-size: 12px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  transition: background-color .12s ease, color .12s ease, border-color .12s ease;
}
.pdf2zh-recent-chip:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  border-color: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-label-primary);
}

/* actions */
.pdf2zh-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.pdf2zh-btn {
  padding: 8px 16px;
  font-size: 14px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  transition: background-color .12s ease, opacity .12s ease, border-color .12s ease;
}
.pdf2zh-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.pdf2zh-btn:disabled { opacity: .45; cursor: not-allowed; }
.pdf2zh-btn-primary {
  background: var(--dsw-alias-state-business-primary);
  border-color: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.pdf2zh-btn-primary:hover:not(:disabled) { opacity: .88; background: var(--dsw-alias-state-business-primary); }
.pdf2zh-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary); }

/* --- feedback ------------------------------------------------------------------- */

.pdf2zh-error {
  padding: 10px 13px;
  font-size: 13px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
  white-space: pre-wrap;
  word-break: break-all;
}
.pdf2zh-notice {
  padding: 10px 13px;
  font-size: 13px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary);
  word-break: break-all;
}
.pdf2zh-mut { font-size: 13px; color: var(--dsw-alias-label-tertiary); line-height: 1.6; word-break: break-all; }
.pdf2zh-mut code, .pdf2zh-section-body code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
}

.pdf2zh-stats { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.pdf2zh-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  padding: 4px 11px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary);
  font-size: 12px;
}
.pdf2zh-chip-value { font-size: 13px; font-weight: 600; }
.pdf2zh-chip-label { opacity: .8; }
.pdf2zh-outpath {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  text-align: right;
}

.pdf2zh-preview summary {
  font-size: 13px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  user-select: none;
}
.pdf2zh-preview summary:hover { color: var(--dsw-alias-label-primary); }
.pdf2zh-preview pre {
  margin: 8px 0 0;
  max-height: 300px;
  overflow: auto;
  padding: 10px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.65;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  white-space: pre-wrap;
  word-break: break-word;
}

/* glossary editor */
.pdf2zh-glossary-edit { display: flex; flex-direction: column; gap: 9px; }
.pdf2zh-glossary-textarea {
  width: 100%;
  min-height: 280px;
  resize: vertical;
  padding: 10px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.65;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  outline: none;
}
.pdf2zh-glossary-textarea:focus { border-color: var(--dsw-alias-state-business-primary); }

/* glossary sample */
.pdf2zh-glossary-sample {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
}
.pdf2zh-glossary-line {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* --- footer ----------------------------------------------------------------------- */

.pdf2zh-foot {
  flex: none;
  padding: 8px 20px;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.pdf2zh-foot-inner {
  max-width: 780px;
  margin: 0 auto;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}
.pdf2zh-foot-status { display: inline-flex; align-items: center; flex: none; gap: 12px; }
.pdf2zh-foot-meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: .75;
}
.pdf2zh-status { display: inline-flex; align-items: center; gap: 5px; }
.pdf2zh-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.pdf2zh-dot-ok { background: var(--dsw-alias-state-success-primary); }
.pdf2zh-dot-bad { background: var(--dsw-alias-state-error-primary); }

/* --- sidebar entry row --------------------------------------------------------------- */

.pdf2zh-entry {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 36px;
  padding: 0 10px;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font-size: 13px;
  transition: background-color .12s ease, color .12s ease;
}
.pdf2zh-entry:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.pdf2zh-entry[data-active] { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); }
.pdf2zh-entryIcon { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; flex: none; }
.pdf2zh-entryIcon svg { width: 17px; height: 17px; }
.pdf2zh-entryLabel { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`;
		const inject = [];
		function ensureCss() {
			if (document.querySelector("style[data-plugin-css=\"dsh-pdf2zh\"]") !== null) return;
			const el = document.createElement("style");
			el.setAttribute("data-plugin-css", "dsh-pdf2zh");
			el.textContent = CSS;
			document.head.appendChild(el);
		}
		function apply(ctx) {
			try {
				ensureCss();
				const controller = new PanelController();
				const row = makeRow(() => {
					controller.toggle();
				});
				const syncEntry = () => {
					row.toggleAttribute("data-active", controller.getSnapshot());
				};
				const unsubscribeEntry = controller.subscribe(syncEntry);
				syncEntry();
				let observer = null;
				let retrier;
				let settle;
				const startObserver = () => {
					if (observer !== null || !row.isConnected) return;
					const target = row.parentNode ?? document.body;
					observer = new MutationObserver(() => {
						if (!row.isConnected) placeRow(row);
					});
					observer.observe(target, {
						childList: true,
						subtree: true
					});
				};
				if (!placeRow(row)) {
					retrier = setInterval(() => {
						if (placeRow(row)) {
							clearInterval(retrier);
							retrier = void 0;
							startObserver();
						}
					}, 1e3);
					settle = setTimeout(() => {
						if (retrier !== void 0) {
							clearInterval(retrier);
							retrier = void 0;
						}
					}, 3e4);
				} else startObserver();
				const disposePanel = mountPanel(controller);
				const cleanup = () => {
					document.documentElement.removeAttribute(ACTIVE_ATTR);
					unsubscribeEntry();
					if (retrier !== void 0) clearInterval(retrier);
					if (settle !== void 0) clearTimeout(settle);
					if (observer !== null) observer.disconnect();
					disposePanel();
					row.__dispose?.();
				};
				if (ctx && typeof ctx.effect === "function") return ctx.effect(() => cleanup, "pdf2zh: ui mounts");
				return { dispose: cleanup };
			} catch (error) {
				console.warn("[pdf2zh] client mount failed:", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
