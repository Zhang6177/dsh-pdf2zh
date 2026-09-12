#!/usr/bin/env node
/**
 * dsh-pdf2zh — host entry (plain ESM, no build step).
 *
 * Responsibilities:
 *  1. On every boot, sync the bundled pdf2zh skill (SKILL.md, extract.py)
 *     into the DSH skill directory (`<DSH home>/skills/pdf2zh`), seeding
 *     glossary.md only when absent so the user's accumulated terms survive.
 *  2. Register a small API under /api/pdf2zh (same-origin, loopback only):
 *       GET  /health        — plugin / python / pymupdf / skill status
 *       GET  /skill         — installed skill file listing
 *       GET  /glossary      — current glossary text
 *       POST /glossary      — save edited glossary text
 *       POST /extract       — run the PyMuPDF extractor on a server-side PDF path
 *       POST /translate     — spawn the structured fast pipeline (detached python), record a job
 *       POST /upload        — drag-drop PDF upload (raw body, filename in x-pdf2zh-filename)
 *       GET  /settings      — current UI settings (output dir / timeout / model / concurrency)
 *       POST /settings      — persist UI settings (~/.dsh/pdf2zh/settings.json)
 *       GET  /models        — the dsh LLM registry (providers/models + auto pick)
 *       POST /models/discover — probe an endpoint's model list (draft key, never stored)
 *       POST /models/add    — register a new provider into dsh settings (hot)
 *       POST /models/remove — delete a user-added provider profile
 *       GET  /jobs          — translation job board (statuses + progress)
 *       GET  /file          — serve a produced file (whitelisted job outputs)
 *       POST /jobs/delete   — remove one job from the board (kills its pipeline if running)
 *       POST /jobs/retry    — re-dispatch a finished/failed job (new pipeline, replaces the card)
 *       POST /jobs/clear    — remove all finished (done/failed) jobs
 *  3. Watch every running job through its pipeline progress file
 *     (<DSH home>/pdf2zh/jobs/<id>.json: stage + paragraph counters),
 *     persisting the board ledger to ~/.dsh/pdf2zh/jobs.json.
 *
 * v0.8: translation is no longer done inside a DSH session. The host spawns
 * `pipeline/run_pipeline.py` (PyMuPDF layout extraction → batched paragraph
 * translation against the selected OpenAI/Anthropic-compatible endpoint with
 * thinking disabled and N-way concurrency → layout-faithful Chinese PDF).
 * Deterministic work stays deterministic; the LLM only translates text.
 */

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, createReadStream, openSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from 'schemastery'

export const name = 'pdf2zh'
export const inject = ['webServer', 'sessionController']

const require = createRequire(import.meta.url)
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PIPELINE_DIR = join(PKG_ROOT, 'pipeline')
const SKILL_SRC_DIR = join(PKG_ROOT, 'skill')
/** Managed on every boot: overwritten when the bundled version differs. */
const MANAGED_SKILL_FILES = ['SKILL.md', 'extract.py']
/** Seeded only when missing: the user's accumulated glossary survives upgrades. */
const SEEDED_SKILL_FILES = ['glossary.md']
const MAX_PDF_BYTES = 100 * 1024 * 1024
const MAX_PREVIEW_CHARS = 1200
const MAX_BODY_BYTES = 64 * 1024
/** extract.py page spec: "1-8" / "1,3,5-9" — kept deliberately permissive, the script validates. */
const PAGES_SPEC = /^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$/
/** Board watcher cadence and how long we wait for a spawned pipeline to announce itself. */
const POLL_INTERVAL_MS = 10_000
const PIPELINE_START_GRACE_MS = 120_000
/** A progress file older than this with a dead pid means the pipeline died mid-run. */
const PIPELINE_STALE_MS = 60_000
const DEFAULT_TIMEOUT_MINUTES = 240
const MAX_TIMEOUT_MINUTES = 1440
const DEFAULT_CONCURRENCY = 8
const MAX_CONCURRENCY = 16
const MAX_JOBS = 200
/** dsh settings namespace owning LLM provider profiles (the Models settings page writes it too). */
const LLM_SETTINGS_NS = 'llm-pi-ai'
const ADDABLE_APIS = new Set(['openai-completions', 'anthropic-messages', 'openai-responses'])
const PROVIDER_ID = /^[a-z][a-z0-9_-]{1,40}$/
const VERSION = (() => {
  try { return require('../package.json').version } catch { return '0.0.0' }
})()

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export const Config = z.object({
  enabled: z.boolean().default(true).description('Master switch; when false the API answers 503.'),
  apiPath: z.string().default('/api/pdf2zh').description('Same-origin API prefix.'),
  python: z.string().default('python3').description('Python interpreter used by extract.py.'),
  skillSync: z.boolean().default(true).description('Sync bundled skill files into the DSH skill dir on boot.'),
  skillDir: z.string().description('Skill dir override; defaults to <DSH home>/skills/pdf2zh.'),
  uploadDir: z.string().description('Drag-drop upload dir override; defaults to <DSH home>/pdf2zh/uploads.'),
  outputDir: z.string().default('').description('Initial translation output dir; the UI setting (settings.json) overrides it at runtime.'),
  timeoutMinutes: z.number().default(DEFAULT_TIMEOUT_MINUTES).description('Initial per-job translation timeout (10-1440 minutes).'),
})

class Pdf2Zh {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = {
      enabled: config.enabled ?? true,
      apiPath: (config.apiPath ?? '/api/pdf2zh').replace(/\/+$/, ''),
      python: config.python ?? 'python3',
      skillSync: config.skillSync ?? true,
      skillDir: (config.skillDir || join(dshHome(), 'skills', 'pdf2zh')).replace(/\/+$/, ''),
      uploadDir: (config.uploadDir || join(dshHome(), 'pdf2zh', 'uploads')).replace(/\/+$/, ''),
    }
    this.dataDir = join(dshHome(), 'pdf2zh')
    this.settingsPath = join(this.dataDir, 'settings.json')
    this.jobsPath = join(this.dataDir, 'jobs.json')
    this.jobsDir = join(this.dataDir, 'jobs')
    this.settings = {
      outputDir: typeof config.outputDir === 'string' ? config.outputDir : '',
      timeoutMinutes: clampTimeout(config.timeoutMinutes),
      model: { provider: '', model: '' },
      concurrency: DEFAULT_CONCURRENCY,
    }
    this.jobs = []
    this.children = new Map()
    this.jobsLoaded = false
    this.processStartedAt = Date.now()
    this.skill = { dir: this.config.skillDir, synced: false, files: [] }
    this.pymupdf = { checked: false, available: false, version: '' }
    this.requests = { available: false }
    this.polling = false
  }

  start() {
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'prefix',
      path: this.config.apiPath,
      handler: (req, res) => { void this.handle(req, res) },
    }), 'pdf2zh: API routes')
    void this.bootstrap().catch((error) => {
      this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
    })
  }

  async bootstrap() {
    if (this.config.skillSync) await this.syncSkill()
    await this.checkPymupdf()
    await this.loadSettings()
    await this.loadJobs()
    this.startWatcher()
  }

  /** Copy managed skill files over the install; seed the glossary once. */
  async syncSkill() {
    await mkdir(this.skill.dir, { recursive: true })
    const changed = []
    for (const file of MANAGED_SKILL_FILES) {
      const srcPath = join(SKILL_SRC_DIR, file)
      const dstPath = join(this.skill.dir, file)
      const src = await readFile(srcPath)
      try {
        const dst = await readFile(dstPath)
        if (dst.equals(src)) continue
      } catch { /* missing — write below */ }
      await writeFile(dstPath, src, { mode: 0o644 })
      changed.push(file)
    }
    for (const file of SEEDED_SKILL_FILES) {
      const dstPath = join(this.skill.dir, file)
      try {
        await stat(dstPath)
      } catch {
        await copyFile(join(SKILL_SRC_DIR, file), dstPath)
        changed.push(`${file} (seeded)`)
      }
    }
    this.skill.synced = true
    try { this.skill.files = (await readdir(this.skill.dir)).sort() } catch { this.skill.files = [] }
    this.ctx.logger.info(
      `[pdf2zh] skill synced to ${this.skill.dir}${changed.length ? ` (updated: ${changed.join(', ')})` : ''}`,
    )
  }

  async checkPymupdf() {
    try {
      const out = await this.runPython(['-c', 'import fitz; print(fitz.version[0])'], 15_000)
      this.pymupdf = { checked: true, available: true, version: out.trim() }
    } catch {
      this.pymupdf = { checked: true, available: false, version: '' }
    }
    try {
      await this.runPython(['-c', 'import requests'], 15_000)
      this.requests = { available: true }
    } catch {
      this.requests = { available: false }
    }
  }

  runPython(args, timeoutMs) {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(this.config.python, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      let settled = false
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        if (!settled) {
          settled = true
          rejectPromise(new Error('python command timed out'))
        }
      }, timeoutMs)
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { err += d })
      child.on('error', (e) => {
        clearTimeout(timer)
        if (!settled) {
          settled = true
          rejectPromise(e)
        }
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        if (code === 0) resolvePromise(out)
        else rejectPromise(new Error((err || out).trim() || `python exited with code ${code}`))
      })
    })
  }

  /* ---------------- settings (UI-configurable, persisted) ---------------- */

  async loadSettings() {
    try {
      const raw = JSON.parse(await readFile(this.settingsPath, 'utf8'))
      if (typeof raw.outputDir === 'string' && (raw.outputDir === '' || isAbsolute(raw.outputDir))) {
        this.settings.outputDir = raw.outputDir.replace(/\/+$/, '')
      }
      if (typeof raw.timeoutMinutes === 'number') {
        this.settings.timeoutMinutes = clampTimeout(raw.timeoutMinutes)
      }
      if (typeof raw.concurrency === 'number') {
        this.settings.concurrency = clampConcurrency(raw.concurrency)
      }
      if (raw.model && typeof raw.model === 'object') {
        const provider = typeof raw.model.provider === 'string' ? raw.model.provider.trim() : ''
        const model = typeof raw.model.model === 'string' ? raw.model.model.trim() : ''
        if (provider !== '' && model !== '') this.settings.model = { provider, model }
      }
    } catch { /* first boot: keep config defaults */ }
  }

  async saveSettings() {
    await mkdir(this.dataDir, { recursive: true })
    await writeFile(this.settingsPath, JSON.stringify({
      outputDir: this.settings.outputDir,
      timeoutMinutes: this.settings.timeoutMinutes,
      model: this.settings.model,
      concurrency: this.settings.concurrency,
    }, null, 2), { mode: 0o644 })
  }

  /** Validate and apply a settings patch; empty outputDir means "same dir as the source PDF". */
  async updateSettings(patch) {
    if (patch === null || typeof patch !== 'object') throw new Error('body must be a JSON object')
    const next = { ...this.settings }
    if (patch.outputDir !== undefined) {
      const dir = String(patch.outputDir ?? '').trim().replace(/\/+$/, '')
      if (dir !== '' && !isAbsolute(dir)) throw new Error('保存路径必须是绝对路径（或留空表示与源 PDF 同目录）')
      if (dir !== '') {
        try {
          await mkdir(dir, { recursive: true })
          await stat(dir)
        } catch (error) {
          throw new Error(`无法创建保存目录：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      next.outputDir = dir
    }
    if (patch.timeoutMinutes !== undefined) {
      next.timeoutMinutes = clampTimeout(patch.timeoutMinutes)
    }
    if (patch.concurrency !== undefined) {
      next.concurrency = clampConcurrency(patch.concurrency)
    }
    if (patch.model !== undefined) {
      const raw = patch.model
      if (raw === null || typeof raw !== 'object') throw new Error('model 需为 {provider, model} 对象（或 {provider:"", model:""} 恢复自动）')
      const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
      const model = typeof raw.model === 'string' ? raw.model.trim() : ''
      if (provider === '' && model === '') {
        next.model = { provider: '', model: '' }
      } else if (provider !== '' && model !== '') {
        next.model = { provider, model }
      } else {
        throw new Error('model 的 provider 与 model 必须同时给出或同时为空')
      }
    }
    this.settings = next
    await this.saveSettings()
    return { ...this.settings }
  }

  /** Absolute dir where finished translations live, or '' for "next to the source PDF". */
  async ensureOutputDir() {
    if (!this.settings.outputDir) return ''
    await mkdir(this.settings.outputDir, { recursive: true })
    return this.settings.outputDir
  }

  /* ---------------- job ledger (board) ---------------- */

  async loadJobs() {
    this.jobsLoaded = true
    try {
      const raw = JSON.parse(await readFile(this.jobsPath, 'utf8'))
      if (Array.isArray(raw?.jobs)) {
        this.jobs = raw.jobs
          .filter((j) => j && typeof j.id === 'string' && typeof j.pdfPath === 'string')
          .slice(-MAX_JOBS)
      }
    } catch { /* first boot: empty ledger */ }
  }

  async saveJobs() {
    try {
      await mkdir(this.dataDir, { recursive: true })
      await writeFile(this.jobsPath, JSON.stringify({ version: 1, jobs: this.jobs.slice(-MAX_JOBS) }, null, 2), { mode: 0o644 })
    } catch (error) {
      this.ctx.logger.warn(new Error(`[pdf2zh] job ledger save failed: ${error instanceof Error ? error.message : String(error)}`))
    }
  }

  addJob(job) {
    this.jobs.push(job)
    if (this.jobs.length > MAX_JOBS) this.jobs = this.jobs.slice(-MAX_JOBS)
    void this.saveJobs()
  }

  jobViewPaths(job) {
    const stem = basename(job.pdfPath).replace(/\.pdf$/i, '')
    const dirs = []
    if (job.outputDir) dirs.push(job.outputDir)
    const pdfDir = dirname(job.pdfPath)
    if (!dirs.includes(pdfDir)) dirs.push(pdfDir)
    const names = [`${stem}.zh.pdf`, `${stem}.zh.md`]
    if (job.bilingual) names.push(`${stem}.en-zh.md`)
    return { stem, dirs, names }
  }

  /** First existing candidate path for one output name, or null. */
  async locateOutput(job, name) {
    const { dirs } = this.jobViewPaths(job)
    for (const dir of dirs) {
      try {
        const st = await stat(join(dir, name))
        if (st.isFile()) return { path: join(dir, name), bytes: st.size }
      } catch { /* try next dir */ }
    }
    return null
  }

  /**
   * 0..1 progress. The pipeline publishes real paragraph counts; before its
   * first write we creep so a launched card never looks frozen.
   */
  async progressFor(job, now = Date.now()) {
    if (job.status === 'done') return 1
    if (job.status === 'failed') return typeof job.progress === 'number' ? job.progress : 0
    if (typeof job.progress === 'number' && job.progress > 0) {
      return Math.min(0.98, job.progress)
    }
    const elapsed = Math.max(0, now - job.createdAt)
    return Math.min(0.15, Math.max(0.02, elapsed / 120_000))
  }

  /** Board payload: every job with its live progress + summary counts. */
  async jobsView() {
    const now = Date.now()
    const jobs = await Promise.all(this.jobs.map(async (job) => ({
      ...job,
      progress: await this.progressFor(job, now),
      elapsedMs: Math.max(0, (job.endedAt ?? now) - job.createdAt),
    })))
    jobs.sort((a, b) => b.createdAt - a.createdAt)
    const summary = { running: 0, done: 0, failed: 0 }
    for (const job of jobs) {
      if (job.status === 'running') summary.running += 1
      else if (job.status === 'done') summary.done += 1
      else summary.failed += 1
    }
    return { ok: true, jobs, summary, settings: { ...this.settings } }
  }

  /* ---------------- board watcher (pipeline progress files) ---------------- */

  startWatcher() {
    setInterval(() => { void this.pollWatchers() }, POLL_INTERVAL_MS).unref?.()
  }

  jobProgressPath(job) {
    return join(this.jobsDir, `${job.id}.json`)
  }

  jobLogPath(job) {
    return join(this.jobsDir, `${job.id}.log`)
  }

  async readProgress(job) {
    try {
      const parsed = JSON.parse(await readFile(this.jobProgressPath(job), 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  static pidAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error?.code === 'EPERM'
    }
  }

  killPipeline(job) {
    const pid = Number(job.childPid) || 0
    if (pid <= 0) return
    try {
      process.kill(-pid, 'SIGKILL') // detached child is its own process-group leader
    } catch {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }

  async pollWatchers() {
    if (!this.config.enabled || this.polling) return
    const running = this.jobs.filter((j) => j.status === 'running')
    if (running.length === 0) return
    this.polling = true
    try {
      const now = Date.now()
      let dirty = false
      for (const job of running) {
        if (now >= (job.timeoutAt ?? job.createdAt + this.settings.timeoutMinutes * 60_000)) {
          const minutes = Math.max(1, Math.round(((job.timeoutAt ?? now) - job.createdAt) / 60_000))
          this.killPipeline(job)
          await this.settleJob(job, 'failed', `翻译超时（超过 ${minutes} 分钟），已终止翻译进程`, now)
          dirty = true
          continue
        }
        const prog = await this.readProgress(job)
        if (prog === null) {
          // The child never announced itself: spawn failed or python is missing.
          if (now - Math.max(job.createdAt, this.processStartedAt) > PIPELINE_START_GRACE_MS) {
            await this.settleJob(job, 'failed', `翻译进程未启动（检查 python3/PyMuPDF），日志：${this.jobLogPath(job)}`, now)
            dirty = true
          }
          continue
        }
        if (prog.result && typeof prog.result === 'object') {
          if (prog.result.ok === true) {
            await this.settleJob(job, 'done', undefined, now, prog.result)
          } else {
            await this.settleJob(job, 'failed', String(prog.result.error ?? '翻译管线报错').slice(0, 300), now)
          }
          dirty = true
          continue
        }
        const stage = String(prog.stage ?? '')
        const total = Number(prog.total) || 0
        const done = Number(prog.done) || 0
        let pct = job.progress ?? 0.02
        if (stage === 'extract') pct = 0.03
        else if (stage === 'translate' && total > 0) pct = 0.05 + 0.87 * Math.min(1, done / total)
        else if (stage === 'render') pct = 0.95
        if (typeof pct === 'number' && Math.abs(pct - (job.progress ?? 0)) >= 0.005) {
          job.progress = pct
          dirty = true
        }
        const phase = typeof prog.phase === 'string' ? prog.phase.slice(0, 60) : ''
        if (phase && phase !== job.phase) {
          job.phase = phase
          dirty = true
        }
        if (!Pdf2Zh.pidAlive(Number(prog.pid)) && now - Number(prog.ts ?? 0) > PIPELINE_STALE_MS) {
          this.killPipeline(job)
          await this.settleJob(job, 'failed', `翻译进程中途退出（阶段：${phase || '未知'}），可点「重试」。日志：${this.jobLogPath(job)}`, now)
          dirty = true
        }
      }
      if (dirty) await this.saveJobs()
    } finally {
      this.polling = false
    }
  }

  /**
   * Move a job out of 'running'. `result` is the pipeline's final block
   * ({ok, outputs, stats, failedParagraphs, warnings}) when available.
   */
  async settleJob(job, outcome, error, endedAt, result) {
    job.status = outcome
    job.endedAt = endedAt ?? Date.now()
    if (result?.stats) job.stats = result.stats
    if (Number(result?.failedParagraphs) > 0) job.failedParagraphs = Number(result.failedParagraphs)
    if (Array.isArray(result?.warnings) && result.warnings.length > 0) {
      job.renderWarnings = result.warnings.slice(0, 3)
    }
    job.progress = outcome === 'done' ? 1 : (typeof job.progress === 'number' ? job.progress : 0)
    if (error) job.error = String(error).slice(0, 300)
    if (outcome === 'done') {
      const listed = Array.isArray(result?.outputs) ? result.outputs.filter((p) => typeof p === 'string') : []
      const existing = []
      for (const p of listed) {
        try {
          const st = await stat(p)
          if (st.isFile()) existing.push(p)
        } catch { /* ignore stale entries */ }
      }
      if (existing.length > 0) {
        job.outputPaths = existing
        delete job.note
      } else {
        const collected = await this.collectOutputs(job)
        job.outputPaths = collected.paths
        if (!collected.foundAny) job.note = '未在输出目录找到译文文件（可查看管线日志）'
        else delete job.note
      }
      if (job.failedParagraphs > 0) {
        job.note = `${job.failedParagraphs} 段翻译失败（对应位置以原文/[翻译失败] 占位）`
      }
    }
    this.children.delete(job.id)
  }

  /**
   * Fallback locator (progress file lost / outputs moved): find the produced
   * files next to the source PDF and copy them into the configured dir.
   */
  async collectOutputs(job) {
    const paths = []
    let foundAny = false
    for (const name of this.jobViewPaths(job).names) {
      const found = await this.locateOutput(job, name)
      if (found === null) continue
      foundAny = true
      let path = found.path
      if (job.outputDir && dirname(path) !== job.outputDir) {
        const target = join(job.outputDir, name)
        try {
          await mkdir(job.outputDir, { recursive: true })
          try {
            await stat(target)
          } catch {
            await copyFile(path, target)
          }
          path = target
        } catch { /* keep the original location */ }
      }
      paths.push(path)
    }
    return { paths, foundAny }
  }

  /* ---------------- translation dispatch ---------------- */

  async resolvePdf(rawPath) {
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) throw new Error('path is required')
    const pdfPath = resolve(rawPath.trim())
    if (!isAbsolute(pdfPath)) throw new Error('path must be absolute')
    if (!/\.pdf$/i.test(pdfPath)) throw new Error('path must point to a .pdf file')
    const st = await stat(pdfPath)
    if (!st.isFile()) throw new Error('path is not a file')
    if (st.size > MAX_PDF_BYTES) throw new Error('PDF larger than 100 MB')
    return pdfPath
  }

  optionalPages(value) {
    if (value === undefined || value === null || value === '') return undefined
    const pages = String(value).replace(/\s+/g, '')
    if (!PAGES_SPEC.test(pages)) throw new Error('pages must look like "1-8" or "1,3,5-9"')
    return pages
  }

  async extract(pdfPath, pages) {
    const args = [join(SKILL_SRC_DIR, 'extract.py'), pdfPath]
    if (pages) args.push('--pages', pages)
    const out = await this.runPython(args, 120_000)
    const line = out.trim().split('\n').pop() ?? ''
    const m = /^OK\s+(\S+)\s+pages=(\d+)\s+chars=(\d+)/.exec(line)
    if (!m) throw new Error(`unexpected extractor output: ${line || '(empty)'}`)
    const outPath = m[1]
    let preview = ''
    try { preview = (await readFile(outPath, 'utf8')).slice(0, MAX_PREVIEW_CHARS) } catch { /* non-fatal */ }
    return { outPath, pages: Number(m[2]), chars: Number(m[3]), preview }
  }

  /* ---------------- model catalog (dsh 的完整 API 注册表) ---------------- */

  async modelCatalogSafe() {
    try {
      const sessionController = this.ctx.get('sessionController')
      if (typeof sessionController?.modelCatalog !== 'function') return null
      return await sessionController.modelCatalog()
    } catch {
      return null
    }
  }

  catalogGroups(catalog) {
    const routable = Array.isArray(catalog?.routableProviders) && catalog.routableProviders.length > 0
      ? catalog.routableProviders
      : null
    return (catalog?.groups ?? []).filter((g) => (g.models ?? []).length > 0 && (routable === null || routable.includes(g.id)))
  }

  isSelectionAvailable(catalog, sel) {
    return sel?.provider && sel?.model
      ? this.catalogGroups(catalog).some((g) => g.id === sel.provider && (g.models ?? []).some((m) => m.id === sel.model))
      : false
  }

  /** Automatic default: prefer a locally deployed provider, else the host default. */
  pickDefaultSelection(catalog) {
    if (catalog == null) return { selection: null, note: '模型目录不可用，无法确定翻译端点' }
    const groups = this.catalogGroups(catalog)
    const local = groups.find((g) => /local|self|vllm|ollama|本地/i.test(`${g.id} ${g.name ?? ''}`))
    if (local !== undefined) return { selection: { provider: local.id, model: local.models[0].id }, note: '' }
    if (typeof catalog.default?.provider === 'string' && typeof catalog.default?.model === 'string') {
      return { selection: { provider: catalog.default.provider, model: catalog.default.model }, note: '' }
    }
    if (groups.length > 0) return { selection: { provider: groups[0].id, model: groups[0].models[0].id }, note: '' }
    return { selection: null, note: '模型目录为空，无法确定翻译端点' }
  }

  /** explicit body override > saved setting > auto (local-first) default. */
  async resolveModelSelection(requested) {
    const catalog = await this.modelCatalogSafe()
    if (requested?.provider && requested?.model) {
      if (this.isSelectionAvailable(catalog, requested)) return { selection: requested, note: '', explicit: true }
      return { selection: this.pickDefaultSelection(catalog).selection, note: `指定的 API ${requested.provider}/${requested.model} 不在当前模型目录，已回退默认`, explicit: false }
    }
    const saved = this.settings.model
    if (saved.provider && saved.model) {
      if (this.isSelectionAvailable(catalog, saved)) return { selection: { ...saved }, note: '', explicit: true }
      const fb = this.pickDefaultSelection(catalog)
      return { selection: fb.selection, note: `配置的 API ${saved.provider}/${saved.model} 当前不可用（已下线或移除），已回退默认${fb.selection ? `：${fb.selection.provider}/${fb.selection.model}` : ''}`, explicit: false }
    }
    // Auto mode: local-first, then the host default, then every catalog group;
    // probe each candidate whose profile carries a baseURL and skip dead ones.
    const candidates = []
    const groups = this.catalogGroups(catalog)
    const local = groups.find((g) => /local|self|vllm|ollama|本地/i.test(`${g.id} ${g.name ?? ''}`))
    if (local) candidates.push({ provider: local.id, model: local.models[0]?.id })
    if (typeof catalog?.default?.provider === 'string' && typeof catalog?.default?.model === 'string') {
      candidates.push({ provider: catalog.default.provider, model: catalog.default.model })
    }
    for (const g of groups) candidates.push({ provider: g.id, model: g.models[0]?.id })
    const uniq = []
    for (const c of candidates) {
      if (c.provider && c.model && !uniq.some((u) => u.provider === c.provider && u.model === c.model)) uniq.push(c)
    }
    const skipped = []
    for (const cand of uniq) {
      const base = this.providerBase(cand.provider)
      if (base !== '') {
        const probe = await this.probeBaseUrl(base)
        if (!probe.ok) { skipped.push(`${cand.provider}${probe.timedOut ? '(超时)' : ''}`); continue }
      }
      return { selection: cand, note: skipped.length > 0 ? `已跳过不可达 API：${skipped.join('、')}` : '', explicit: false }
    }
    if (uniq.length > 0) {
      return { selection: uniq[0], note: `候选 API 均不可达${skipped.length > 0 ? `（${skipped.join('、')}）` : ''}，翻译可能失败 — 请启动模型服务或在设置中更换 API 后「重试」`, explicit: false }
    }
    return { selection: null, note: '模型目录为空，无法确定翻译端点', explicit: false }
  }

  /**
   * Provider profile: user settings layer first, then the merged effective
   * value (covers providers defined outside the user layer). Null if absent.
   */
  providerProfile(provider) {
    const user = this.userProviderProfiles()[provider]
    if (user !== undefined && user !== null) return user
    try {
      const view = this.findLlmView(this.settingsService())
      const merged = view?.value?.providers ?? {}
      const prof = merged[provider]
      return prof && typeof prof === 'object' ? prof : null
    } catch {
      return null
    }
  }

  /** Base URL a provider profile publishes, or ''. */
  providerBase(provider) {
    const prof = this.providerProfile(provider)
    return typeof prof?.baseURL === 'string' ? prof.baseURL : ''
  }

  /**
   * Plaintext API key for a credential ref: host env → dsh credentials file
   * (`refs:` block). Best-effort; '' means "send unauthenticated".
   */
  async resolveApiKey(ref) {
    if (typeof ref !== 'string' || ref === '' || !/^[A-Z0-9_]+$/.test(ref)) return ''
    const fromEnv = process.env[ref]
    if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
    try {
      const raw = await readFile(join(dshHome(), '.credentials.yaml'), 'utf8')
      const m = new RegExp(`^\\s*${ref}\\s*:\\s*(\\S.*)$`, 'm').exec(raw)
      if (m) return m[1].trim().replace(/^["'](.*)["']$/, '$1')
    } catch { /* credentials file unreadable */ }
    return ''
  }

  /**
   * Liveness probe for a model endpoint. Any HTTP status counts as reachable —
   * only network-level failures (connection refused / DNS / timeout) say the
   * service is down. Never throws.
   */
  async probeBaseUrl(base) {
    const trimmed = String(base ?? '').replace(/\/+$/, '')
    if (trimmed === '') return { ok: true }
    const roots = trimmed.endsWith('/v1') ? [trimmed] : [trimmed, `${trimmed}/v1`]
    let timedOut = false
    for (const root of roots) {
      try {
        const resp = await fetch(`${root}/models`, { method: 'GET', signal: AbortSignal.timeout(3_000) })
        return { ok: true, status: resp.status }
      } catch (error) {
        if (/TimeoutError|AbortError/.test(String(error?.name ?? ''))) timedOut = true
      }
    }
    return { ok: false, timedOut }
  }

  /* ---------------- provider management (add/remove/discover via dsh seams) ---------------- */

  settingsService() {
    const settings = this.ctx.get('settings')
    if (settings?.mutate === undefined || settings?.describe === undefined) {
      throw new Error('host 未提供 settings 服务（无法管理模型配置）')
    }
    return settings
  }

  hasSettingsService() {
    try {
      const settings = this.ctx.get('settings')
      return settings?.mutate !== undefined && settings?.describe !== undefined
    } catch {
      return false
    }
  }

  /** The live `llm-pi-ai` namespace view (value + user layer + revision + applies). */
  findLlmView(settings) {
    try {
      const described = settings.describe({ redactSecrets: true })
      const list = Array.isArray(described) ? described : (Array.isArray(described?.namespaces) ? described.namespaces : [])
      return list.find((entry) => entry?.ns === LLM_SETTINGS_NS) ?? null
    } catch {
      return null
    }
  }

  /** CAS write into llm-pi-ai.providers with re-read retries on revision conflict. */
  async mutateLlmSection(ops) {
    const settings = this.settingsService()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const view = this.findLlmView(settings)
      if (view == null) throw new Error(`未找到 ${LLM_SETTINGS_NS} 设置命名空间`)
      try {
        return await settings.mutate(LLM_SETTINGS_NS, ops, view.revision)
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        if ((typeof error?.code === 'string' && /conflict/i.test(error.code)) || /conflict|revision/i.test(text)) continue
        throw error
      }
    }
    throw new Error('settings 版本冲突（有并发修改），请重试')
  }

  /** User-layer provider profiles — the ones settings.yaml-level additions (deletable here). */
  userProviderProfiles() {
    try {
      const view = this.findLlmView(this.settingsService())
      const user = view?.user?.providers ?? {}
      return user && typeof user === 'object' ? user : {}
    } catch {
      return {}
    }
  }

  async waitForProviderRoute(provider, attempts = 12, delayMs = 400) {
    for (let i = 0; i < attempts; i += 1) {
      const catalog = await this.modelCatalogSafe()
      if (catalog?.groups?.some((g) => g.id === provider)) return true
      await new Promise((ok) => setTimeout(ok, delayMs))
    }
    return false
  }

  /** Probe a model endpoint without storing anything (draft discovery). */
  async discoverModels(body) {
    const baseURL = String(body.baseURL ?? '').trim()
    let url
    try { url = new URL(baseURL) } catch { throw new Error('服务地址需为完整 URL，如 http://127.0.0.1:8000/v1') }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('服务地址需为 http(s) URL')
    const api = typeof body.api === 'string' && ADDABLE_APIS.has(body.api.trim()) ? body.api.trim() : undefined
    const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() !== '' ? body.apiKey.trim() : undefined
    const provider = typeof body.provider === 'string' && PROVIDER_ID.test(body.provider.trim().toLowerCase()) ? body.provider.trim().toLowerCase() : undefined
    const llm = this.ctx.get('llm')
    if (typeof llm?.discoverModels !== 'function') throw new Error('host 未提供模型探测服务（llm.discoverModels）')
    const models = await llm.discoverModels(
      LLM_SETTINGS_NS,
      { baseURL: url.toString(), ...(api ? { api } : {}), ...(apiKey ? { apiKey } : {}), ...(provider ? { provider } : {}) },
      AbortSignal.timeout(20_000),
    )
    if (!Array.isArray(models)) return { ok: true, models: [] }
    return {
      ok: true,
      models: models.slice(0, 100).map((m) => ({
        id: String(m?.id ?? ''),
        name: m?.name ? String(m.name) : String(m?.id ?? ''),
        ...(Number.isFinite(m?.contextWindow) ? { contextWindow: Math.floor(m.contextWindow) } : {}),
      })).filter((m) => m.id !== ''),
    }
  }

  /** Register a new OpenAI/Anthropic-compatible provider into dsh settings (hot). */
  async addModelProfile(body) {
    const provider = String(body.provider ?? '').trim().toLowerCase()
    if (!PROVIDER_ID.test(provider)) throw new Error('API 标识需为 2–41 位小写字母/数字/-/_，且以字母开头')
    const displayName = String(body.displayName ?? '').trim() || provider
    const api = String(body.api ?? 'openai-completions').trim()
    if (!ADDABLE_APIS.has(api)) throw new Error(`协议需为 ${[...ADDABLE_APIS].join(' / ')}`)
    const baseURL = String(body.baseURL ?? '').trim().replace(/\/+$/, '')
    let url
    try { url = new URL(baseURL) } catch { throw new Error('服务地址需为完整 URL，如 http://127.0.0.1:8000/v1') }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('服务地址需为 http(s) URL')
    const rawModels = Array.isArray(body.models) ? body.models.slice(0, 50) : []
    const models = []
    for (const entry of rawModels) {
      const id = String(typeof entry === 'string' ? entry : entry?.id ?? '').trim()
      if (id === '' || models.some((m) => m.id === id)) continue
      const model = { id }
      const name = String(entry?.name ?? '').trim()
      if (name !== '' && name !== id) model.name = name
      const cw = Number(entry?.contextWindow)
      if (Number.isFinite(cw) && cw >= 1024) model.contextWindow = Math.floor(cw)
      models.push(model)
    }
    if (models.length === 0) throw new Error('至少需要一个模型 id（点「获取模型」或每行一个手动填写）')
    if (this.userProviderProfiles()[provider] !== undefined) {
      throw new Error(`API 标识 "${provider}" 已存在（请先在卡片上删除，或换一个标识）`)
    }
    const ref = `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
    const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
    if (key !== '') {
      const credentials = this.ctx.get('credentials')
      if (typeof credentials?.set !== 'function') throw new Error('host 未提供 credentials 服务，无法保存 API Key')
      await credentials.set(ref, key)
    }
    const profile = {
      ...(key !== '' ? { apiKeyEnv: ref } : {}),
      displayName,
      api,
      baseURL,
      models,
    }
    try {
      await this.mutateLlmSection([{ op: 'set', path: ['providers', provider], value: profile }])
    } catch (error) {
      if (key !== '') {
        try { await this.ctx.get('credentials')?.unset?.(ref) } catch { /* best effort */ }
      }
      throw new Error(`写入模型配置失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const live = await this.waitForProviderRoute(provider)
    return { ok: true, provider, displayName, api, baseURL, models: models.map((m) => m.id), keyRef: key !== '' ? ref : '', live }
  }

  /** Remove a user-layer provider profile (and its derived credential when we own the name). */
  async removeModelProfile(body) {
    const provider = String(body.provider ?? '').trim().toLowerCase()
    if (!PROVIDER_ID.test(provider)) throw new Error('非法的 API 标识')
    const existing = this.userProviderProfiles()[provider]
    if (existing === undefined) throw new Error(`"${provider}" 不在用户设置层，无法从这里删除`)
    await this.mutateLlmSection([{ op: 'unset', path: ['providers', provider] }])
    let keyRemoved = false
    const ref = typeof existing?.apiKeyEnv === 'string' ? existing.apiKeyEnv : ''
    if (ref !== '' && ref === `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`) {
      try {
        await this.ctx.get('credentials')?.unset?.(ref)
        keyRemoved = true
      } catch { /* profile is gone; key removal is cosmetic */ }
    }
    return { ok: true, provider, keyRemoved }
  }

  async translate(input) {
    const pdfPath = await this.resolvePdf(input.path)
    const outputDir = await this.ensureOutputDir()
    const outDir = outputDir || dirname(pdfPath)
    const { selection, note } = await this.resolveModelSelection(input.model)
    const title = `[pdf2zh] ${basename(pdfPath)}`
    const job = {
      id: randomUUID(),
      pdfPath,
      pdfName: basename(pdfPath),
      title,
      cwd: outDir,
      outputDir,
      provider: selection?.provider ?? '',
      model: selection?.model ?? '',
      modelNote: note,
      pages: input.pages ?? '',
      bilingual: input.bilingual === true,
      appendix: input.appendix === true,
      sourceChars: Number.isFinite(input.sourceChars) && input.sourceChars > 0 ? Math.floor(input.sourceChars) : 0,
      status: 'running',
      createdAt: Date.now(),
      endedAt: undefined,
      error: undefined,
      progress: 0.02,
      phase: '排队中',
      outputPaths: [],
      childPid: 0,
      timeoutAt: Date.now() + this.settings.timeoutMinutes * 60_000,
    }
    const failFast = (message) => {
      job.status = 'failed'
      job.endedAt = Date.now()
      job.error = String(message).slice(0, 300)
      this.addJob(job)
      throw new Error(job.error)
    }
    // The pipeline talks to one concrete endpoint: resolve it or fail loudly.
    if (selection === null) {
      failFast('无法确定翻译端点（模型目录不可用）：请在「⚙ 设置 → 模型 API」选择一个 API 后重试')
    }
    const profile = this.providerProfile(job.provider)
    const baseURL = typeof profile?.baseURL === 'string' ? profile.baseURL.trim() : ''
    if (baseURL === '') {
      failFast(`API ${job.provider} 未显式配置 baseURL，快速管线需要 OpenAI/Anthropic 兼容端点：请在设置中换用其它 API`)
    }
    const probe = await this.probeBaseUrl(baseURL)
    if (!probe.ok) {
      failFast(`API ${job.provider} 不可达（${baseURL}${probe.timedOut ? '，连接超时' : '，连接被拒绝'}）：请启动模型服务，或在设置弹窗换用其它 API 后点「重试」`)
    }
    try {
      await mkdir(this.jobsDir, { recursive: true })
      job.progressPath = this.jobProgressPath(job)
      job.logPath = this.jobLogPath(job)
      let fd = 'ignore'
      try { fd = openSync(job.logPath, 'a') } catch { /* log file optional */ }
      const child = spawn(this.config.python, [join(PIPELINE_DIR, 'run_pipeline.py')], {
        cwd: outDir,
        // detached = new process group: survives a dsh-web restart, and the
        // board re-adopts it through the progress file (pid + stage).
        detached: true,
        stdio: ['ignore', fd, fd],
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: homedir(),
          LANG: process.env.LANG ?? 'C.UTF-8',
          PDF2ZH_PDF: pdfPath,
          PDF2ZH_OUT_DIR: outDir,
          PDF2ZH_PROGRESS_PATH: job.progressPath,
          PDF2ZH_PAGES: job.pages,
          PDF2ZH_BILINGUAL: job.bilingual ? '1' : '',
          PDF2ZH_VLLM_URL: baseURL,
          PDF2ZH_API: profile.api === 'anthropic-messages' ? 'anthropic' : 'openai',
          PDF2ZH_MODEL: job.model,
          PDF2ZH_API_KEY: await this.resolveApiKey(profile.apiKeyEnv),
          PDF2ZH_CONCURRENCY: String(this.settings.concurrency),
          PDF2ZH_GLOSSARY: join(this.config.skillDir, 'glossary.md'),
        },
      })
      if (typeof fd === 'number') closeSync(fd)
      child.once('error', () => { /* watcher settles via missing/stale progress */ })
      child.unref()
      job.childPid = child.pid ?? 0
      if (job.childPid > 0) this.children.set(job.id, job.childPid)
    } catch (error) {
      failFast(`启动翻译进程失败：${error instanceof Error ? error.message : String(error)}`)
    }
    this.addJob(job)
    return {
      jobId: job.id,
      title,
      provider: job.provider,
      model: job.model,
      modelNote: job.modelNote,
      outputDir: outDir,
      pipeline: true,
    }
  }

  /** Remove a job's progress/log files (best effort). */
  async cleanupJobFiles(job) {
    for (const base of [this.jobProgressPath(job), this.jobLogPath(job)]) {
      for (const p of [base, `${base}.tmp`]) {
        try { await unlink(p) } catch { /* absent */ }
      }
    }
  }

  /** Re-dispatch a finished/failed job with its stored params; replaces the old card. */
  async retryJob(rawId) {
    const id = String(rawId ?? '')
    const old = this.jobs.find((j) => j.id === id)
    if (!old) throw new Error('任务不存在')
    if (old.status === 'running') throw new Error('进行中的任务不能重试')
    let result
    try {
      result = await this.translate({
        path: old.pdfPath,
        pages: this.optionalPages(old.pages),
        bilingual: old.bilingual === true,
        appendix: old.appendix === true,
        sourceChars: old.sourceChars,
      })
    } catch (error) {
      // translate() records its own failure; retire the stale card either way.
      this.jobs = this.jobs.filter((j) => j.id !== id)
      await this.saveJobs()
      await this.cleanupJobFiles(old)
      throw error
    }
    this.jobs = this.jobs.filter((j) => j.id !== id)
    await this.saveJobs()
    await this.cleanupJobFiles(old)
    return { ...result, retriedFrom: id }
  }

  readBody(req) {
    return new Promise((resolvePromise, rejectPromise) => {
      let size = 0
      const chunks = []
      let rejected = false
      req.on('data', (chunk) => {
        if (rejected) return
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          rejected = true
          rejectPromise(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (rejected) return
        if (chunks.length === 0) { resolvePromise({}); return }
        try {
          resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        } catch {
          rejectPromise(new Error('body must be JSON'))
        }
      })
      req.on('error', (e) => {
        if (!rejected) {
          rejected = true
          rejectPromise(e)
        }
      })
    })
  }

  /** Read a raw binary body (PDF upload) with its own, larger byte cap. */
  readRawBody(req, maxBytes) {
    return new Promise((resolvePromise, rejectPromise) => {
      let size = 0
      const chunks = []
      let rejected = false
      req.on('data', (chunk) => {
        if (rejected) return
        size += chunk.length
        if (size > maxBytes) {
          rejected = true
          rejectPromise(new Error('file too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (rejected) return
        resolvePromise(Buffer.concat(chunks))
      })
      req.on('error', (e) => {
        if (!rejected) {
          rejected = true
          rejectPromise(e)
        }
      })
    })
  }

  /** Reduce an uploaded filename to a safe basename (keeps CJK, drops path + control chars). */
  sanitizeFilename(raw) {
    let name = typeof raw === 'string' ? raw : ''
    name = name.replace(/[\r\n\t]/g, ' ').trim()
    name = name.split(/[\\/]/).pop() || ''
    name = name.replace(/[^\w.\-\u4e00-\u9fff]+/g, '_').replace(/^_+|_+$/g, '')
    return name
  }

  /** Store an uploaded PDF; de-duping existing names with -1, -2, … suffixes. */
  async storeUpload(filename, buf) {
    let name = this.sanitizeFilename(filename)
    if (!/\.pdf$/i.test(name)) {
      name = `${name.replace(/\.pdf$/i, '') || 'upload'}.pdf`
    }
    if (name === '.pdf' || name === '') name = `upload-${Date.now()}.pdf`
    await mkdir(this.config.uploadDir, { recursive: true })
    let target = join(this.config.uploadDir, name)
    for (let i = 1; await stat(target).then(() => true, () => false); i += 1) {
      target = join(this.config.uploadDir, name.replace(/\.pdf$/i, `-${i}.pdf`))
    }
    await writeFile(target, buf)
    return target
  }

  /** Persist edited glossary text and return the recomputed term count. */
  async saveGlossary(text) {
    const path = join(this.config.skillDir, 'glossary.md')
    await mkdir(this.config.skillDir, { recursive: true })
    await writeFile(path, text, { mode: 0o644 })
    const terms = text.split('\n').filter((l) => {
      const i = l.indexOf(':')
      return i > 0 && !/[\u4e00-\u9fff`]/.test(l.slice(0, i))
    }).length
    return { path, terms }
  }

  sendJson(res, status, body) {
    const json = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(json),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(json)
  }

  async handle(req, res) {
    if (!this.config.enabled) {
      this.sendJson(res, 503, { error: 'pdf2zh plugin disabled' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const sub = url.pathname.slice(this.config.apiPath.length).replace(/\/+$/, '')
    try {
      if (req.method === 'GET' && sub === '/health') {
        this.sendJson(res, 200, {
          ok: true,
          version: VERSION,
          python: this.config.python,
          pymupdf: this.pymupdf,
          requests: this.requests,
          skill: this.skill,
          uploadDir: this.config.uploadDir,
          outputDir: this.settings.outputDir,
          timeoutMinutes: this.settings.timeoutMinutes,
          concurrency: this.settings.concurrency,
          pipelineDir: PIPELINE_DIR,
        })
        return
      }
      if (req.method === 'GET' && sub === '/skill') {
        this.sendJson(res, 200, { ok: true, dir: this.skill.dir, synced: this.skill.synced, files: this.skill.files })
        return
      }
      if (req.method === 'GET' && sub === '/glossary') {
        const path = join(this.config.skillDir, 'glossary.md')
        let text = ''
        try { text = await readFile(path, 'utf8') } catch { text = '' }
        // A term line has an ASCII ':' whose key side is CJK-free (skips prose like "格式：…").
        const terms = text.split('\n').filter((l) => {
          const i = l.indexOf(':')
          return i > 0 && !/[\u4e00-\u9fff`]/.test(l.slice(0, i))
        }).length
        this.sendJson(res, 200, { ok: true, terms, text })
        return
      }
      if (req.method === 'GET' && sub === '/settings') {
        this.sendJson(res, 200, { ok: true, ...this.settings })
        return
      }
      if (req.method === 'GET' && sub === '/models') {
        const catalog = await this.modelCatalogSafe()
        if (catalog === null) throw new Error('无法读取模型目录（host 未提供 modelCatalog）')
        const routable = Array.isArray(catalog.routableProviders) ? catalog.routableProviders : []
        let userAdded = {}
        try { userAdded = this.userProviderProfiles() } catch { /* management hidden, listing still works */ }
        this.sendJson(res, 200, {
          ok: true,
          canManage: this.hasSettingsService(),
          default: catalog.default ?? null,
          saved: { ...this.settings.model },
          auto: this.pickDefaultSelection(catalog).selection,
          providers: (catalog.groups ?? []).map((g) => ({
            id: g.id,
            name: g.name ?? g.id,
            routable: routable.length === 0 || routable.includes(g.id),
            userAdded: userAdded[g.id] !== undefined,
            base: typeof userAdded[g.id]?.baseURL === 'string' ? userAdded[g.id].baseURL : '',
            protocol: typeof userAdded[g.id]?.api === 'string' ? userAdded[g.id].api : '',
            hasKey: typeof userAdded[g.id]?.apiKeyEnv === 'string' && userAdded[g.id].apiKeyEnv !== '',
            models: (g.models ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id, description: m.description ?? '' })),
          })),
          failures: catalog.failures ?? [],
        })
        return
      }
      if (req.method === 'POST' && sub === '/models/discover') {
        const body = await this.readBody(req)
        this.sendJson(res, 200, await this.discoverModels(body))
        return
      }
      if (req.method === 'POST' && sub === '/models/add') {
        const body = await this.readBody(req)
        this.sendJson(res, 200, await this.addModelProfile(body))
        return
      }
      if (req.method === 'POST' && sub === '/models/remove') {
        const body = await this.readBody(req)
        this.sendJson(res, 200, await this.removeModelProfile(body))
        return
      }
      if (req.method === 'POST' && sub === '/settings') {
        const body = await this.readBody(req)
        this.sendJson(res, 200, { ok: true, ...(await this.updateSettings(body)) })
        return
      }
      if (req.method === 'GET' && sub === '/jobs') {
        this.sendJson(res, 200, await this.jobsView())
        return
      }
      if (req.method === 'POST' && sub === '/jobs/delete') {
        const body = await this.readBody(req)
        const id = typeof body.id === 'string' ? body.id : ''
        const target = this.jobs.find((j) => j.id === id)
        if (!target) throw new Error('job not found')
        if (target.status === 'running') this.killPipeline(target)
        this.jobs = this.jobs.filter((j) => j.id !== id)
        await this.saveJobs()
        await this.cleanupJobFiles(target)
        this.sendJson(res, 200, { ok: true, removed: id })
        return
      }
      if (req.method === 'POST' && sub === '/jobs/retry') {
        const body = await this.readBody(req)
        this.sendJson(res, 200, { ok: true, ...(await this.retryJob(body.id)) })
        return
      }
      if (req.method === 'POST' && sub === '/jobs/clear') {
        const removed = this.jobs.filter((j) => j.status !== 'running')
        this.jobs = this.jobs.filter((j) => j.status === 'running')
        await this.saveJobs()
        for (const job of removed) await this.cleanupJobFiles(job)
        this.sendJson(res, 200, { ok: true, removed: removed.length })
        return
      }
      if (req.method === 'GET' && sub === '/file') {
        const id = url.searchParams.get('job') ?? ''
        const wanted = resolve(url.searchParams.get('path') ?? '')
        const job = this.jobs.find((j) => j.id === id)
        if (!job) throw new Error('任务不存在')
        const allowed = new Set(job.outputPaths ?? [])
        if (!allowed.has(wanted)) throw new Error('该文件不在任务产出列表中')
        let st
        try {
          st = await stat(wanted)
        } catch {
          throw new Error('文件不存在或已被移动')
        }
        if (!st.isFile()) throw new Error('不是文件')
        const ext = wanted.toLowerCase().split('.').pop()
        const types = { pdf: 'application/pdf', md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8' }
        res.writeHead(200, {
          'content-type': types[ext] ?? 'application/octet-stream',
          'content-length': st.size,
          'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(basename(wanted))}`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        createReadStream(wanted).pipe(res)
        return
      }
      if (req.method === 'POST' && sub === '/extract') {
        const body = await this.readBody(req)
        const pdfPath = await this.resolvePdf(body.path)
        const pages = this.optionalPages(body.pages)
        const result = await this.extract(pdfPath, pages)
        this.sendJson(res, 200, { ok: true, pdfPath, ...result })
        return
      }
      if (req.method === 'POST' && sub === '/translate') {
        const body = await this.readBody(req)
        const result = await this.translate({
          path: body.path,
          pages: this.optionalPages(body.pages),
          bilingual: body.bilingual === true,
          appendix: body.appendix === true,
          sourceChars: body.sourceChars,
          model: body.model && typeof body.model === 'object'
            ? { provider: String(body.model.provider ?? '').trim(), model: String(body.model.model ?? '').trim() }
            : undefined,
          workspace: typeof body.workspace === 'string' && isAbsolute(body.workspace) ? body.workspace : undefined,
        })
        this.sendJson(res, 200, { ok: true, ...result })
        return
      }
      if (req.method === 'POST' && sub === '/upload') {
        const buf = await this.readRawBody(req, MAX_PDF_BYTES)
        if (buf.length === 0) throw new Error('empty file')
        let filename = (req.headers['x-pdf2zh-filename'] ?? '').toString()
        try { filename = decodeURIComponent(filename) } catch { /* keep raw */ }
        const path = await this.storeUpload(filename, buf)
        this.sendJson(res, 200, { ok: true, path, filename: basename(path), bytes: buf.length })
        return
      }
      if (req.method === 'POST' && sub === '/glossary') {
        const body = await this.readBody(req)
        if (typeof body.text !== 'string') throw new Error('text is required')
        const saved = await this.saveGlossary(body.text)
        this.sendJson(res, 200, { ok: true, path: saved.path, terms: saved.terms })
        return
      }
      this.sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      this.sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

function clampTimeout(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MINUTES
  return Math.min(MAX_TIMEOUT_MINUTES, Math.max(10, n))
}

function clampConcurrency(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY
  return Math.min(MAX_CONCURRENCY, Math.max(1, n))
}

export function apply(ctx, config = {}) {
  new Pdf2Zh(ctx, config).start()
}
