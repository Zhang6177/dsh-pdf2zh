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
		* ssh / token-usage-board eviction). The panel offers: PDF path input,
		* options (pages / 中英对照 / 含附录), extract preview, one-click session
		* translation, glossary view, and plugin health.
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
			glossary: () => call(`${API_PREFIX}/glossary`, "GET")
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
		const INPUT_STYLE = {
			boxSizing: "border-box",
			width: "100%",
			padding: "8px 10px",
			fontSize: 13,
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-base)",
			color: "var(--dsw-alias-label-primary)",
			outline: "none"
		};
		function Section({ title, note, children }) {
			return e("div", { className: "pdf2zh-section" }, e("div", { className: "pdf2zh-section-head" }, e("span", { className: "pdf2zh-section-title" }, title), note ? e("span", { className: "pdf2zh-section-note" }, note) : null), e("div", { className: "pdf2zh-section-body" }, children));
		}
		function Panel({ hide, openSession }) {
			const [health, setHealth] = (0, react.useState)(null);
			const [healthError, setHealthError] = (0, react.useState)("");
			const [path, setPath] = (0, react.useState)("");
			const [pages, setPages] = (0, react.useState)("");
			const [bilingual, setBilingual] = (0, react.useState)(false);
			const [appendix, setAppendix] = (0, react.useState)(false);
			const [extracting, setExtracting] = (0, react.useState)(false);
			const [translating, setTranslating] = (0, react.useState)(false);
			const [extract, setExtract] = (0, react.useState)(null);
			const [session, setSession] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)("");
			const [glossary, setGlossary] = (0, react.useState)(null);
			const healthTimer = (0, react.useRef)(null);
			const refreshHealth = (0, react.useCallback)(() => {
				api.health().then(setHealth).catch((err) => setHealthError(err?.message ?? String(err)));
			}, []);
			(0, react.useEffect)(() => {
				refreshHealth();
				healthTimer.current = setInterval(refreshHealth, 3e4);
				const onKey = (ev) => {
					if (ev.key === "Escape") hide();
				};
				window.addEventListener("keydown", onKey);
				return () => {
					if (healthTimer.current !== null) clearInterval(healthTimer.current);
					window.removeEventListener("keydown", onKey);
				};
			}, [hide, refreshHealth]);
			const onExtract = (0, react.useCallback)(async () => {
				setError("");
				setExtract(null);
				setExtracting(true);
				try {
					const result = await api.extract(path.trim(), pages.trim() || void 0);
					setExtract(result);
				} catch (err) {
					setError(err?.message ?? String(err));
				} finally {
					setExtracting(false);
				}
			}, [path, pages]);
			const onTranslate = (0, react.useCallback)(async () => {
				setError("");
				setSession(null);
				setTranslating(true);
				try {
					const result = await api.translate({
						path: path.trim(),
						pages: pages.trim() || void 0,
						bilingual,
						appendix
					});
					setSession(result);
				} catch (err) {
					setError(err?.message ?? String(err));
				} finally {
					setTranslating(false);
				}
			}, [
				path,
				pages,
				bilingual,
				appendix
			]);
			const refreshGlossary = (0, react.useCallback)(() => {
				api.glossary().then(setGlossary).catch(() => setGlossary(null));
			}, []);
			(0, react.useEffect)(() => {
				refreshGlossary();
			}, [refreshGlossary]);
			const pathValid = path.trim().length > 0;
			const busy = extracting || translating;
			return e("div", {
				className: "pdf2zh-shell",
				role: "region",
				"aria-label": "PDF 英转中"
			}, e("header", { className: "pdf2zh-top" }, e("div", { className: "pdf2zh-heading" }, e("div", { className: "pdf2zh-title" }, "PDF 英转中"), e("span", { className: "pdf2zh-tab" }, "pdf2zh · 轻量化学术论文 PDF 英转中")), e("button", {
				type: "button",
				className: "pdf2zh-back",
				onClick: hide
			}, "返回会话")), e("main", { className: "pdf2zh-scroll" }, e("div", { className: "pdf2zh-content" }, Section("翻译论文", "填写服务器上的 PDF 路径", e("input", {
				className: "pdf2zh-input",
				style: INPUT_STYLE,
				value: path,
				placeholder: "/data02/zhangqinhan/papers/attention.pdf",
				onChange: (ev) => setPath(ev.target.value),
				spellCheck: false
			}), e("div", { className: "pdf2zh-options" }, e("label", { className: "pdf2zh-field" }, e("span", null, "页码范围"), e("input", {
				style: {
					...INPUT_STYLE,
					width: 110
				},
				value: pages,
				placeholder: "1-8",
				onChange: (ev) => setPages(ev.target.value)
			})), e("label", { className: "pdf2zh-check" }, e("input", {
				type: "checkbox",
				checked: bilingual,
				onChange: (ev) => setBilingual(ev.target.checked)
			}), "中英对照"), e("label", { className: "pdf2zh-check" }, e("input", {
				type: "checkbox",
				checked: appendix,
				onChange: (ev) => setAppendix(ev.target.checked)
			}), "含附录")), e("div", { className: "pdf2zh-actions" }, e("button", {
				type: "button",
				className: "pdf2zh-btn",
				disabled: !pathValid || busy,
				onClick: onExtract
			}, extracting ? "提取中…" : "提取预览"), e("button", {
				type: "button",
				className: "pdf2zh-btn pdf2zh-btn-primary",
				disabled: !pathValid || busy,
				onClick: onTranslate
			}, translating ? "创建中…" : "开始翻译（新建会话）"))), error !== "" ? e("div", { className: "pdf2zh-error" }, error) : null, extract !== null ? Section(`提取完成 · ${extract.pages} 页 · ${extract.chars} 字符`, e("div", { className: "pdf2zh-mut" }, `文本文件：${extract.outPath}`), e("details", { className: "pdf2zh-preview" }, e("summary", null, "查看提取预览（前 1200 字符）"), e("pre", null, extract.preview))) : null, session !== null ? Section("翻译会话已创建", e("div", { className: "pdf2zh-mut" }, `${session.title} · 工作区 ${session.cwd}`), e("div", { className: "pdf2zh-mut" }, "模型正按 pdf2zh 技能逐节翻译，可在左侧会话列表查看进度。"), openSession !== void 0 ? e("button", {
				type: "button",
				className: "pdf2zh-btn",
				onClick: () => {
					openSession(session.sessionId);
				}
			}, "查看会话") : null) : null, Section("术语表", "跨论文译名一致", glossary === null ? e("div", { className: "pdf2zh-mut" }, "暂不可用") : e("div", null, e("div", { className: "pdf2zh-mut" }, `当前 ${glossary.terms} 条`), e("details", { className: "pdf2zh-preview" }, e("summary", null, "查看全文"), e("pre", null, glossary.text || "（空）")))))), e("footer", { className: "pdf2zh-foot" }, health !== null ? e("span", null, `v${health.version} · ${health.python}${health.pymupdf.available ? ` · PyMuPDF ${health.pymupdf.version}` : " · PyMuPDF 缺失（提取不可用）"} · 技能 ${health.skill.synced ? `已同步 → ${health.skill.dir}` : "未同步"}`) : healthError !== "" ? e("span", { className: "pdf2zh-error" }, healthError) : e("span", { className: "pdf2zh-mut" }, "连接中…")));
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
		function mountPanel(controller, openSession) {
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
				root.render(e(PanelView, {
					controller,
					openSession
				}));
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
				if (ev.key === "Escape" && controller.getSnapshot()) controller.hide();
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
		function PanelView({ controller, openSession }) {
			return (0, react.useSyncExternalStore)(controller.subscribe, controller.getSnapshot) ? e(Panel, {
				hide: controller.hide,
				openSession
			}) : null;
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.pdf2zh-heading { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.pdf2zh-title { font-size: 16px; font-weight: 600; }
.pdf2zh-tab {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pdf2zh-back {
  flex: none;
  padding: 6px 12px;
  font-size: 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.pdf2zh-back:hover { background: var(--dsw-alias-interactive-bg-hover); }

.pdf2zh-scroll { flex: 1; overflow-y: auto; }
.pdf2zh-content { max-width: 720px; margin: 0 auto; padding: 18px 20px 28px; display: flex; flex-direction: column; gap: 14px; }

.pdf2zh-section {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  overflow: hidden;
}
.pdf2zh-section-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 14px;
  background: var(--dsw-alias-bg-layer-2);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.pdf2zh-section-title { font-size: 13px; font-weight: 600; }
.pdf2zh-section-note { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.pdf2zh-section-body { padding: 14px; display: flex; flex-direction: column; gap: 10px; }

.pdf2zh-input:focus { border-color: var(--dsw-alias-state-business-primary); }
.pdf2zh-options { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; }
.pdf2zh-field { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.pdf2zh-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.pdf2zh-actions { display: flex; gap: 10px; }

.pdf2zh-btn {
  padding: 7px 14px;
  font-size: 13px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.pdf2zh-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.pdf2zh-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.pdf2zh-btn-primary {
  background: var(--dsw-alias-state-business-primary);
  border-color: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.pdf2zh-btn-primary:hover:not(:disabled) { opacity: 0.9; background: var(--dsw-alias-state-business-primary); }

.pdf2zh-error {
  padding: 10px 12px;
  font-size: 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
  white-space: pre-wrap;
  word-break: break-all;
}
.pdf2zh-mut { font-size: 12px; color: var(--dsw-alias-label-tertiary); word-break: break-all; }

.pdf2zh-preview summary { font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.pdf2zh-preview pre {
  margin-top: 8px;
  max-height: 320px;
  overflow: auto;
  padding: 10px;
  font-size: 11px;
  line-height: 1.6;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  white-space: pre-wrap;
  word-break: break-word;
}

.pdf2zh-foot {
  flex: none;
  padding: 8px 20px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  border-top: 1px solid var(--dsw-alias-border-l1);
}

/* --- sidebar entry row ------------------------------------------------------- */

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
}
.pdf2zh-entry:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.pdf2zh-entry[data-active] { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); }
.pdf2zh-entryIcon { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; flex: none; }
.pdf2zh-entryIcon svg { width: 18px; height: 18px; }
.pdf2zh-entryLabel { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`;
		const inject = [];
		function safe(fn) {
			try {
				return fn();
			} catch {
				return;
			}
		}
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
				let openSession;
				const sessions = safe(() => ctx?.get?.("sessions"));
				if (sessions?.open !== void 0) openSession = (id) => {
					safe(() => sessions.open?.(id));
				};
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
				const disposePanel = mountPanel(controller, openSession);
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
