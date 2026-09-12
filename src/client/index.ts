/**
 * Client entry for dsh-pdf2zh.
 *
 * Sidebar entry (plain DOM row, placed below the skill-explorer entry like
 * dsh-cron-explorer) + center-column panel taking over the conversation
 * column with the single-occupant protocol (task-board / cron-explorer /
 * ssh / token-usage-board eviction).
 *
 * Panel: translation board (stat cards + per-file progress bars,
 * auto-refreshed), PDF path input (+ recent paths from localStorage,
 * drag-drop upload), options, extract preview, one-click session
 * translation, glossary editor, health footer.
 *
 * The header "⚙ 设置" button opens a tabbed settings modal: 模型 API (all
 * providers/models from the dsh LLM registry, click to set the translation
 * default, auto = prefer local) and 输出与超时 (save dir + timeout presets).
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

interface Glossary {
  ok: boolean
  terms: number
  text: string
}

type JobStatus = 'running' | 'done' | 'failed'

interface Job {
  id: string
  pdfPath: string
  pdfName: string
  title: string
  sessionId: string
  cwd: string
  outputDir: string
  provider: string
  model: string
  modelNote?: string
  pages: string
  bilingual: boolean
  appendix: boolean
  sourceChars: number
  status: JobStatus
  createdAt: number
  endedAt?: number
  error?: string
  note?: string
  progress: number
  elapsedMs: number
  outputPaths?: string[]
}

interface ModelSelection {
  provider: string
  model: string
}

interface Settings {
  ok: boolean
  outputDir: string
  timeoutMinutes: number
  model: ModelSelection
}

interface TranslateResult {
  ok: boolean
  sessionId: string
  jobId: string
  provider: string
  model: string
  modelNote?: string
}

interface ModelsResult {
  ok: boolean
  canManage?: boolean
  default: (ModelSelection & { reasoningEffort?: string }) | null
  saved: ModelSelection
  auto: ModelSelection | null
  providers: Array<{
    id: string
    name: string
    routable: boolean
    userAdded?: boolean
    base?: string
    protocol?: string
    hasKey?: boolean
    models: Array<{ id: string; name: string; description: string }>
  }>
  failures: Array<{ id: string; name: string; message: string }>
}

interface DiscoveredModel {
  id: string
  name: string
  contextWindow?: number
}

interface AddModelProfileResult {
  ok: boolean
  provider: string
  displayName: string
  api: string
  baseURL: string
  models: string[]
  keyRef: string
  live: boolean
}

interface RemoveModelProfileResult {
  ok: boolean
  provider: string
  keyRemoved: boolean
}

interface JobsResult {
  ok: boolean
  jobs: Job[]
  summary: { running: number; done: number; failed: number }
}

const api = {
  health: (): Promise<Health> => call<Health>(`${API_PREFIX}/health`, 'GET'),
  extract: (path: string, pages?: string): Promise<ExtractResult> =>
    call<ExtractResult>(`${API_PREFIX}/extract`, 'POST', { path, ...(pages ? { pages } : {}) }),
  translate: (body: {
    path: string
    pages?: string
    bilingual?: boolean
    appendix?: boolean
    sourceChars?: number
  }): Promise<TranslateResult> =>
    call<TranslateResult>(`${API_PREFIX}/translate`, 'POST', body),
  glossary: (): Promise<Glossary> => call<Glossary>(`${API_PREFIX}/glossary`, 'GET'),
  glossarySave: (text: string): Promise<{ ok: boolean; path: string; terms: number }> =>
    call<{ ok: boolean; path: string; terms: number }>(`${API_PREFIX}/glossary`, 'POST', { text }),
  settings: (): Promise<Settings> => call<Settings>(`${API_PREFIX}/settings`, 'GET'),
  settingsSave: (body: {
    outputDir?: string
    timeoutMinutes?: number
    model?: ModelSelection
  }): Promise<Settings> => call<Settings>(`${API_PREFIX}/settings`, 'POST', body),
  models: (): Promise<ModelsResult> => call<ModelsResult>(`${API_PREFIX}/models`, 'GET'),
  modelsDiscover: (body: { baseURL: string; api?: string; apiKey?: string }): Promise<{ ok: boolean; models: DiscoveredModel[] }> =>
    call<{ ok: boolean; models: DiscoveredModel[] }>(`${API_PREFIX}/models/discover`, 'POST', body),
  modelsAdd: (body: {
    provider: string
    displayName?: string
    api: string
    baseURL: string
    apiKey?: string
    models: Array<{ id: string; name?: string; contextWindow?: number }>
  }): Promise<AddModelProfileResult> => call<AddModelProfileResult>(`${API_PREFIX}/models/add`, 'POST', body),
  modelsRemove: (body: { provider: string }): Promise<RemoveModelProfileResult> =>
    call<RemoveModelProfileResult>(`${API_PREFIX}/models/remove`, 'POST', body),
  jobs: (): Promise<JobsResult> => call<JobsResult>(`${API_PREFIX}/jobs`, 'GET'),
  jobDelete: (id: string): Promise<{ ok: boolean }> => call<{ ok: boolean }>(`${API_PREFIX}/jobs/delete`, 'POST', { id }),
  jobRetry: (id: string): Promise<TranslateResult & { retriedFrom: string }> =>
    call<TranslateResult & { retriedFrom: string }>(`${API_PREFIX}/jobs/retry`, 'POST', { id }),
  jobsClear: (): Promise<{ ok: boolean; removed: number }> => call<{ ok: boolean; removed: number }>(`${API_PREFIX}/jobs/clear`, 'POST', {}),
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
 * Recent paths (localStorage)
 * ------------------------------------------------------------------ */

const RECENT_KEY = 'dsh-pdf2zh.recentPaths'
const RECENT_DIR_KEY = 'dsh-pdf2zh.recentOutDirs'
const RECENT_MAX = 4
const RECENT_DIR_MAX = 3

function readRecentList(key: string, max: number): string[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string').slice(0, max) : []
  } catch {
    return []
  }
}

function pushRecent(path: string): string[] {
  const next = [path, ...readRecentList(RECENT_KEY, RECENT_MAX).filter((p) => p !== path)].slice(0, RECENT_MAX)
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)) } catch { /* private mode */ }
  return next
}

function pushRecentDir(dir: string): string[] {
  const next = [dir, ...readRecentList(RECENT_DIR_KEY, RECENT_DIR_MAX).filter((p) => p !== dir)].slice(0, RECENT_DIR_MAX)
  try { localStorage.setItem(RECENT_DIR_KEY, JSON.stringify(next)) } catch { /* private mode */ }
  return next
}

/* ------------------------------------------------------------------ *\
 * Formatting helpers (Beijing time per user preference)
 * ------------------------------------------------------------------ */

function fmtBeijing(ts: number): string {
  try {
    return new Date(ts).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return new Date(ts).toLocaleString()
  }
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

const STATUS_LABEL: Record<JobStatus, string> = { running: '进行中', done: '已完成', failed: '已失败' }

/* ------------------------------------------------------------------ *\
 * Icons (16/24 viewBox glyphs, currentColor)
 * ------------------------------------------------------------------ */

function svg(path: string, size = 16): any {
  return e('svg', { viewBox: '0 0 24 24', fill: 'currentColor', width: size, height: size, 'aria-hidden': 'true' },
    e('path', { d: path }))
}

const ICONS = {
  gear: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
  sparkle: 'M12 2.5l1.9 5.3L19 9.7l-5.1 1.9L12 17l-1.9-5.4L5 9.7l5.1-1.9zM19 14l.9 2.4 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9zM5.5 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z',
  plug: 'M16 3v2h-2V3h-4v2H8V3H4v7c0 2.97 2.02 5.45 4.76 6.17L9 21h6l.24-4.83C17.98 15.45 20 12.97 20 10V3h-4zM8 10V5h2v3h4V5h2v5c0 2.21-1.79 4-4 4s-4-1.79-4-4z',
  folder: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
  clock: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
  board: 'M3 3h8v10H3V3zm0 12h8v6H3v-6zM13 3h8v6h-8V3zm0 8h8v10h-8V11z',
  doc: 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
  book: 'M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z',
  check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  warn: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
  info: 'M11 7h2v2h-2V7zm0 4h2v6h-2v-6zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
  upload: 'M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  translate: 'M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z',
}

function GearIcon(): any { return svg(ICONS.gear, 14) }

/* ------------------------------------------------------------------ *\
 * Small building blocks
 * ------------------------------------------------------------------ */

const INPUT_STYLE: React.CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  padding: '9px 12px',
  fontSize: 14,
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-primary)',
  outline: 'none',
}

/** Section card: title (with optional icon) + note + body. `children` may be an array. */
function Section(props: { title: string; note?: string; accent?: 'success'; icon?: keyof typeof ICONS; children: React.ReactNode }): any {
  const { title, note, accent, icon, children } = props
  return e('div', { className: `pdf2zh-section${accent ? ` pdf2zh-section-${accent}` : ''}` },
    e('div', { className: 'pdf2zh-section-head' },
      icon
        ? e('span', { className: 'pdf2zh-section-icon' }, svg(ICONS[icon], 15))
        : null,
      e('span', { className: 'pdf2zh-section-title' }, title),
      note ? e('span', { className: 'pdf2zh-section-note' }, note) : null,
    ),
    e('div', { className: 'pdf2zh-section-body' }, children),
  )
}

/** A glossary term line: ASCII ':' with a CJK-free key side. */
function isGlossaryTerm(line: string): boolean {
  const i = line.indexOf(':')
  if (i <= 0) return false
  return !/[\u4e00-\u9fff`]/.test(line.slice(0, i))
}

function StatChip({ label, value }: { label: string; value: string | number }): any {
  return e('span', { className: 'pdf2zh-chip' },
    e('span', { className: 'pdf2zh-chip-value' }, String(value)),
    e('span', { className: 'pdf2zh-chip-label' }, label),
  )
}

function HealthDot({ ok, label }: { ok: boolean; label: string }): any {
  return e('span', { className: 'pdf2zh-status' },
    e('span', { className: `pdf2zh-dot${ok ? ' pdf2zh-dot-ok' : ' pdf2zh-dot-bad'}` }),
    label,
  )
}

function ProgressBar({ value, status }: { value: number; status: JobStatus | 'overall' }): any {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)))
  return e('div', { className: `pdf2zh-bar${status === 'running' ? ' pdf2zh-bar-anim' : ''}` },
    e('div', { className: `pdf2zh-bar-fill pdf2zh-bar-${status}`, style: { width: `${pct}%` } }),
  )
}

/** Green/red feedback strips with a leading glyph. */
function Strip({ kind, text }: { kind: 'notice' | 'error'; text: string }): any {
  return e('div', { className: `pdf2zh-strip pdf2zh-strip-${kind}` },
    e('span', { className: 'pdf2zh-strip-icon' }, svg(kind === 'notice' ? ICONS.check : ICONS.warn, 15)),
    text,
  )
}

/* ------------------------------------------------------------------ *\
 * Add-API form (manual provider registration into dsh settings)
 * ------------------------------------------------------------------ */

const API_PROTOCOLS = [
  { v: 'openai-completions', label: 'OpenAI 兼容（vLLM / 网关）' },
  { v: 'anthropic-messages', label: 'Anthropic' },
  { v: 'openai-responses', label: 'OpenAI Responses' },
]

function slugify(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 41)
}

function fmtCtx(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return ''
  return n >= 1_048_576 ? `${Math.round((n / 1_048_576) * 10) / 10}M` : `${Math.round(n / 1024)}k`
}

function AddAPIForm({ taken, onAdded, onCancel }: {
  taken: string[]
  onAdded: (r: AddModelProfileResult, wantDefault: boolean) => void
  onCancel: () => void
}): any {
  const [displayName, setDisplayName] = useState('')
  const [providerManual, setProviderManual] = useState('')
  const [proto, setProto] = useState('openai-completions')
  const [baseURL, setBaseURL] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [wantDefault, setWantDefault] = useState(true)
  const [discovered, setDiscovered] = useState<DiscoveredModel[]>([])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [manual, setManual] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [hint, setHint] = useState('')

  const providerId = slugify(providerManual.trim() !== '' ? providerManual : displayName)
  const manualIds = manual.split(/[\n,，]/).map((s) => s.trim()).filter((s) => s !== '')
  const chosen = discovered
    .filter((m) => selected[m.id])
    .map((m) => ({ id: m.id, ...(m.name !== '' && m.name !== m.id ? { name: m.name } : {}), ...(typeof m.contextWindow === 'number' ? { contextWindow: m.contextWindow } : {}) }))
  const manualModels = manualIds.filter((id) => !chosen.some((m) => m.id === id)).map((id) => ({ id }))
  const allModels = [...chosen, ...manualModels]

  const discover = useCallback(async (): Promise<void> => {
    setError('')
    setHint('')
    if (!/^https?:\/\//i.test(baseURL.trim())) { setError('请先填写 http(s) 服务地址'); return }
    setDiscovering(true)
    try {
      const r = await api.modelsDiscover({ baseURL: baseURL.trim(), api: proto, apiKey: apiKey.trim() || undefined })
      setDiscovered(r.models)
      setSelected(Object.fromEntries(r.models.map((m) => [m.id, true])))
      if (r.models.length > 0) setHint(`已连接成功，获取到 ${r.models.length} 个模型 — 勾选要注册的：`)
      else setError('端点未返回模型列表（可在下方手动填写模型 id 继续）')
    } catch (err: any) {
      setError(`连接测试失败：${err?.message ?? String(err)}`)
      setDiscovered([])
      setSelected({})
    } finally {
      setDiscovering(false)
    }
  }, [apiKey, baseURL, proto])

  const submit = useCallback(async (): Promise<void> => {
    setError('')
    if (!/^[a-z][a-z0-9_-]{1,40}$/.test(providerId)) { setError('API 标识需为小写字母开头的 2–41 位字母/数字/-/_（可编辑上方显示名或手动指定）'); return }
    if (taken.includes(providerId)) { setError(`标识 "${providerId}" 已存在，换一个或先删除旧的`); return }
    if (!/^https?:\/\//i.test(baseURL.trim())) { setError('服务地址需为 http(s) URL'); return }
    if (allModels.length === 0) { setError('请先「获取模型」或手动填写至少一个模型 id'); return }
    setBusy(true)
    try {
      const r = await api.modelsAdd({
        provider: providerId,
        displayName: displayName.trim() || providerId,
        api: proto,
        baseURL: baseURL.trim(),
        apiKey: apiKey.trim() || undefined,
        models: allModels,
      })
      onAdded(r, wantDefault)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }, [allModels, apiKey, baseURL, displayName, onAdded, proto, providerId, taken, wantDefault])

  return e('div', { className: 'pdf2zh-addform' },
    e('div', { className: 'pdf2zh-addform-grid' },
      e('div', { className: 'pdf2zh-field-row' },
        e('span', { className: 'pdf2zh-field-label' }, '显示名'),
        e('input', { className: 'pdf2zh-input', style: INPUT_STYLE, value: displayName, placeholder: '例如 DeepSeek 官方 / 本地 vLLM', onChange: (ev: any) => setDisplayName(ev.target.value), spellCheck: false }),
      ),
      e('div', { className: 'pdf2zh-field-row' },
        e('span', { className: 'pdf2zh-field-label' }, 'API 标识', e('span', { className: 'pdf2zh-label-dim' }, '（小写 id）')),
        e('input', { className: 'pdf2zh-input pdf2zh-input-mono', style: INPUT_STYLE, value: providerManual, placeholder: `自动：${slugify(displayName) || 'my-api'}`, onChange: (ev: any) => setProviderManual(ev.target.value), spellCheck: false }),
      ),
    ),
    e('div', { className: 'pdf2zh-field-row' },
      e('span', { className: 'pdf2zh-field-label' }, '协议'),
      e('div', { className: 'pdf2zh-preset-row' },
        API_PROTOCOLS.map((p) => e('button', {
          key: p.v,
          type: 'button',
          className: `pdf2zh-preset${proto === p.v ? ' pdf2zh-preset-on' : ''}`,
          onClick: () => setProto(p.v),
        }, p.label)),
      ),
    ),
    e('div', { className: 'pdf2zh-field-row' },
      e('span', { className: 'pdf2zh-field-label' }, e('span', { className: 'pdf2zh-field-icon' }, svg(ICONS.plug, 14)), '服务地址'),
      e('input', { className: 'pdf2zh-input pdf2zh-input-mono', style: INPUT_STYLE, value: baseURL, placeholder: 'http://127.0.0.1:8000/v1 或 https://api.deepseek.com/v1', onChange: (ev: any) => setBaseURL(ev.target.value), spellCheck: false }),
    ),
    e('div', { className: 'pdf2zh-field-row' },
      e('span', { className: 'pdf2zh-field-label' }, 'API Key', e('span', { className: 'pdf2zh-label-dim' }, '（无鉴权端点可留空）')),
      e('div', { className: 'pdf2zh-key-wrap' },
        e('input', {
          className: 'pdf2zh-input pdf2zh-input-mono',
          style: INPUT_STYLE,
          type: showKey ? 'text' : 'password',
          value: apiKey,
          placeholder: 'sk-…',
          onChange: (ev: any) => setApiKey(ev.target.value),
          autoComplete: 'new-password',
          spellCheck: false,
        }),
        e('button', { type: 'button', className: 'pdf2zh-btn pdf2zh-btn-mini', onClick: () => setShowKey((v) => !v) }, showKey ? '隐藏' : '显示'),
      ),
      e('div', { className: 'pdf2zh-field-hint' }, '密钥存入 dsh 凭据库（~/.dsh/.credentials.yaml，与「设置 → 模型」同一位置），界面不回显明文。'),
    ),
    e('div', { className: 'pdf2zh-field-row' },
      e('div', { className: 'pdf2zh-model-tools' },
        e('span', { className: 'pdf2zh-field-label' }, e('span', { className: 'pdf2zh-field-icon' }, svg(ICONS.doc, 14)), '模型'),
        e('span', { style: { flex: 1 } }),
        e('button', {
          type: 'button',
          className: 'pdf2zh-btn pdf2zh-btn-mini',
          disabled: discovering,
          onClick: () => { void discover() },
        }, discovering ? '探测中…' : (discovered.length > 0 ? '重新获取' : '获取模型（兼测试连接）')),
      ),
      hint !== '' ? e('div', { className: 'pdf2zh-mut' }, hint) : null,
      discovered.length > 0
        ? e('div', { className: 'pdf2zh-model-picks' },
            discovered.map((m) => e('button', {
              key: m.id,
              type: 'button',
              className: `pdf2zh-pick${selected[m.id] ? ' pdf2zh-pick-on' : ''}`,
              title: m.id,
              onClick: () => setSelected((s) => ({ ...s, [m.id]: !s[m.id] })),
            }, m.id, typeof m.contextWindow === 'number' ? e('span', { className: 'pdf2zh-pick-ctx' }, fmtCtx(m.contextWindow)) : null)),
          )
        : null,
      e('textarea', {
        className: 'pdf2zh-add-manual',
        value: manual,
        placeholder: '手动补充模型 id（每行一个，选填）',
        spellCheck: false,
        onChange: (ev: any) => setManual(ev.target.value),
      }),
      allModels.length > 0
        ? e('div', { className: 'pdf2zh-field-hint' }, `将注册 ${allModels.length} 个模型：${allModels.slice(0, 6).map((m) => m.id).join('、')}${allModels.length > 6 ? ' …' : ''}`)
        : null,
    ),
    error !== '' ? e(Strip, { kind: 'error', text: error }) : null,
    e('div', { className: 'pdf2zh-add-actions' },
      e('label', { className: 'pdf2zh-check' },
        e('input', { type: 'checkbox', checked: wantDefault, onChange: (ev: any) => setWantDefault(ev.target.checked) }),
        '添加后设为默认',
      ),
      e('span', { style: { flex: 1 } }),
      e('button', { type: 'button', className: 'pdf2zh-btn', onClick: onCancel }, '取消'),
      e('button', {
        type: 'button',
        className: 'pdf2zh-btn pdf2zh-btn-primary',
        disabled: busy || discovering,
        onClick: () => { void submit() },
      }, busy ? '注册中…' : '保存并注册'),
    ),
  )
}

/* ------------------------------------------------------------------ *\
 * Settings modal — tabbed (模型 API / 输出与超时)
 * ------------------------------------------------------------------ */

const TIMEOUT_PRESETS = [
  { v: 30, label: '30 分' },
  { v: 60, label: '1 小时' },
  { v: 120, label: '2 小时' },
  { v: 240, label: '4 小时' },
  { v: 720, label: '12 小时' },
]

function SettingsModal({ settings, onClose, onSaved }: {
  settings: Settings | null
  onClose: () => void
  onSaved: (s: Settings) => void
}): any {
  const [tab, setTab] = useState<'api' | 'output'>('api')
  const [models, setModels] = useState<ModelsResult | null>(null)
  const [modelsError, setModelsError] = useState('')
  const [savingModel, setSavingModel] = useState('')
  const [outputDir, setOutputDir] = useState(settings?.outputDir ?? '')
  const [timeoutMinutes, setTimeoutMinutes] = useState(String(settings?.timeoutMinutes ?? 240))
  const [recentDirs, setRecentDirs] = useState<string[]>(() => readRecentList(RECENT_DIR_KEY, RECENT_DIR_MAX))
  const [savingForm, setSavingForm] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [deleting, setDeleting] = useState('')

  useEffect(() => {
    if (settings !== null) {
      setOutputDir(settings.outputDir)
      setTimeoutMinutes(String(settings.timeoutMinutes))
    }
  }, [settings])

  const reloadModels = useCallback((): void => {
    api.models().then((r) => { setModels(r); setModelsError('') }).catch((err: any) => setModelsError(err?.message ?? String(err)))
  }, [])

  useEffect(() => {
    reloadModels()
  }, [reloadModels])

  const saved = settings?.model ?? { provider: '', model: '' }

  const saveModel = useCallback(async (sel: ModelSelection): Promise<void> => {
    setError('')
    setNotice('')
    setSavingModel(`${sel.provider}/${sel.model}`)
    try {
      const next = await api.settingsSave({ model: sel })
      onSaved(next)
      setNotice(sel.provider === ''
        ? '已切回自动选择（优先本地部署 API）'
        : `默认翻译 API 已设为 ${sel.provider} / ${sel.model}`)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setSavingModel('')
    }
  }, [onSaved])

  const saveForm = useCallback(async (): Promise<void> => {
    setError('')
    setNotice('')
    setSavingForm(true)
    try {
      const next = await api.settingsSave({
        outputDir: outputDir.trim(),
        timeoutMinutes: Number(timeoutMinutes) || undefined,
      })
      onSaved(next)
      if (next.outputDir !== '') setRecentDirs(pushRecentDir(next.outputDir))
      setNotice(next.outputDir
        ? `已保存：译文保存到 ${next.outputDir}（超时 ${next.timeoutMinutes} 分钟）`
        : `已保存：译文保存在源 PDF 同目录（超时 ${next.timeoutMinutes} 分钟）`)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setSavingForm(false)
    }
  }, [outputDir, timeoutMinutes, onSaved])

  /** Form success: refresh catalog, optionally set the new provider as default. */
  const onProviderAdded = useCallback(async (r: AddModelProfileResult, wantDefault: boolean): Promise<void> => {
    setAddOpen(false)
    reloadModels()
    if (wantDefault && r.models.length > 0) {
      await saveModel({ provider: r.provider, model: r.models[0] })
      setNotice(`已添加 ${r.provider}（${r.models.length} 个模型${r.live ? '，已热生效' : ''}）`)
      return
    }
    setNotice(`已添加 ${r.provider} — ${r.models.length} 个模型${r.live ? '（已热生效）' : '（列表未即时出现时重启 dsh 后生效）'}`)
  }, [reloadModels, saveModel])

  /** Remove a user-added provider; if it was the default, fall back to auto. */
  const onProviderRemove = useCallback(async (provider: string): Promise<void> => {
    setDeleting('')
    setError('')
    try {
      const r = await api.modelsRemove({ provider })
      reloadModels()
      if (saved.provider === provider) {
        const next = await api.settingsSave({ model: { provider: '', model: '' } }).catch(() => null)
        if (next !== null) onSaved(next)
      }
      setNotice(`已删除 ${provider}${r.keyRemoved ? '（含其 API Key）' : ''}`)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    }
  }, [onSaved, reloadModels, saved.provider])

  const apiRow = (opts: {
    key: string
    active: boolean
    busy: boolean
    title?: string
    onClick: () => void
    name: React.ReactNode
    sub: React.ReactNode
    icon: React.ReactNode
    tags?: React.ReactNode
  }): any => e('button', {
    key: opts.key,
    type: 'button',
    className: `pdf2zh-api-row${opts.active ? ' pdf2zh-api-row-active' : ''}${opts.busy ? ' pdf2zh-api-row-busy' : ''}`,
    disabled: opts.busy,
    title: opts.title,
    onClick: opts.onClick,
  },
    opts.icon,
    e('span', { className: 'pdf2zh-api-text' },
      e('span', { className: 'pdf2zh-api-name' }, opts.name),
      e('span', { className: 'pdf2zh-api-sub' }, opts.sub),
    ),
    opts.tags ?? null,
    e('span', { className: `pdf2zh-api-check${opts.active ? ' pdf2zh-api-check-on' : ''}` },
      opts.active ? svg(ICONS.check, 12) : null,
    ),
  )

  const modelRow = (providerId: string, providerName: string, m: { id: string; name: string; description: string }, isAutoLocal: boolean): any => {
    const key = `${providerId}/${m.id}`
    const active = saved.provider === providerId && saved.model === m.id
    return apiRow({
      key,
      active,
      busy: savingModel !== '',
      title: m.description || m.id,
      onClick: () => { void saveModel({ provider: providerId, model: m.id }) },
      name: m.name !== m.id ? `${m.name} · ${m.id}` : m.id,
      sub: providerName !== providerId ? `${providerName} (${providerId})` : providerId,
      icon: e('span', { className: 'pdf2zh-api-avatar pdf2zh-api-avatar-plain' }, providerName.charAt(0).toUpperCase()),
      tags: e('span', { className: 'pdf2zh-api-tags' },
        isAutoLocal ? e('span', { className: 'pdf2zh-api-tag pdf2zh-api-tag-local' }, '本地') : null,
        savingModel === key ? e('span', { className: 'pdf2zh-api-tag' }, '保存中…') : null,
      ),
    })
  }

  return e('div', { className: 'pdf2zh-modal-mask', onClick: (ev: any) => { if (ev.target === ev.currentTarget) onClose() } },
    e('div', { className: 'pdf2zh-modal', role: 'dialog', 'aria-label': 'pdf2zh 设置' },
      e('div', { className: 'pdf2zh-modal-head' },
        e('span', { className: 'pdf2zh-modal-icon' }, svg(ICONS.gear, 17)),
        e('div', { className: 'pdf2zh-modal-titlewrap' },
          e('div', { className: 'pdf2zh-modal-title' }, '设置'),
          e('div', { className: 'pdf2zh-modal-sub' }, 'pdf2zh · 翻译模型 API 与输出'),
        ),
        e('button', { type: 'button', className: 'pdf2zh-modal-x', onClick: onClose, title: '关闭（Esc）' }, '×'),
      ),

      e('div', { className: 'pdf2zh-tabs' },
        e('button', { type: 'button', className: `pdf2zh-tab-btn${tab === 'api' ? ' pdf2zh-tab-on' : ''}`, onClick: () => setTab('api') },
          svg(ICONS.plug, 14), '模型 API'),
        e('button', { type: 'button', className: `pdf2zh-tab-btn${tab === 'output' ? ' pdf2zh-tab-on' : ''}`, onClick: () => setTab('output') },
          svg(ICONS.folder, 14), '输出与超时'),
      ),

      e('div', { className: 'pdf2zh-modal-body' },
        tab === 'api'
          ? e(React.Fragment, null,
              e('div', { className: 'pdf2zh-modal-desc' },
                svg(ICONS.info, 14),
                e('span', null, '与 dsh 共用同一份 API 注册表，点选即设为翻译默认；也可点下方按钮手动添加新的 API（URL / Key / 模型），写入 dsh 模型配置后全局可用。'),
              ),
              models !== null && models.canManage !== false && !addOpen
                ? e('button', { type: 'button', className: 'pdf2zh-addbtn', onClick: () => setAddOpen(true) },
                    svg(ICONS.plus, 13), '手动添加 API（填写服务地址 / Key / 模型）')
                : null,
              addOpen
                ? e(AddAPIForm, {
                    taken: (models?.providers ?? []).map((p) => p.id),
                    onAdded: (r: AddModelProfileResult, wantDefault: boolean) => { void onProviderAdded(r, wantDefault) },
                    onCancel: () => setAddOpen(false),
                  })
                : null,
              apiRow({
                key: 'auto',
                active: saved.provider === '',
                busy: savingModel !== '',
                onClick: () => { void saveModel({ provider: '', model: '' }) },
                name: '自动选择（推荐 · 优先本地部署 API）',
                sub: models?.auto
                  ? `当前解析为 ${models.auto.provider} / ${models.auto.model}`
                  : '每次开始翻译时按模型目录实时解析',
                icon: e('span', { className: 'pdf2zh-auto-icon' }, svg(ICONS.sparkle, 15)),
                tags: saved.provider === '' ? e('span', { className: 'pdf2zh-api-tags' }, e('span', { className: 'pdf2zh-api-tag pdf2zh-api-tag-active' }, '默认')) : null,
              }),
              models === null && modelsError === ''
                ? e('div', { className: 'pdf2zh-mut' }, '正在读取模型目录…')
                : null,
              modelsError !== '' ? e(Strip, { kind: 'error', text: modelsError }) : null,
              models !== null
                ? e('div', { className: 'pdf2zh-api-groups' },
                    models.providers.map((g) => e('div', { key: g.id, className: `pdf2zh-api-card${g.routable ? '' : ' pdf2zh-api-card-off'}` },
                      e('div', { className: 'pdf2zh-api-card-head', title: g.base || undefined },
                        e('span', { className: 'pdf2zh-api-avatar' }, (g.name || g.id).charAt(0).toUpperCase()),
                        e('span', { className: 'pdf2zh-api-card-name' },
                          e('span', null, g.name !== g.id ? g.name : g.id),
                          g.name !== g.id ? e('code', { className: 'pdf2zh-api-card-id' }, g.id) : null,
                        ),
                        e('span', { className: 'pdf2zh-api-card-tags' },
                          g.userAdded === true ? e('span', { className: 'pdf2zh-api-tag pdf2zh-api-tag-self' }, '自添加') : null,
                          g.routable
                            ? e('span', { className: 'pdf2zh-api-tag pdf2zh-api-tag-ok' }, '可用')
                            : e('span', { className: 'pdf2zh-api-tag pdf2zh-api-tag-warn' }, '暂不可路由'),
                          g.userAdded === true && models.canManage !== false
                            ? deleting === g.id
                              ? e(React.Fragment, null,
                                  e('button', { type: 'button', className: 'pdf2zh-del-btn pdf2zh-del-btn-confirm', onClick: () => { void onProviderRemove(g.id) } }, '确认删除'),
                                  e('button', { type: 'button', className: 'pdf2zh-del-btn', onClick: () => setDeleting('') }, '取消'))
                              : e('button', {
                                type: 'button',
                                className: 'pdf2zh-del-btn',
                                title: '从 dsh 模型配置（settings.yaml）中移除此条目',
                                onClick: () => setDeleting(g.id),
                              }, '删除')
                            : null,
                        ),
                      ),
                      e('div', { className: 'pdf2zh-api-card-body' },
                        g.models.map((m) => modelRow(g.id, g.name, m, models.auto?.provider === g.id && models.auto?.model === m.id)),
                      ),
                    )),
                    (models.failures ?? []).length > 0
                      ? e('div', { className: 'pdf2zh-modal-warnline' },
                          svg(ICONS.warn, 13), `部分 provider 读取失败：${models.failures.map((f) => f.id).join('、')}`)
                      : null,
                  )
                : null,
            )
          : e(React.Fragment, null,
              e('div', { className: 'pdf2zh-modal-desc' },
                svg(ICONS.info, 14),
                e('span', null, '译文（.zh.md / 中英对照 .en-zh.md）的统一落盘位置与任务超时；对之后新发起的翻译生效。'),
              ),
              e('div', { className: 'pdf2zh-field-card' },
                e('div', { className: 'pdf2zh-field-label' }, e('span', { className: 'pdf2zh-field-icon' }, svg(ICONS.folder, 14)), '保存路径'),
                e('input', {
                  className: 'pdf2zh-input pdf2zh-input-mono',
                  style: INPUT_STYLE,
                  value: outputDir,
                  placeholder: '留空 = 保存在源 PDF 同目录；例如 /data02/zhangqinhan/papers/translated',
                  onChange: (ev: any) => setOutputDir(ev.target.value),
                  spellCheck: false,
                }),
                recentDirs.length > 0
                  ? e('div', { className: 'pdf2zh-recent' },
                      e('span', { className: 'pdf2zh-recent-label' }, '常用'),
                      recentDirs.map((d) => e('button', {
                        key: d,
                        type: 'button',
                        className: 'pdf2zh-recent-chip',
                        title: d,
                        onClick: () => setOutputDir(d),
                      }, d.split('/').pop())),
                    )
                  : null,
                e('div', { className: 'pdf2zh-field-hint' }, '需为服务器上的绝对路径（保存时自动创建）。若模型把译文写到源 PDF 旁，任务完成时插件会兜底复制到这里。'),
              ),
              e('div', { className: 'pdf2zh-field-card' },
                e('div', { className: 'pdf2zh-field-label' }, e('span', { className: 'pdf2zh-field-icon' }, svg(ICONS.clock, 14)), '任务超时'),
                e('div', { className: 'pdf2zh-preset-row' },
                  TIMEOUT_PRESETS.map((p) => e('button', {
                    key: p.v,
                    type: 'button',
                    className: `pdf2zh-preset${String(p.v) === timeoutMinutes ? ' pdf2zh-preset-on' : ''}`,
                    onClick: () => setTimeoutMinutes(String(p.v)),
                  }, p.label)),
                  e('span', { className: 'pdf2zh-preset-custom' },
                    e('input', {
                      className: 'pdf2zh-input pdf2zh-preset-input',
                      style: { ...INPUT_STYLE, padding: '6px 10px', fontSize: 13 },
                      value: timeoutMinutes,
                      type: 'number',
                      min: 10,
                      max: 1440,
                      onChange: (ev: any) => setTimeoutMinutes(ev.target.value),
                    }),
                    e('span', { className: 'pdf2zh-preset-unit' }, '分钟'),
                  ),
                ),
                e('div', { className: 'pdf2zh-field-hint' }, '10–1440 分钟。超时后插件会终止翻译会话并把任务记为失败。'),
              ),
            ),
        error !== '' ? e(Strip, { kind: 'error', text: error }) : null,
        notice !== '' ? e(Strip, { kind: 'notice', text: notice }) : null,
      ),

      e('div', { className: 'pdf2zh-modal-foot' },
        e('span', { className: 'pdf2zh-foot-hint' },
          tab === 'api' ? '点选后立即保存为默认，无需其它操作' : '修改后点右侧保存',
        ),
        tab === 'output' ? e('button', {
          type: 'button',
          className: 'pdf2zh-btn pdf2zh-btn-primary',
          disabled: savingForm,
          onClick: saveForm,
        }, savingForm ? '保存中…' : '保存') : null,
        e('button', { type: 'button', className: 'pdf2zh-btn', onClick: onClose }, '完成'),
      ),
    ),
  )
}

/* ------------------------------------------------------------------ *\
 * Translation board
 * ------------------------------------------------------------------ */

function JobRow({ job, onDelete, onRetry }: { job: Job; onDelete: (id: string) => void; onRetry: (id: string) => void }): any {
  const pct = Math.round(job.progress * 100)
  const connDown = job.status === 'failed' && /TRANSPORT|Connection|不可达|连接/i.test(job.error ?? '')
  return e('div', { className: `pdf2zh-job pdf2zh-job-${job.status}`, key: job.id },
    e('div', { className: 'pdf2zh-job-head' },
      e('span', { className: `pdf2zh-job-statusdot pdf2zh-job-statusdot-${job.status}` }),
      e('span', { className: 'pdf2zh-job-name', title: job.pdfPath }, job.pdfName),
      e('span', { className: `pdf2zh-badge pdf2zh-badge-${job.status}` }, STATUS_LABEL[job.status]),
      job.status === 'failed' ? e('button', {
        type: 'button',
        className: 'pdf2zh-retry-btn',
        title: '按原参数重新发起翻译（新建会话，替换本条记录）',
        onClick: () => { onRetry(job.id) },
      }, '重试') : null,
      e('span', { className: 'pdf2zh-job-time', title: `创建：${fmtBeijing(job.createdAt)}` },
        job.status === 'running'
          ? `已用时 ${fmtElapsed(job.elapsedMs)}`
          : fmtBeijing(job.endedAt ?? job.createdAt),
      ),
      e('button', {
        type: 'button',
        className: 'pdf2zh-job-del',
        title: job.status === 'running' ? '从看板移除（不会终止翻译会话）' : '从看板移除',
        onClick: () => { onDelete(job.id) },
      }, '×'),
    ),
    e('div', { className: 'pdf2zh-job-bar' },
      e(ProgressBar, { value: job.progress, status: job.status }),
      e('span', { className: `pdf2zh-job-pct pdf2zh-job-pct-${job.status}` }, `${pct}%`),
    ),
    (job.provider !== '' || job.modelNote !== undefined)
      ? e('div', { className: 'pdf2zh-job-meta' },
          job.provider !== '' ? e('span', { className: 'pdf2zh-job-api' }, svg(ICONS.plug, 11), ` ${job.provider}/${job.model}`) : null,
          job.modelNote ? e('span', { className: 'pdf2zh-job-warn' }, job.modelNote) : null,
        )
      : null,
    job.status === 'done' && (job.outputPaths?.length ?? 0) > 0
      ? e('div', { className: 'pdf2zh-job-meta' },
          job.outputPaths!.map((p) => e('span', { key: p, className: 'pdf2zh-job-out' }, `→ ${p}`)),
        )
      : null,
    job.status === 'done' && (job.outputPaths?.length ?? 0) === 0
      ? e('div', { className: 'pdf2zh-job-meta' }, job.note ?? '翻译已完成，输出文件见会话汇报。')
      : null,
    job.note && job.status !== 'done'
      ? e('div', { className: 'pdf2zh-job-meta' }, e('span', { className: 'pdf2zh-job-warn' }, job.note))
      : null,
    job.status === 'failed' && job.error
      ? e('div', { className: 'pdf2zh-job-meta' },
          e('span', { className: 'pdf2zh-job-error' }, job.error),
          connDown ? e('span', { className: 'pdf2zh-job-hintline' }, '模型服务不在线：先在服务器启动对应服务（vLLM 等），或在「⚙ 设置 → 模型 API」换用其它可用 API，然后点「重试」。') : null,
        )
      : null,
  )
}

function StatCard({ status, value, label }: { status: 'running' | 'done' | 'failed'; value: number; label: string }): any {
  return e('div', { className: `pdf2zh-statcard pdf2zh-statcard-${status}` },
    e('div', { className: 'pdf2zh-statcard-value' }, String(value)),
    e('div', { className: 'pdf2zh-statcard-label' }, label),
  )
}

function Board({ jobs, summary, onDelete, onClear, onRetry }: {
  jobs: Job[]
  summary: JobsResult['summary']
  onDelete: (id: string) => void
  onClear: () => void
  onRetry: (id: string) => void
}): any {
  const total = jobs.length
  const overall = total > 0 ? jobs.reduce((acc, j) => acc + j.progress, 0) / total : 0
  const overallStatus: JobStatus | 'overall' = summary.failed > 0 && summary.running === 0 && summary.done === 0
    ? 'failed'
    : summary.running === 0 && summary.done > 0 && summary.failed === 0 ? 'done' : 'overall'
  return Section({
    title: '翻译看板',
    note: '每 5 秒自动刷新',
    icon: 'board',
    children: [
      e('div', { className: 'pdf2zh-statcards' },
        e(StatCard, { status: 'running', value: summary.running, label: '进行中' }),
        e(StatCard, { status: 'done', value: summary.done, label: '已完成' }),
        e(StatCard, { status: 'failed', value: summary.failed, label: '已失败' }),
      ),
      total > 0
        ? e('div', { className: 'pdf2zh-overall' },
            e('span', { className: 'pdf2zh-overall-label' }, '总体进度'),
            e(ProgressBar, { value: overall, status: overallStatus }),
            e('span', { className: 'pdf2zh-overall-pct' }, `${Math.round(overall * 100)}%`),
          )
        : null,
      total > 0 && summary.done + summary.failed > 0
        ? e('div', { className: 'pdf2zh-board-tools' },
            e('button', { type: 'button', className: 'pdf2zh-btn pdf2zh-btn-mini', onClick: onClear }, '清空已完成'),
          )
        : null,
      total === 0
        ? e('div', { className: 'pdf2zh-empty' },
            e('span', { className: 'pdf2zh-empty-icon' }, svg(ICONS.board, 22)),
            e('span', null, '暂无翻译任务 — 填好路径点「开始翻译」后，进度会在这里实时更新'),
          )
        : e('div', { className: 'pdf2zh-jobs' }, jobs.map((job) => e(JobRow, { key: job.id, job, onDelete, onRetry }))),
    ],
  })
}

/* ------------------------------------------------------------------ *\
 * Panel UI
 * ------------------------------------------------------------------ */

const GUIDE_STEPS = ['填 PDF 路径', '提取预览', '开始翻译', '看板看进度']

function Panel({ hide }: { hide: () => void }): any {
  const [health, setHealth] = useState<Health | null>(null)
  const [healthError, setHealthError] = useState('')
  const [path, setPath] = useState('')
  const [pages, setPages] = useState('')
  const [bilingual, setBilingual] = useState(false)
  const [appendix, setAppendix] = useState(false)
  const [recent, setRecent] = useState<string[]>(() => readRecentList(RECENT_KEY, RECENT_MAX))
  const [extracting, setExtracting] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [extract, setExtract] = useState<ExtractResult | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [glossary, setGlossary] = useState<Glossary | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadName, setUploadName] = useState('')
  const [editingGlossary, setEditingGlossary] = useState(false)
  const [glossaryDraft, setGlossaryDraft] = useState('')
  const [savingGlossary, setSavingGlossary] = useState(false)
  const [jobs, setJobs] = useState<Job[]>([])
  const [summary, setSummary] = useState<JobsResult['summary']>({ running: 0, done: 0, failed: 0 })
  const [settings, setSettings] = useState<Settings | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const modalRef = useRef(false)
  modalRef.current = modalOpen
  const fileRef = useRef<HTMLInputElement | null>(null)
  const healthTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const jobsTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refreshHealth = useCallback(() => {
    api.health().then(setHealth).catch((err: any) => setHealthError(err?.message ?? String(err)))
  }, [])

  const refreshGlossary = useCallback(() => {
    api.glossary().then(setGlossary).catch(() => setGlossary(null))
  }, [])

  const refreshJobs = useCallback(() => {
    api.jobs().then((r) => { setJobs(r.jobs); setSummary(r.summary) }).catch(() => { /* board will retry */ })
  }, [])

  const refreshSettings = useCallback((): void => {
    api.settings().then(setSettings).catch(() => { /* modal will show raw state */ })
  }, [])

  useEffect(() => {
    refreshHealth()
    refreshGlossary()
    refreshJobs()
    refreshSettings()
    healthTimer.current = setInterval(refreshHealth, 30_000)
    jobsTimer.current = setInterval(refreshJobs, 5_000)
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return
      if (modalRef.current) setModalOpen(false)
      else hide()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      if (healthTimer.current !== null) clearInterval(healthTimer.current)
      if (jobsTimer.current !== null) clearInterval(jobsTimer.current)
      window.removeEventListener('keydown', onKey)
    }
  }, [hide, refreshHealth, refreshGlossary, refreshJobs, refreshSettings])

  const remember = useCallback((p: string): void => { setRecent(pushRecent(p)) }, [])

  const uploadFile = useCallback(async (file: File): Promise<void> => {
    if (!/\.pdf$/i.test(file.name)) { setError('仅支持 .pdf 文件'); return }
    if (file.size > 100 * 1024 * 1024) { setError('PDF 不能超过 100 MB'); return }
    setError('')
    setNotice('')
    setUploading(true)
    setUploadName(file.name)
    try {
      const resp = await fetch(`${API_PREFIX}/upload`, {
        method: 'POST',
        // HTTP headers must be ISO-8859-1; percent-encode CJK filenames (server decodes).
        headers: { 'content-type': 'application/octet-stream', 'x-pdf2zh-filename': encodeURIComponent(file.name) },
        body: file,
      })
      let data: any = null
      try { data = await resp.json() } catch { /* non-JSON */ }
      if (!resp.ok) throw new Error((data && data.error) || `HTTP ${resp.status}`)
      setPath(data.path)
      remember(data.path)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setUploading(false)
      setDragOver(false)
    }
  }, [remember])

  const onSaveGlossary = useCallback(async (): Promise<void> => {
    setSavingGlossary(true)
    setError('')
    try {
      await api.glossarySave(glossaryDraft)
      setEditingGlossary(false)
      refreshGlossary()
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setSavingGlossary(false)
    }
  }, [glossaryDraft, refreshGlossary])

  const onExtract = useCallback(async (): Promise<void> => {
    if (!path.trim()) return
    setError('')
    setNotice('')
    setExtract(null)
    setExtracting(true)
    try {
      const result = await api.extract(path.trim(), pages.trim() || undefined)
      setExtract(result)
      remember(path.trim())
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setExtracting(false)
    }
  }, [path, pages, remember])

  const onTranslate = useCallback(async (): Promise<void> => {
    if (!path.trim()) return
    setError('')
    setNotice('')
    setTranslating(true)
    try {
      const trimmed = path.trim()
      const result = await api.translate({
        path: trimmed,
        pages: pages.trim() || undefined,
        bilingual,
        appendix,
        sourceChars: extract !== null && extract.pdfPath === trimmed ? extract.chars : undefined,
      })
      remember(trimmed)
      const via = result.provider ? `（API ${result.provider}/${result.model}）` : ''
      setNotice(`翻译任务已创建${via}，进度见上方「翻译看板」。`)
      refreshJobs()
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setTranslating(false)
    }
  }, [path, pages, bilingual, appendix, extract, remember, refreshJobs])

  const onJobDelete = useCallback((id: string): void => {
    api.jobDelete(id).then(refreshJobs).catch((err: any) => setError(err?.message ?? String(err)))
  }, [refreshJobs])

  const onJobRetry = useCallback((id: string): void => {
    setError('')
    setNotice('')
    api.jobRetry(id)
      .then((r) => {
        setNotice(`已重试：${r.provider ? `新任务使用 API ${r.provider}/${r.model}，` : ''}进度见看板（旧记录已替换）。`)
        refreshJobs()
      })
      .catch((err: any) => setError(err?.message ?? String(err)))
  }, [refreshJobs])

  const onJobsClear = useCallback((): void => {
    api.jobsClear().then(refreshJobs).catch((err: any) => setError(err?.message ?? String(err)))
  }, [refreshJobs])

  const onPathKeyDown = useCallback((ev: any): void => {
    if (ev.key === 'Enter') {
      ev.preventDefault()
      void onExtract()
    }
  }, [onExtract])

  const pathValid = path.trim().length > 0
  const busy = extracting || translating
  const glossaryLines = glossary ? glossary.text.split('\n').filter(isGlossaryTerm).slice(0, 5) : []
  const modelLabel = settings === null
    ? ''
    : settings.model.provider !== ''
      ? ` · ${settings.model.provider}/${settings.model.model}`
      : ' · API 自动（本地优先）'

  return e('div', { className: 'pdf2zh-shell', role: 'region', 'aria-label': 'PDF 英转中' },
    e('header', { className: 'pdf2zh-top' },
      e('div', { className: 'pdf2zh-top-inner' },
      e('div', { className: 'pdf2zh-heading' },
        e('span', { className: 'pdf2zh-logo' }, svg(ICONS.translate, 19)),
        e('div', { className: 'pdf2zh-heading-text' },
          e('div', { className: 'pdf2zh-title' }, 'PDF 英转中'),
          e('span', { className: 'pdf2zh-tabtitle' }, 'pdf2zh · 轻量化学术论文 PDF 英转中'),
        ),
      ),
      e('div', { className: 'pdf2zh-top-actions' },
        e('button', {
          type: 'button',
          className: `pdf2zh-topbtn${modalOpen ? ' pdf2zh-topbtn-on' : ''}`,
          onClick: () => { setModalOpen(true) },
          title: '打开设置（翻译模型 API / 保存路径 / 超时）',
        }, e('span', { className: 'pdf2zh-gear' }, GearIcon()), '设置'),
        e('button', { type: 'button', className: 'pdf2zh-topbtn', onClick: hide }, '返回会话'),
      ),
      ),
    ),

    e('main', { className: 'pdf2zh-scroll' },
      e('div', { className: 'pdf2zh-content' },
        e('div', { className: 'pdf2zh-guide' },
          GUIDE_STEPS.map((step, i) => e('span', { key: step, className: 'pdf2zh-guide-step' },
            e('span', { className: 'pdf2zh-guide-num' }, String(i + 1)),
            step,
            i < GUIDE_STEPS.length - 1 ? e('span', { className: 'pdf2zh-guide-arrow' }, '→') : null,
          )),
        ),

        e(Board, { jobs, summary, onDelete: onJobDelete, onClear: onJobsClear, onRetry: onJobRetry }),

        Section({ title: '翻译论文', note: '填服务器上的 PDF 绝对路径，或直接拖拽/选择本地 PDF 上传', icon: 'doc', children: [
          e('div', {
            className: `pdf2zh-drop${dragOver ? ' pdf2zh-drop-hot' : ''}`,
            onClick: () => { fileRef.current?.click() },
            onDragOver: (ev: any) => { ev.preventDefault(); setDragOver(true) },
            onDragLeave: () => setDragOver(false),
            onDrop: (ev: any) => {
              ev.preventDefault()
              setDragOver(false)
              const file = ev.dataTransfer?.files?.[0]
              if (file) void uploadFile(file)
            },
          },
            e('input', {
              ref: fileRef,
              type: 'file',
              accept: '.pdf,application/pdf',
              style: { display: 'none' },
              onChange: (ev: any) => {
                const file = ev.target?.files?.[0]
                if (file) void uploadFile(file)
                if (ev.target) ev.target.value = ''
              },
            }),
            e('span', { className: 'pdf2zh-drop-icon' }, svg(ICONS.upload, 19)),
            e('span', null, uploading
              ? `正在上传 ${uploadName}…`
              : '拖拽 PDF 到此处，或点击选择文件上传到服务器'),
          ),
          e('input', {
            className: 'pdf2zh-input pdf2zh-input-mono',
            style: INPUT_STYLE,
            value: path,
            placeholder: '/data02/zhangqinhan/papers/attention.pdf',
            onChange: (ev: any) => setPath(ev.target.value),
            onKeyDown: onPathKeyDown,
            spellCheck: false,
          }),
          recent.length > 0 ? e('div', { className: 'pdf2zh-recent' },
            e('span', { className: 'pdf2zh-recent-label' }, '最近'),
            recent.map((p) => e('button', {
              key: p,
              type: 'button',
              className: 'pdf2zh-recent-chip',
              title: p,
              onClick: () => setPath(p),
            }, p.split('/').pop())),
          ) : null,
          e('div', { className: 'pdf2zh-options' },
            e('label', { className: 'pdf2zh-field' },
              '页码（默认全文）',
              e('input', {
                style: { ...INPUT_STYLE, width: 130 },
                value: pages,
                placeholder: '默认全文',
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
            }, translating ? '创建任务中…' : '开始翻译'),
            !pathValid ? e('span', { className: 'pdf2zh-hint' }, '回车 = 提取预览') : null,
          ),
        ] }),

        notice !== '' ? e(Strip, { kind: 'notice', text: notice }) : null,
        error !== '' ? e(Strip, { kind: 'error', text: error }) : null,

        extract !== null
          ? Section({ title: '提取完成', accent: 'success', icon: 'check', children: [
            e('div', { className: 'pdf2zh-stats' },
              e(StatChip, { label: '页数', value: extract.pages }),
              e(StatChip, { label: '字符', value: extract.chars.toLocaleString() }),
              e('span', { className: 'pdf2zh-outpath', title: extract.outPath }, extract.outPath),
            ),
            e('details', { className: 'pdf2zh-preview' },
              e('summary', null, '抽查提取文本（前 1200 字符）'),
              e('pre', null, extract.preview),
            ),
          ] })
          : null,

        Section({ title: '术语表', note: '跨论文译名一致 · 可编辑', icon: 'book', children: [
          glossary === null
            ? e('div', { className: 'pdf2zh-mut' }, '暂不可用')
            : editingGlossary
              ? e('div', { className: 'pdf2zh-glossary-edit' },
                  e('textarea', {
                    className: 'pdf2zh-glossary-textarea',
                    value: glossaryDraft,
                    spellCheck: false,
                    onChange: (ev: any) => setGlossaryDraft(ev.target.value),
                  }),
                  e('div', { className: 'pdf2zh-mut' }, '格式：每行一条 `英文: 中文`（# 开头为注释）。保存后直接写回技能目录的 glossary.md。'),
                  e('div', { className: 'pdf2zh-actions' },
                    e('button', {
                      type: 'button',
                      className: 'pdf2zh-btn pdf2zh-btn-primary',
                      disabled: savingGlossary,
                      onClick: onSaveGlossary,
                    }, savingGlossary ? '保存中…' : '保存'),
                    e('button', { type: 'button', className: 'pdf2zh-btn', onClick: () => setEditingGlossary(false) }, '取消'),
                  ),
                )
              : e('div', null,
                  glossaryLines.length > 0 ? e('div', { className: 'pdf2zh-glossary-sample' },
                    glossaryLines.map((l) => e('div', { key: l, className: 'pdf2zh-glossary-line' }, l)),
                    glossary.terms > glossaryLines.length ? e('div', { className: 'pdf2zh-mut' }, `… 共 ${glossary.terms} 条`) : null,
                  ) : e('div', { className: 'pdf2zh-mut' }, '（空）'),
                  e('div', { className: 'pdf2zh-actions' },
                    e('button', {
                      type: 'button',
                      className: 'pdf2zh-btn',
                      onClick: () => { setGlossaryDraft(glossary.text); setEditingGlossary(true) },
                    }, '编辑术语表'),
                  ),
                  e('details', { className: 'pdf2zh-preview' },
                    e('summary', null, `全文（${glossary.terms} 条）`),
                    e('pre', null, glossary.text),
                  ),
                ),
        ] }),
      ),
    ),

    e('footer', { className: 'pdf2zh-foot' },
      health !== null
        ? e('div', { className: 'pdf2zh-foot-inner' },
            e('span', { className: 'pdf2zh-foot-status' },
              e(HealthDot, { ok: health.pymupdf.available, label: `PyMuPDF ${health.pymupdf.available ? health.pymupdf.version : '缺失'}` }),
              e(HealthDot, { ok: health.skill.synced, label: health.skill.synced ? '技能已同步' : '技能未同步' }),
            ),
            e('span', { className: 'pdf2zh-foot-meta', title: health.skill.synced ? health.skill.dir : '' },
              `v${health.version} · ${health.python}${modelLabel}`,
            ),
          )
        : healthError !== ''
          ? e('span', { className: 'pdf2zh-strip pdf2zh-strip-error' }, healthError)
          : e('span', { className: 'pdf2zh-mut' }, '连接中…'),
    ),

    modalOpen ? e(SettingsModal, { settings, onClose: () => setModalOpen(false), onSaved: setSettings }) : null,
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

function mountPanel(controller: PanelController): () => void {
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
    root.render(e(PanelView, { controller }))
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
    // While the settings modal is open the Panel's own handler closes it;
    // this outer listener must not tear the whole panel down as well.
    if (ev.key === 'Escape' && controller.getSnapshot() && document.querySelector('.pdf2zh-modal-mask') === null) {
      controller.hide()
    }
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
function PanelView({ controller }: { controller: PanelController }): any {
  const open = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  return open ? e(Panel, { hide: controller.hide }) : null
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

/* --- shared keyframes ---------------------------------------------------------- */

@keyframes pdf2zh-fade { from { opacity: 0; } }
@keyframes pdf2zh-pop {
  from { opacity: 0; transform: translateY(10px) scale(.97); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes pdf2zh-slide { from { opacity: 0; transform: translateY(4px); } }
@keyframes pdf2zh-shine {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(280%); }
}
@keyframes pdf2zh-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .35; }
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
  color: var(--dsw-alias-label-primary-foreground, #fff);
  background: linear-gradient(135deg, var(--dsw-alias-state-business-primary), var(--dsw-alias-brand-primary));
  box-shadow: 0 2px 8px rgba(0, 0, 0, .12);
}
.pdf2zh-heading-text { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.pdf2zh-title { font-size: 17px; font-weight: 600; white-space: nowrap; }
.pdf2zh-tabtitle {
  font-size: 13px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pdf2zh-top-actions { display: inline-flex; align-items: center; gap: 8px; flex: none; }
.pdf2zh-topbtn {
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
  transition: background-color .12s ease, color .12s ease, border-color .12s ease;
}
.pdf2zh-topbtn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.pdf2zh-topbtn-on {
  border-color: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.pdf2zh-gear { display: inline-flex; }

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
  background: linear-gradient(90deg, var(--dsw-alias-bg-layer-2), transparent 65%);
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
  color: var(--dsw-alias-label-primary-foreground, #fff);
  background: linear-gradient(135deg, var(--dsw-alias-state-business-primary), var(--dsw-alias-brand-primary));
}
.pdf2zh-guide-arrow { margin: 0 2px; opacity: .6; }

/* --- section cards ------------------------------------------------------------ */

.pdf2zh-section {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  overflow: hidden;
  background: var(--dsw-alias-bg-base);
  box-shadow: 0 1px 3px rgba(0, 0, 0, .05);
}
.pdf2zh-section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: linear-gradient(180deg, var(--dsw-alias-bg-layer-2), transparent);
}
.pdf2zh-section-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  flex: none;
  color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.pdf2zh-section-title { font-size: 14px; font-weight: 600; }
.pdf2zh-section-note { font-size: 12px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-left: auto; padding-left: 12px; }
.pdf2zh-section-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 11px; }

/* success accent for result cards */
.pdf2zh-section-success { border-color: var(--dsw-alias-state-success-primary); }
.pdf2zh-section-success .pdf2zh-section-title { color: var(--dsw-alias-state-success-primary); }
.pdf2zh-section-success .pdf2zh-section-icon { color: var(--dsw-alias-state-success-primary); }

/* --- settings modal ------------------------------------------------------------- */

.pdf2zh-modal-mask {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, .45));
  backdrop-filter: blur(3px);
  animation: pdf2zh-fade .16s ease;
}
.pdf2zh-modal {
  width: 620px;
  max-width: 100%;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  border: 1px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-base));
  box-shadow: 0 24px 64px rgba(0, 0, 0, .35);
  animation: pdf2zh-pop .18s ease;
  overflow: hidden;
}
.pdf2zh-modal-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px 12px;
}
.pdf2zh-modal-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  flex: none;
  color: var(--dsw-alias-label-primary-foreground, #fff);
  background: linear-gradient(135deg, var(--dsw-alias-state-business-primary), var(--dsw-alias-brand-primary));
}
.pdf2zh-modal-titlewrap { flex: 1; min-width: 0; }
.pdf2zh-modal-title { font-size: 15px; font-weight: 600; line-height: 1.25; }
.pdf2zh-modal-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.pdf2zh-modal-x {
  flex: none;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  transition: background-color .12s ease, color .12s ease;
}
.pdf2zh-modal-x:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }

.pdf2zh-tabs {
  flex: none;
  display: flex;
  gap: 4px;
  margin: 0 18px;
  padding: 3px;
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-2);
}
.pdf2zh-tab-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 13px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  transition: background-color .12s ease, color .12s ease;
}
.pdf2zh-tab-btn:hover { color: var(--dsw-alias-label-primary); }
.pdf2zh-tab-on {
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-state-business-primary);
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(0, 0, 0, .12);
}

.pdf2zh-modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  animation: pdf2zh-slide .14s ease;
}
.pdf2zh-modal-desc {
  display: flex;
  gap: 7px;
  align-items: flex-start;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-label-tertiary);
  padding: 8px 11px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.pdf2zh-modal-desc svg { flex: none; margin-top: 2px; }
.pdf2zh-modal-warnline {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-error-primary));
}
.pdf2zh-modal-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  background: linear-gradient(180deg, transparent, var(--dsw-alias-bg-layer-2));
}
.pdf2zh-foot-hint { flex: 1; min-width: 0; font-size: 11px; color: var(--dsw-alias-label-tertiary); }

/* API rows */
.pdf2zh-api-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  transition: border-color .12s ease, background-color .12s ease, transform .12s ease, box-shadow .12s ease;
}
.pdf2zh-api-row:hover:not(:disabled) {
  border-color: var(--dsw-alias-state-business-primary);
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(0, 0, 0, .08);
}
.pdf2zh-api-row:disabled { cursor: default; }
.pdf2zh-api-row-busy { opacity: .65; }
.pdf2zh-api-row-active {
  border-color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-interactive-bg-hover-accent, var(--dsw-alias-interactive-bg-hover));
  box-shadow: inset 3px 0 0 var(--dsw-alias-state-business-primary);
}
.pdf2zh-api-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pdf2zh-api-name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pdf2zh-api-sub {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pdf2zh-api-tags { display: inline-flex; gap: 5px; flex: none; }
.pdf2zh-api-tag {
  font-size: 10.5px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}
.pdf2zh-api-tag-active { color: var(--dsw-alias-state-business-primary); border-color: currentColor; font-weight: 600; }
.pdf2zh-api-tag-local { color: var(--dsw-alias-state-success-primary); border-color: currentColor; }
.pdf2zh-api-tag-ok { color: var(--dsw-alias-state-success-primary); border-color: currentColor; }
.pdf2zh-api-tag-warn { color: var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-error-primary)); border-color: currentColor; }
.pdf2zh-api-check {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1.5px solid var(--dsw-alias-border-l3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--dsw-alias-label-primary-foreground, #fff);
  transition: border-color .12s ease, background-color .12s ease;
}
.pdf2zh-api-check-on {
  border-color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-state-business-primary);
}
.pdf2zh-auto-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.pdf2zh-api-avatar {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.pdf2zh-api-avatar-plain { width: 22px; height: 22px; border-radius: 7px; font-size: 11px; }

.pdf2zh-api-groups { display: flex; flex-direction: column; gap: 10px; }
.pdf2zh-api-card {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  overflow: hidden;
}
.pdf2zh-api-card-off { opacity: .55; }
.pdf2zh-api-card-head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 11px;
  border-bottom: 1px dashed var(--dsw-alias-border-l1);
  background: linear-gradient(180deg, var(--dsw-alias-bg-layer-2), transparent);
}
.pdf2zh-api-card-name { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 7px; font-size: 13px; font-weight: 600; overflow: hidden; }
.pdf2zh-api-card-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10.5px;
  font-weight: 400;
  color: var(--dsw-alias-label-tertiary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  padding: 0 5px;
  border-radius: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pdf2zh-api-card-tags { flex: none; }
.pdf2zh-api-card-body { padding: 7px; display: flex; flex-direction: column; gap: 5px; }
.pdf2zh-api-card-body .pdf2zh-api-row { border-color: transparent; background: var(--dsw-alias-bg-layer-1, transparent); }
.pdf2zh-api-card-body .pdf2zh-api-row-active { border-color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-interactive-bg-hover-accent, var(--dsw-alias-interactive-bg-hover)); }

/* manual add-API */
.pdf2zh-addbtn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  width: 100%;
  padding: 9px 12px;
  font-size: 13px;
  border-radius: 10px;
  border: 1.5px dashed var(--dsw-alias-state-business-primary);
  background: transparent;
  color: var(--dsw-alias-state-business-primary);
  cursor: pointer;
  transition: background-color .12s ease;
}
.pdf2zh-addbtn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.pdf2zh-addform {
  display: flex;
  flex-direction: column;
  gap: 11px;
  padding: 13px 14px;
  border: 1px solid var(--dsw-alias-state-business-primary);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
  animation: pdf2zh-slide .14s ease;
}
.pdf2zh-addform-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.pdf2zh-key-wrap { display: flex; align-items: center; gap: 8px; }
.pdf2zh-key-wrap .pdf2zh-input { flex: 1; }
.pdf2zh-label-dim { font-weight: 400; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.pdf2zh-model-tools { display: flex; align-items: center; gap: 8px; }
.pdf2zh-model-picks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 150px;
  overflow-y: auto;
  padding: 8px 9px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
}
.pdf2zh-pick {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 4px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  transition: border-color .12s ease, color .12s ease, background-color .12s ease;
}
.pdf2zh-pick span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pdf2zh-pick:hover { border-color: var(--dsw-alias-state-business-primary); }
.pdf2zh-pick-on {
  border-color: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-interactive-bg-hover-accent, var(--dsw-alias-interactive-bg-hover));
  font-weight: 600;
}
.pdf2zh-pick-ctx { font-size: 10px; opacity: .8; }
.pdf2zh-add-manual {
  width: 100%;
  min-height: 54px;
  resize: vertical;
  padding: 8px 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  outline: none;
}
.pdf2zh-add-manual:focus { border-color: var(--dsw-alias-state-business-primary); }
.pdf2zh-add-actions { display: flex; align-items: center; gap: 10px; }
.pdf2zh-del-btn {
  padding: 2px 9px;
  font-size: 11px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  background: transparent;
  color: var(--dsw-alias-state-error-primary);
  cursor: pointer;
  transition: background-color .12s ease;
}
.pdf2zh-del-btn:hover { background: var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-interactive-bg-hover)); }
.pdf2zh-del-btn-confirm { background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-label-primary-foreground, #fff); font-weight: 600; }
.pdf2zh-api-tag-self { color: var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary)); border-color: currentColor; }

/* output tab fields */
.pdf2zh-field-card {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.pdf2zh-field-icon {
  display: inline-flex;
  vertical-align: -2px;
  margin-right: 6px;
  color: var(--dsw-alias-state-business-primary);
}
.pdf2zh-input-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px !important; }
.pdf2zh-field-hint { font-size: 11.5px; color: var(--dsw-alias-label-tertiary); line-height: 1.6; }
.pdf2zh-preset-row { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.pdf2zh-preset {
  padding: 5px 13px;
  font-size: 12px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  transition: background-color .12s ease, color .12s ease, border-color .12s ease;
}
.pdf2zh-preset:hover { background: var(--dsw-alias-interactive-bg-hover); }
.pdf2zh-preset-on {
  border-color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-interactive-bg-hover-accent, var(--dsw-alias-interactive-bg-hover));
  color: var(--dsw-alias-state-business-primary);
  font-weight: 600;
}
.pdf2zh-preset-custom { display: inline-flex; align-items: center; gap: 6px; }
.pdf2zh-preset-input { width: 78px !important; text-align: center; }
.pdf2zh-preset-unit { font-size: 12px; color: var(--dsw-alias-label-tertiary); }

/* --- translation board --------------------------------------------------------- */

.pdf2zh-statcards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.pdf2zh-statcard {
  border: 1px solid var(--dsw-alias-border-l1);
  border-left-width: 3px;
  border-radius: 10px;
  padding: 10px 14px;
  background: var(--dsw-alias-bg-base);
}
.pdf2zh-statcard-value { font-size: 22px; font-weight: 700; line-height: 1.2; }
.pdf2zh-statcard-label { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.pdf2zh-statcard-running { border-left-color: var(--dsw-alias-state-business-primary); }
.pdf2zh-statcard-running .pdf2zh-statcard-value { color: var(--dsw-alias-state-business-primary); }
.pdf2zh-statcard-done { border-left-color: var(--dsw-alias-state-success-primary); }
.pdf2zh-statcard-done .pdf2zh-statcard-value { color: var(--dsw-alias-state-success-primary); }
.pdf2zh-statcard-failed { border-left-color: var(--dsw-alias-state-error-primary); }
.pdf2zh-statcard-failed .pdf2zh-statcard-value { color: var(--dsw-alias-state-error-primary); }

.pdf2zh-overall { display: flex; align-items: center; gap: 10px; }
.pdf2zh-overall-label { flex: none; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.pdf2zh-overall-pct { flex: none; width: 42px; text-align: right; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.pdf2zh-board-tools { display: flex; justify-content: flex-end; }

.pdf2zh-bar {
  position: relative;
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
.pdf2zh-bar-anim .pdf2zh-bar-fill::after {
  content: '';
  position: absolute;
  inset: 0;
  width: 36%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, .28), transparent);
  animation: pdf2zh-shine 1.6s ease-in-out infinite;
}

.pdf2zh-jobs { display: flex; flex-direction: column; gap: 10px; }
.pdf2zh-job {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  padding: 11px 13px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  transition: border-color .12s ease, box-shadow .12s ease;
}
.pdf2zh-job:hover { box-shadow: 0 3px 12px rgba(0, 0, 0, .07); }
.pdf2zh-job-running { border-color: var(--dsw-alias-state-business-primary); }
.pdf2zh-job-done { border-color: var(--dsw-alias-state-success-secondary, var(--dsw-alias-state-success-primary)); }
.pdf2zh-job-failed { border-color: var(--dsw-alias-state-error-primary); }
.pdf2zh-job-head { display: flex; align-items: center; gap: 8px; }
.pdf2zh-job-statusdot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.pdf2zh-job-statusdot-running { background: var(--dsw-alias-state-business-primary); animation: pdf2zh-pulse 1.4s ease-in-out infinite; }
.pdf2zh-job-statusdot-done { background: var(--dsw-alias-state-success-primary); }
.pdf2zh-job-statusdot-failed { background: var(--dsw-alias-state-error-primary); }
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
.pdf2zh-badge-running { color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-interactive-bg-hover); }
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
.pdf2zh-job-api { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-secondary); }
.pdf2zh-job-api svg { flex: none; }
.pdf2zh-job-error { color: var(--dsw-alias-state-error-primary); }
.pdf2zh-job-warn { color: var(--dsw-alias-state-error-primary); opacity: .85; }

.pdf2zh-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 26px 14px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 10px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
}
.pdf2zh-empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary));
}

/* --- form ---------------------------------------------------------------------- */

.pdf2zh-input::placeholder { color: var(--dsw-alias-label-tertiary); }
.pdf2zh-input:focus { border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 3px rgba(0, 122, 255, .12); }
.pdf2zh-options { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; }
.pdf2zh-field { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.pdf2zh-field-row { display: flex; flex-direction: column; gap: 6px; }
.pdf2zh-field-label { display: inline-flex; align-items: center; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.pdf2zh-check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--dsw-alias-label-secondary); cursor: pointer; user-select: none; }
.pdf2zh-check input { accent-color: var(--dsw-alias-state-business-primary); }

/* drop zone */
.pdf2zh-drop {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 16px 14px;
  border: 1.5px dashed var(--dsw-alias-border-l2);
  border-radius: 12px;
  cursor: pointer;
  font-size: 13px;
  color: var(--dsw-alias-label-tertiary);
  background: linear-gradient(180deg, transparent, var(--dsw-alias-bg-layer-2));
  transition: border-color .12s ease, background-color .12s ease, color .12s ease;
}
.pdf2zh-drop:hover { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-secondary); }
.pdf2zh-drop-hot {
  border-color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.pdf2zh-drop-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}

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
  transition: background-color .12s ease, opacity .12s ease, border-color .12s ease, transform .12s ease;
}
.pdf2zh-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.pdf2zh-btn:active:not(:disabled) { transform: scale(.98); }
.pdf2zh-btn:disabled { opacity: .45; cursor: not-allowed; }
.pdf2zh-btn-primary {
  background: linear-gradient(135deg, var(--dsw-alias-state-business-primary), var(--dsw-alias-brand-primary));
  border-color: transparent;
  color: var(--dsw-alias-label-primary-foreground, #fff);
  box-shadow: 0 2px 10px rgba(0, 0, 0, .15);
}
.pdf2zh-btn-primary:hover:not(:disabled) { opacity: .92; background: linear-gradient(135deg, var(--dsw-alias-state-business-primary), var(--dsw-alias-brand-primary)); }
.pdf2zh-btn-mini { padding: 4px 11px; font-size: 12px; }
.pdf2zh-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary); }

/* --- feedback ------------------------------------------------------------------- */

.pdf2zh-strip {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 13px;
  font-size: 13px;
  border-radius: 10px;
  line-height: 1.55;
  animation: pdf2zh-slide .14s ease;
  color: var(--dsw-alias-label-primary);
}
.pdf2zh-strip-icon { flex: none; display: inline-flex; margin-top: 2px; }
.pdf2zh-strip-error {
  border: 1px solid var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-bg-layer-2);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap;
  word-break: break-all;
}
.pdf2zh-strip-error .pdf2zh-strip-icon { color: var(--dsw-alias-state-error-primary); }
.pdf2zh-strip-notice {
  border: 1px solid var(--dsw-alias-state-success-primary);
  background: var(--dsw-alias-bg-layer-2);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary);
  word-break: break-all;
}
.pdf2zh-strip-notice .pdf2zh-strip-icon { color: var(--dsw-alias-state-success-primary); }
.pdf2zh-job-hintline { font-family: var(--dsw-font-family, inherit); color: var(--dsw-alias-label-tertiary); }
.pdf2zh-retry-btn {
  flex: none;
  padding: 2px 10px;
  font-size: 11px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-state-business-primary);
  background: transparent;
  color: var(--dsw-alias-state-business-primary);
  cursor: pointer;
  transition: background-color .12s ease;
}
.pdf2zh-retry-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
/* legacy classes still referenced by JobRow-free contexts */
.pdf2zh-error {
  padding: 10px 13px;
  font-size: 13px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-state-error-primary);
  white-space: pre-wrap;
  word-break: break-all;
}
.pdf2zh-notice {
  padding: 10px 13px;
  font-size: 13px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-state-success-primary);
  background: var(--dsw-alias-bg-layer-2);
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
`

/* ------------------------------------------------------------------ *\
 * Plugin entry
 * ------------------------------------------------------------------ */

export const inject: string[] = []

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

    const disposePanel = mountPanel(controller)

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
