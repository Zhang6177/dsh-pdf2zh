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

import React from 'react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const e = React.createElement

/* ------------------------------------------------------------------ *\
 * API
 * ------------------------------------------------------------------ */

const API_PREFIX = '/api/pdf2zh'

async function call<T>(path: string, method: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const resp = await fetch(path, init)
  let data: any = null
  try { data = await resp.json() } catch { /* non-JSON error body */ }
  if (!resp.ok) throw new Error((data && data.error) || `HTTP ${resp.status}`)
  return data as T
}

interface Health {
  ok: boolean
  version: string
  python: string
  pymupdf: { checked: boolean; available: boolean; version: string }
  skill: { dir: string; synced: boolean; files: string[] }
}

interface ExtractResult {
  ok: boolean
  pdfPath: string
  outPath: string
  pages: number
  chars: number
  preview: string
}

interface TranslateResult {
  ok: boolean
  sessionId: string
  cwd: string
  title: string
}

interface Glossary {
  ok: boolean
  terms: number
  text: string
}

const api = {
  health: (): Promise<Health> => call<Health>(`${API_PREFIX}/health`, 'GET'),
  extract: (path: string, pages?: string): Promise<ExtractResult> =>
    call<ExtractResult>(`${API_PREFIX}/extract`, 'POST', { path, ...(pages ? { pages } : {}) }),
  translate: (body: { path: string; pages?: string; bilingual?: boolean; appendix?: boolean }): Promise<TranslateResult> =>
    call<TranslateResult>(`${API_PREFIX}/translate`, 'POST', body),
  glossary: (): Promise<Glossary> => call<Glossary>(`${API_PREFIX}/glossary`, 'GET'),
}

/* ------------------------------------------------------------------ *\
 * Controller (panel open state)
 * ------------------------------------------------------------------ */

class PanelController {
  private open = false
  private listeners = new Set<() => void>()
  getSnapshot = (): boolean => this.open
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  setOpen = (value: boolean): void => {
    if (value === this.open) return
    this.open = value
    for (const listener of this.listeners) listener()
  }
  show = (): void => { this.setOpen(true) }
  hide = (): void => { this.setOpen(false) }
  toggle = (): void => { this.setOpen(!this.open) }
}

/* ------------------------------------------------------------------ *\
 * Panel UI
 * ------------------------------------------------------------------ */

const INPUT_STYLE = {
  boxSizing: 'border-box',
  width: '100%',
  padding: '8px 10px',
  fontSize: 13,
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-primary)',
  outline: 'none',
} as const

function Section({ title, note, children }: any): any {
  return e('div', { className: 'pdf2zh-section' },
    e('div', { className: 'pdf2zh-section-head' },
      e('span', { className: 'pdf2zh-section-title' }, title),
      note ? e('span', { className: 'pdf2zh-section-note' }, note) : null,
    ),
    e('div', { className: 'pdf2zh-section-body' }, children),
  )
}

function Panel({ hide, openSession }: { hide: () => void; openSession?: (id: string) => void }): any {
  const [health, setHealth] = useState<Health | null>(null)
  const [healthError, setHealthError] = useState('')
  const [path, setPath] = useState('')
  const [pages, setPages] = useState('')
  const [bilingual, setBilingual] = useState(false)
  const [appendix, setAppendix] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [extract, setExtract] = useState<ExtractResult | null>(null)
  const [session, setSession] = useState<TranslateResult | null>(null)
  const [error, setError] = useState('')
  const [glossary, setGlossary] = useState<Glossary | null>(null)
  const healthTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refreshHealth = useCallback(() => {
    api.health().then(setHealth).catch((err: any) => setHealthError(err?.message ?? String(err)))
  }, [])

  useEffect(() => {
    refreshHealth()
    healthTimer.current = setInterval(refreshHealth, 30_000)
    const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') hide() }
    window.addEventListener('keydown', onKey)
    return () => {
      if (healthTimer.current !== null) clearInterval(healthTimer.current)
      window.removeEventListener('keydown', onKey)
    }
  }, [hide, refreshHealth])

  const onExtract = useCallback(async (): Promise<void> => {
    setError('')
    setExtract(null)
    setExtracting(true)
    try {
      const result = await api.extract(path.trim(), pages.trim() || undefined)
      setExtract(result)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setExtracting(false)
    }
  }, [path, pages])

  const onTranslate = useCallback(async (): Promise<void> => {
    setError('')
    setSession(null)
    setTranslating(true)
    try {
      const result = await api.translate({
        path: path.trim(),
        pages: pages.trim() || undefined,
        bilingual,
        appendix,
      })
      setSession(result)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setTranslating(false)
    }
  }, [path, pages, bilingual, appendix])

  const refreshGlossary = useCallback(() => {
    api.glossary().then(setGlossary).catch(() => setGlossary(null))
  }, [])
  useEffect(() => { refreshGlossary() }, [refreshGlossary])

  const pathValid = path.trim().length > 0
  const busy = extracting || translating

  return e('div', { className: 'pdf2zh-shell', role: 'region', 'aria-label': 'PDF 英转中' },
    e('header', { className: 'pdf2zh-top' },
      e('div', { className: 'pdf2zh-heading' },
        e('div', { className: 'pdf2zh-title' }, 'PDF 英转中'),
        e('span', { className: 'pdf2zh-tab' }, 'pdf2zh · 轻量化学术论文 PDF 英转中'),
      ),
      e('button', { type: 'button', className: 'pdf2zh-back', onClick: hide }, '返回会话'),
    ),
    e('main', { className: 'pdf2zh-scroll' },
      e('div', { className: 'pdf2zh-content' },
        Section('翻译论文', '填写服务器上的 PDF 路径',
          e('input', {
            className: 'pdf2zh-input',
            style: INPUT_STYLE,
            value: path,
            placeholder: '/data02/zhangqinhan/papers/attention.pdf',
            onChange: (ev: any) => setPath(ev.target.value),
            spellCheck: false,
          }),
          e('div', { className: 'pdf2zh-options' },
            e('label', { className: 'pdf2zh-field' },
              e('span', null, '页码范围'),
              e('input', {
                style: { ...INPUT_STYLE, width: 110 },
                value: pages,
                placeholder: '1-8',
                onChange: (ev: any) => setPages(ev.target.value),
              }),
            ),
            e('label', { className: 'pdf2zh-check' },
              e('input', { type: 'checkbox', checked: bilingual, onChange: (ev: any) => setBilingual(ev.target.checked) }),
              '中英对照',
            ),
            e('label', { className: 'pdf2zh-check' },
              e('input', { type: 'checkbox', checked: appendix, onChange: (ev: any) => setAppendix(ev.target.checked) }),
              '含附录',
            ),
          ),
          e('div', { className: 'pdf2zh-actions' },
            e('button', {
              type: 'button',
              className: 'pdf2zh-btn',
              disabled: !pathValid || busy,
              onClick: onExtract,
            }, extracting ? '提取中…' : '提取预览'),
            e('button', {
              type: 'button',
              className: 'pdf2zh-btn pdf2zh-btn-primary',
              disabled: !pathValid || busy,
              onClick: onTranslate,
            }, translating ? '创建中…' : '开始翻译（新建会话）'),
          ),
        ),

        error !== '' ? e('div', { className: 'pdf2zh-error' }, error) : null,

        extract !== null
          ? Section(`提取完成 · ${extract.pages} 页 · ${extract.chars} 字符`,
            e('div', { className: 'pdf2zh-mut' }, `文本文件：${extract.outPath}`),
            e('details', { className: 'pdf2zh-preview' },
              e('summary', null, '查看提取预览（前 1200 字符）'),
              e('pre', null, extract.preview),
            ),
          )
          : null,

        session !== null
          ? Section('翻译会话已创建',
            e('div', { className: 'pdf2zh-mut' }, `${session.title} · 工作区 ${session.cwd}`),
            e('div', { className: 'pdf2zh-mut' }, '模型正按 pdf2zh 技能逐节翻译，可在左侧会话列表查看进度。'),
            openSession !== undefined
              ? e('button', {
                type: 'button',
                className: 'pdf2zh-btn',
                onClick: () => { openSession(session.sessionId) },
              }, '查看会话')
              : null,
          )
          : null,

        Section('术语表', '跨论文译名一致',
          glossary === null
            ? e('div', { className: 'pdf2zh-mut' }, '暂不可用')
            : e('div', null,
              e('div', { className: 'pdf2zh-mut' }, `当前 ${glossary.terms} 条`),
              e('details', { className: 'pdf2zh-preview' },
                e('summary', null, '查看全文'),
                e('pre', null, glossary.text || '（空）'),
              ),
            ),
        ),
      ),
    ),
    e('footer', { className: 'pdf2zh-foot' },
      health !== null
        ? e('span', null,
          `v${health.version} · ${health.python}${health.pymupdf.available ? ` · PyMuPDF ${health.pymupdf.version}` : ' · PyMuPDF 缺失（提取不可用）'} · 技能 ${health.skill.synced ? `已同步 → ${health.skill.dir}` : '未同步'}`,
        )
        : healthError !== ''
          ? e('span', { className: 'pdf2zh-error' }, healthError)
          : e('span', { className: 'pdf2zh-mut' }, '连接中…'),
    ),
  )
}

/* ------------------------------------------------------------------ *\
 * Center-column mount (single-occupant protocol)
 * ------------------------------------------------------------------ */

const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
const ACTIVE_ATTR = 'data-dsh-pdf2zh-active'
/** Sibling panels of the single-occupant center column (activation attributes). */
const SIBLING_ATTRS = [
  'data-dsh-taskboard-active',
  'data-dsh-ssh-active',
  'data-dsh-cev2-active',
  'data-dsh-taskboard-local-active',
  'data-dsh-token-usage-board-active',
] as const
/** Cross-plugin activation event details announcing the other center-column panels. */
const SIBLING_DETAILS = ['taskboard', 'ssh', 'cron-explorer-v2', 'token-usage-board'] as const
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'pdf2zh'
/** Sidebar context clicks hand the center column back to the conversation. */
const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'

function mountPanel(controller: PanelController, openSession?: (id: string) => void): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  const ensure = (): void => {
    if (container !== undefined) {
      if (container.isConnected) return
      root?.unmount()
      root = undefined
      container.remove()
      container = undefined
    }
    const column = document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR)
    if (column === null) return
    container = document.createElement('div')
    container.dataset.dshPdf2zhView = ''
    container.dataset.dshPlugin = 'pdf2zh'
    column.appendChild(container)
    root = createRoot(container)
    root.render(e(PanelView, { controller, openSession }))
  }

  // The frame mounts after boot settlement; watch for the column's arrival.
  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  // While we evict siblings, their activation events must not close us back.
  let evicting = false

  const applyActive = (): void => {
    if (controller.getSnapshot()) {
      evicting = true
      try {
        document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'ssh' }))
        document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
      } finally {
        evicting = false
      }
      for (const attr of SIBLING_ATTRS) document.documentElement.removeAttribute(attr)
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
    } else {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
    }
  }

  const onOtherActivate = (event: Event): void => {
    if (evicting) return
    const detail = (event as CustomEvent).detail
    if ((SIBLING_DETAILS as readonly string[]).includes(detail) && controller.getSnapshot()) {
      controller.hide()
    }
  }

  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!controller.getSnapshot()) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) controller.hide()
  }

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape' && controller.getSnapshot()) controller.hide()
  }

  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  document.addEventListener('keydown', onKey)
  const unsubscribe = controller.subscribe(applyActive)
  applyActive()
  ensure()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    document.removeEventListener('keydown', onKey)
    waitObserver.disconnect()
    unsubscribe()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
  }
}

/**
 * React tree for the center-column view container. The Panel mounts only
 * while the panel is open, so each open refetches fresh state.
 */
function PanelView({ controller, openSession }: { controller: PanelController; openSession?: (id: string) => void }): any {
  const open = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  return open ? e(Panel, { hide: controller.hide, openSession }) : null
}

/* ------------------------------------------------------------------ *\
 * Sidebar entry row
 * ------------------------------------------------------------------ */

const SKILL_SELECTOR = '[data-dsh-skill-explorer-entry]'

interface DisposableRow extends HTMLElement {
  __dispose?: () => void
}

function makeRow(onToggle: () => void): DisposableRow {
  const row = document.createElement('div') as DisposableRow
  row.setAttribute('data-dsh-pdf2zh-entry', '')
  row.setAttribute('role', 'button')
  row.setAttribute('tabindex', '0')
  row.className = 'pdf2zh-entry'
  row.innerHTML =
    '<span class="pdf2zh-entryIcon">'
    + '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
    + '<path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>'
    + '</svg></span>'
    + '<span class="pdf2zh-entryLabel">PDF 英转中</span>'
  row.setAttribute('aria-label', 'PDF 英转中')
  row.addEventListener('click', onToggle)
  row.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault()
      onToggle()
    }
  })
  row.__dispose = () => { row.remove() }
  return row
}

function placeRow(row: HTMLElement): boolean {
  if (row.isConnected) return true
  const skill = document.querySelector(SKILL_SELECTOR)
  if (skill !== null && skill.parentNode !== null) {
    skill.parentNode.insertBefore(row, skill.nextSibling)
    return true
  }
  const sidebar = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (sidebar === null) return false
  const anchor = sidebar.querySelector('button[class*="newSession"]')
  if (anchor !== null) (anchor as HTMLElement).insertAdjacentElement('afterend', row)
  else sidebar.insertBefore(row, sidebar.firstChild)
  return true
}

/* ------------------------------------------------------------------ *\
 * Styles
 * ------------------------------------------------------------------ */

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
`

/* ------------------------------------------------------------------ *\
 * Plugin entry
 * ------------------------------------------------------------------ */

export const inject: string[] = []

function safe<T>(fn: () => T): T | undefined {
  try { return fn() } catch { return undefined }
}

function ensureCss(): void {
  if (document.querySelector('style[data-plugin-css="dsh-pdf2zh"]') !== null) return
  const el = document.createElement('style')
  el.setAttribute('data-plugin-css', 'dsh-pdf2zh')
  el.textContent = CSS
  document.head.appendChild(el)
}

export function apply(ctx: any): { dispose: () => void } | void {
  try {
    ensureCss()

    const controller = new PanelController()

    // Optional deep-link: open a translation session in the conversation column.
    let openSession: ((id: string) => void) | undefined
    const sessions = safe(() => ctx?.get?.('sessions')) as { open?: (id: string) => unknown } | undefined
    if (sessions?.open !== undefined) {
      openSession = (id: string) => { safe(() => sessions.open?.(id)) }
    }

    const row = makeRow(() => { controller.toggle() })
    const syncEntry = (): void => { row.toggleAttribute('data-active', controller.getSnapshot()) }
    const unsubscribeEntry = controller.subscribe(syncEntry)
    syncEntry()

    let observer: MutationObserver | null = null
    let retrier: ReturnType<typeof setInterval> | undefined
    let settle: ReturnType<typeof setTimeout> | undefined

    const startObserver = (): void => {
      if (observer !== null || !row.isConnected) return
      const target = row.parentNode ?? document.body
      observer = new MutationObserver(() => {
        if (!row.isConnected) placeRow(row)
      })
      observer.observe(target, { childList: true, subtree: true })
    }

    if (!placeRow(row)) {
      retrier = setInterval(() => {
        if (placeRow(row)) {
          clearInterval(retrier)
          retrier = undefined
          startObserver()
        }
      }, 1000)
      settle = setTimeout(() => {
        if (retrier !== undefined) {
          clearInterval(retrier)
          retrier = undefined
        }
      }, 30_000)
    } else {
      startObserver()
    }

    const disposePanel = mountPanel(controller, openSession)

    const cleanup = (): void => {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
      unsubscribeEntry()
      if (retrier !== undefined) clearInterval(retrier)
      if (settle !== undefined) clearTimeout(settle)
      if (observer !== null) observer.disconnect()
      disposePanel()
      row.__dispose?.()
    }

    if (ctx && typeof ctx.effect === 'function') {
      return ctx.effect(() => cleanup, 'pdf2zh: ui mounts')
    }
    return { dispose: cleanup }
  } catch (error) {
    console.warn('[pdf2zh] client mount failed:', error)
  }
}
