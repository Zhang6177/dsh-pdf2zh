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
 * extract preview with stat chips, one-click session translation, a save-path
 * setting (where .zh.md outputs land), glossary preview/editor, and a status
 * strip with green/red health dots.
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

interface Settings {
  ok: boolean
  outputDir: string
  timeoutMinutes: number
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
  }): Promise<{ ok: boolean; sessionId: string; jobId: string }> =>
    call<{ ok: boolean; sessionId: string; jobId: string }>(`${API_PREFIX}/translate`, 'POST', body),
  glossary: (): Promise<Glossary> => call<Glossary>(`${API_PREFIX}/glossary`, 'GET'),
  glossarySave: (text: string): Promise<{ ok: boolean; path: string; terms: number }> =>
    call<{ ok: boolean; path: string; terms: number }>(`${API_PREFIX}/glossary`, 'POST', { text }),
  settings: (): Promise<Settings> => call<Settings>(`${API_PREFIX}/settings`, 'GET'),
  settingsSave: (body: { outputDir: string }): Promise<Settings> =>
    call<Settings>(`${API_PREFIX}/settings`, 'POST', body),
  jobs: (): Promise<JobsResult> => call<JobsResult>(`${API_PREFIX}/jobs`, 'GET'),
  jobDelete: (id: string): Promise<{ ok: boolean }> => call<{ ok: boolean }>(`${API_PREFIX}/jobs/delete`, 'POST', { id }),
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
const RECENT_MAX = 4

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string').slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

function pushRecent(path: string): string[] {
  const next = [path, ...readRecent().filter((p) => p !== path)].slice(0, RECENT_MAX)
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)) } catch { /* private mode */ }
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

/** Section card: title + optional note + body. `children` may be an array. */
function Section(props: { title: string; note?: string; accent?: 'success'; children: React.ReactNode }): any {
  const { title, note, accent, children } = props
  return e('div', { className: `pdf2zh-section${accent ? ` pdf2zh-section-${accent}` : ''}` },
    e('div', { className: 'pdf2zh-section-head' },
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
  return e('div', { className: 'pdf2zh-bar' },
    e('div', { className: `pdf2zh-bar-fill pdf2zh-bar-${status}`, style: { width: `${pct}%` } }),
  )
}

/* ------------------------------------------------------------------ *\
 * Translation board
 * ------------------------------------------------------------------ */

function JobRow({ job, onDelete }: { job: Job; onDelete: (id: string) => void }): any {
  const pct = Math.round(job.progress * 100)
  return e('div', { className: `pdf2zh-job pdf2zh-job-${job.status}`, key: job.id },
    e('div', { className: 'pdf2zh-job-head' },
      e('span', { className: 'pdf2zh-job-name', title: job.pdfPath }, job.pdfName),
      e('span', { className: `pdf2zh-badge pdf2zh-badge-${job.status}` }, STATUS_LABEL[job.status]),
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
      ? e('div', { className: 'pdf2zh-job-meta' }, e('span', { className: 'pdf2zh-job-error' }, job.error))
      : null,
  )
}

function Board({ jobs, summary, onDelete, onClear }: {
  jobs: Job[]
  summary: JobsResult['summary']
  onDelete: (id: string) => void
  onClear: () => void
}): any {
  const total = jobs.length
  const overall = total > 0 ? jobs.reduce((acc, j) => acc + j.progress, 0) / total : 0
  const overallStatus: JobStatus | 'overall' = summary.failed > 0 && summary.running === 0 && summary.done === 0
    ? 'failed'
    : summary.running === 0 && summary.done > 0 && summary.failed === 0 ? 'done' : 'overall'
  return Section({
    title: '翻译看板',
    note: '每 5 秒自动刷新',
    children: [
      e('div', { className: 'pdf2zh-board-stats' },
        e('span', { className: 'pdf2zh-stat pdf2zh-stat-running' }, e('b', null, summary.running), '进行中'),
        e('span', { className: 'pdf2zh-stat pdf2zh-stat-done' }, e('b', null, summary.done), '已完成'),
        e('span', { className: 'pdf2zh-stat pdf2zh-stat-failed' }, e('b', null, summary.failed), '已失败'),
        total > 0 ? e('span', { style: { flex: 1 } }) : null,
        summary.done + summary.failed > 0 ? e('button', {
          type: 'button',
          className: 'pdf2zh-btn pdf2zh-btn-mini',
          onClick: onClear,
        }, '清空已完成') : null,
      ),
      total > 0
        ? e('div', { className: 'pdf2zh-overall' },
            e('span', { className: 'pdf2zh-overall-label' }, `总体 ${Math.round(overall * 100)}%`),
            e(ProgressBar, { value: overall, status: overallStatus }),
          )
        : null,
      total === 0
        ? e('div', { className: 'pdf2zh-mut' }, '暂无翻译任务：填好路径点「开始翻译」后，进度会在这里实时更新。')
        : e('div', { className: 'pdf2zh-jobs' }, jobs.map((job) => e(JobRow, { key: job.id, job, onDelete }))),
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
  const [recent, setRecent] = useState<string[]>(() => readRecent())
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
  const [outputDir, setOutputDir] = useState('')
  const [savedOutputDir, setSavedOutputDir] = useState<string | null>(null)
  const [savingSettings, setSavingSettings] = useState(false)
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

  const refreshSettings = useCallback((fill: boolean): void => {
    api.settings().then((s) => {
      setSavedOutputDir(s.outputDir)
      if (fill) setOutputDir(s.outputDir)
    }).catch(() => { /* settings section will show raw state */ })
  }, [])

  useEffect(() => {
    refreshHealth()
    refreshGlossary()
    refreshJobs()
    refreshSettings(true)
    healthTimer.current = setInterval(refreshHealth, 30_000)
    jobsTimer.current = setInterval(refreshJobs, 5_000)
    const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') hide() }
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

  const onSaveSettings = useCallback(async (): Promise<void> => {
    setSavingSettings(true)
    setError('')
    setNotice('')
    try {
      const saved = await api.settingsSave({ outputDir: outputDir.trim() })
      setOutputDir(saved.outputDir)
      setSavedOutputDir(saved.outputDir)
      setNotice(saved.outputDir
        ? `设置已保存：译文 .zh.md 将保存到 ${saved.outputDir}`
        : '设置已保存：译文将保存在源 PDF 同目录')
      refreshJobs()
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setSavingSettings(false)
    }
  }, [outputDir, refreshJobs])

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
      await api.translate({
        path: trimmed,
        pages: pages.trim() || undefined,
        bilingual,
        appendix,
        sourceChars: extract !== null && extract.pdfPath === trimmed ? extract.chars : undefined,
      })
      remember(trimmed)
      setNotice('翻译任务已创建，进度见上方「翻译看板」（无需打开会话）。')
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
  const settingsDirty = savedOutputDir !== null && outputDir.trim() !== savedOutputDir

  return e('div', { className: 'pdf2zh-shell', role: 'region', 'aria-label': 'PDF 英转中' },
    e('header', { className: 'pdf2zh-top' },
      e('div', { className: 'pdf2zh-top-inner' },
      e('div', { className: 'pdf2zh-heading' },
        e('span', { className: 'pdf2zh-logo' },
          e('svg', { viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true' },
            e('path', { d: 'M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z' })),
        ),
        e('div', { className: 'pdf2zh-heading-text' },
          e('div', { className: 'pdf2zh-title' }, 'PDF 英转中'),
          e('span', { className: 'pdf2zh-tab' }, 'pdf2zh · 轻量化学术论文 PDF 英转中'),
        ),
      ),
      e('button', { type: 'button', className: 'pdf2zh-back', onClick: hide }, '返回会话'),
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

        e(Board, { jobs, summary, onDelete: onJobDelete, onClear: onJobsClear }),

        Section({ title: '翻译论文', note: '填服务器上的 PDF 绝对路径，或直接拖拽/选择本地 PDF 上传', children: [
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
            e('span', { className: 'pdf2zh-drop-icon' },
              e('svg', { viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true' },
                e('path', { d: 'M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z' })),
            ),
            uploading
              ? e('span', null, `正在上传 ${uploadName}…`)
              : e('span', null, '拖拽 PDF 到此处，或点击选择文件上传到服务器'),
          ),
          e('input', {
            className: 'pdf2zh-input',
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
            }, translating ? '创建任务中…' : '开始翻译（新建会话）'),
            !pathValid ? e('span', { className: 'pdf2zh-hint' }, '回车 = 提取预览') : null,
          ),
        ] }),

        notice !== '' ? e('div', { className: 'pdf2zh-notice' }, notice) : null,
        error !== '' ? e('div', { className: 'pdf2zh-error' }, error) : null,

        extract !== null
          ? Section({ title: '提取完成', accent: 'success', children: [
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

        Section({ title: '设置', note: '翻译结果保存位置', children: [
          e('div', { className: 'pdf2zh-field-row' },
            e('span', { className: 'pdf2zh-field-label' }, '保存路径'),
            e('input', {
              className: 'pdf2zh-input',
              style: INPUT_STYLE,
              value: outputDir,
              placeholder: '留空 = 保存在源 PDF 同目录；例如 /data02/zhangqinhan/papers/translated',
              onChange: (ev: any) => setOutputDir(ev.target.value),
              spellCheck: false,
            }),
          ),
          e('div', { className: 'pdf2zh-mut' },
            '指定后，翻译产出的中文 Markdown（.zh.md，含中英对照版）会统一保存到该目录（需为服务器上的绝对路径）；留空则保持与源 PDF 同目录。',
          ),
          e('div', { className: 'pdf2zh-actions' },
            e('button', {
              type: 'button',
              className: 'pdf2zh-btn pdf2zh-btn-primary',
              disabled: !settingsDirty || savingSettings,
              onClick: onSaveSettings,
            }, savingSettings ? '保存中…' : '保存设置'),
            savedOutputDir !== null
              ? e('span', { className: 'pdf2zh-hint' },
                  savedOutputDir === '' ? '当前：源 PDF 同目录' : `当前：${savedOutputDir}`,
                )
              : null,
          ),
        ] }),

        Section({ title: '术语表', note: '跨论文译名一致 · 可编辑', children: [
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
              `v${health.version} · ${health.python}${health.skill.synced ? ` · ${health.skill.dir}` : ''}`,
            ),
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
.pdf2zh-back {
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
