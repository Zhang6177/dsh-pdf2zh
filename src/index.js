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
 *       POST /translate     — open a fresh session, queue the pdf2zh prompt, record a job
 *       POST /upload        — drag-drop PDF upload (raw body, filename in x-pdf2zh-filename)
 *       GET  /settings      — current UI settings (output dir / timeout)
 *       POST /settings      — persist UI settings (~/.dsh/pdf2zh/settings.json)
 *       GET  /jobs          — translation job board (statuses + progress)
 *       POST /jobs/delete   — remove one job from the board
 *       POST /jobs/clear    — remove all finished (done/failed) jobs
 *  3. Watch every running translation job through the host session APIs
 *     (sessionController.list polling + sessionQuery turn/end evidence),
 *     persisting the board ledger to ~/.dsh/pdf2zh/jobs.json.
 *
 * Translation itself is done by the session model driven by the skill; this
 * plugin syncs the skill, extracts text, dispatches sessions, and tracks
 * their progress. No external services, no new runtime dependencies.
 */

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from 'schemastery'

export const name = 'pdf2zh'
export const inject = ['webServer', 'sessionController', 'sessionQuery']

const require = createRequire(import.meta.url)
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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
/** Board watcher cadence and how long we tolerate a session that never starts a turn. */
const POLL_INTERVAL_MS = 10_000
const TURN_START_GRACE_MS = 180_000
const DEFAULT_TIMEOUT_MINUTES = 240
const MAX_TIMEOUT_MINUTES = 1440
const MAX_JOBS = 200
/** Chinese bytes per source char in a .zh.md output — rough but monotone, only used for the progress bar. */
const ZH_BYTES_PER_SRC_CHAR = 1.4
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
    this.settings = {
      outputDir: typeof config.outputDir === 'string' ? config.outputDir : '',
      timeoutMinutes: clampTimeout(config.timeoutMinutes),
    }
    this.jobs = []
    this.jobsLoaded = false
    this.processStartedAt = Date.now()
    this.skill = { dir: this.config.skillDir, synced: false, files: [] }
    this.pymupdf = { checked: false, available: false, version: '' }
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
    } catch { /* first boot: keep config defaults */ }
  }

  async saveSettings() {
    await mkdir(this.dataDir, { recursive: true })
    await writeFile(this.settingsPath, JSON.stringify({
      outputDir: this.settings.outputDir,
      timeoutMinutes: this.settings.timeoutMinutes,
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
    const names = [`${stem}.zh.md`]
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

  /** 0..1 progress estimate: output-file growth, or an elapsed-time asymptote. */
  async progressFor(job, now = Date.now()) {
    if (job.status === 'done') return 1
    if (job.status === 'failed') return typeof job.progress === 'number' ? job.progress : 0
    const located = await this.locateOutput(job, `${this.jobViewPaths(job).stem}.zh.md`)
    if (located !== null) {
      if (job.sourceChars > 0) {
        const expected = Math.max(4096, Math.round(job.sourceChars * ZH_BYTES_PER_SRC_CHAR))
        return Math.min(0.99, Math.max(0.03, located.bytes / expected))
      }
      return Math.min(0.92, Math.max(0.05, 0.25 + located.bytes / 150_000))
    }
    const elapsed = Math.max(0, now - job.createdAt)
    return Math.min(0.9, Math.max(0.02, 1 - Math.exp(-elapsed / 900_000)))
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

  /* ---------------- board watcher (session evidence) ---------------- */

  startWatcher() {
    setInterval(() => { void this.pollWatchers() }, POLL_INTERVAL_MS).unref?.()
  }

  async pollWatchers() {
    if (!this.config.enabled || this.polling) return
    const running = this.jobs.filter((j) => j.status === 'running')
    if (running.length === 0) return
    this.polling = true
    try {
      const sessionController = this.ctx.get('sessionController')
      let items
      try {
        const listValue = await sessionController?.list?.({}, AbortSignal.timeout(10_000))
        items = listValue?.items
      } catch { return }
      if (!Array.isArray(items)) return
      const now = Date.now()
      let dirty = false
      for (const job of running) {
        if (now >= (job.timeoutAt ?? job.createdAt + this.settings.timeoutMinutes * 60_000)) {
          const minutes = Math.max(1, Math.round(((job.timeoutAt ?? now) - job.createdAt) / 60_000))
          void this.cancelSession(job.sessionId)
          await this.settleJob(job, 'failed', `翻译超时（超过 ${minutes} 分钟），已尝试终止会话`, now)
          dirty = true
          continue
        }
        const summary = items.find((i) => i?.sessionId === job.sessionId)
        if (summary?.running) {
          if (!job.sawRunning) { job.sawRunning = true; dirty = true }
          continue
        }
        if (summary !== undefined) {
          const evidence = await this.turnEndEvidence(job)
          if (evidence !== null) {
            await this.settleJob(job, evidence.outcome, evidence.error, evidence.endedAt ?? now)
            dirty = true
            continue
          }
          if (summary.error) {
            await this.settleJob(job, 'failed', String(summary.error).slice(0, 300), now)
            dirty = true
            continue
          }
        }
        // Idle without turn evidence: a missing session is fatal after grace;
        // anything else (never started / interrupted by a host restart) also
        // fails once the grace window passes since creation *and* boot.
        if (now - Math.max(job.createdAt, this.processStartedAt) > TURN_START_GRACE_MS) {
          const reason = summary === undefined
            ? '执行会话不存在（可能已被删除）'
            : job.sawRunning
              ? '会话已中断（未找到已完成的 turn 证据）'
              : '会话未启动（宽限期内没有 turn 活动）'
          await this.settleJob(job, 'failed', reason, now)
          dirty = true
        }
      }
      if (dirty) await this.saveJobs()
    } finally {
      this.polling = false
    }
  }

  /**
   * Read the last turn/end event for the job's session. Returns null when no
   * *fresh* evidence exists (missing service, no events, or a pre-job event).
   */
  async turnEndEvidence(job) {
    try {
      const sessionQuery = this.ctx.get('sessionQuery')
      if (typeof sessionQuery?.listEvents !== 'function') return null
      const records = await sessionQuery.listEvents(job.sessionId)
      if (!Array.isArray(records)) return null
      for (let i = records.length - 1; i >= 0; i -= 1) {
        const rec = records[i]
        if (rec?.type !== 'turn/end') continue
        if (typeof rec.time === 'number' && rec.time < job.createdAt - 5_000) return null
        let outcome = 'done'
        let error
        let endedAt = typeof rec.time === 'number' ? rec.time : undefined
        if (typeof sessionQuery.readEvent === 'function' && typeof rec.seq === 'number') {
          try {
            const window = await sessionQuery.readEvent({ sessionId: job.sessionId, seq: rec.seq })
            const ev = window?.target ?? {}
            const reason = ev?.data?.reason
            if (reason?.kind === 'error') {
              outcome = 'failed'
              error = `turn 结束于错误：${String(reason.error?.code ?? 'unknown')} ${String(reason.error?.message ?? '')}`.trim()
            }
            if (typeof ev?.time === 'number') endedAt = ev.time
          } catch { /* keep the index-level evidence */ }
        }
        return { outcome, error, endedAt }
      }
      return null
    } catch {
      return null
    }
  }

  async cancelSession(sessionId) {
    try {
      const sessionController = this.ctx.get('sessionController')
      await sessionController?.cancel?.({ sessionId })
    } catch { /* best effort */ }
  }

  /** Move a job out of 'running': persist the outcome and collect outputs. */
  async settleJob(job, outcome, error, endedAt) {
    job.status = outcome
    job.endedAt = endedAt ?? Date.now()
    job.progress = await this.progressFor(job, job.endedAt)
    if (outcome === 'done') job.progress = 1
    if (error) job.error = String(error).slice(0, 300)
    if (outcome === 'done') {
      const outputs = await this.collectOutputs(job)
      job.outputPaths = outputs.paths
      if (!outputs.foundZh) job.note = '未在输出目录找到 .zh.md 译文文件（会话可能把文件写到了别处）'
      else delete job.note
    }
  }

  /**
   * Locate the produced .zh.md / .en-zh.md. When a save dir is configured but
   * the session wrote next to the source PDF anyway, copy the files over as a
   * fallback so "saved to the chosen location" always holds.
   */
  async collectOutputs(job) {
    const paths = []
    let foundZh = false
    for (const name of this.jobViewPaths(job).names) {
      const found = await this.locateOutput(job, name)
      if (found === null) continue
      if (name.endsWith('.zh.md') && !name.endsWith('.en-zh.md')) foundZh = true
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
    return { paths, foundZh }
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

  async translate(input) {
    const pdfPath = await this.resolvePdf(input.path)
    const sessionController = this.ctx.get('sessionController')
    if (sessionController?.create === undefined) throw new Error('sessionController is not available in this host')
    const outputDir = await this.ensureOutputDir()
    const cwd = input.workspace && isAbsolute(input.workspace)
      ? resolve(input.workspace)
      : (outputDir || dirname(pdfPath))
    const title = `[pdf2zh] ${basename(pdfPath)}`
    const job = {
      id: randomUUID(),
      pdfPath,
      pdfName: basename(pdfPath),
      title,
      sessionId: '',
      cwd,
      outputDir,
      pages: input.pages ?? '',
      bilingual: input.bilingual === true,
      appendix: input.appendix === true,
      sourceChars: Number.isFinite(input.sourceChars) && input.sourceChars > 0 ? Math.floor(input.sourceChars) : 0,
      status: 'running',
      createdAt: Date.now(),
      endedAt: undefined,
      error: undefined,
      progress: 0,
      sawRunning: false,
      outputPaths: [],
      timeoutAt: Date.now() + this.settings.timeoutMinutes * 60_000,
    }
    let created
    try {
      created = await sessionController.create({ cwd })
      if (created?.sessionId === undefined) throw new Error('sessionController.create returned no sessionId')
      job.sessionId = String(created.sessionId)
    } catch (error) {
      job.status = 'failed'
      job.endedAt = Date.now()
      job.error = `创建会话失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 300)
      this.addJob(job)
      throw new Error(job.error)
    }
    try {
      await sessionController.rename({ sessionId: created.sessionId, title })
    } catch { /* cosmetic only */ }
    const options = []
    if (input.pages) options.push(`只翻 ${input.pages} 页`)
    if (input.bilingual) options.push('中英对照')
    if (input.appendix) options.push('含附录')
    if (outputDir) options.push(`所有产出文件保存到目录 ${outputDir}`)
    const text = [
      `请使用 pdf2zh 技能把这篇论文翻译成中文：${pdfPath}`,
      options.length ? `要求：${options.join('，')}。` : '',
      outputDir
        ? `输出路径：把 <同名>.zh.md${input.bilingual ? '、<同名>.en-zh.md' : ''} 和提取的 .txt 都保存到 ${outputDir}（本会话工作区），不要写回源 PDF 所在目录。`
        : '',
      '按技能流程执行：先运行提取脚本并抽查文本质量，再逐节翻译写入 <同名>.zh.md，最后汇报输出文件路径与本次新增术语。',
    ].filter(Boolean).join('\n')
    try {
      await sessionController.prompt({
        sessionId: created.sessionId,
        requestId: randomUUID(),
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, AbortSignal.timeout(30_000))
    } catch (error) {
      job.status = 'failed'
      job.endedAt = Date.now()
      job.error = `会话已创建但提示被拒绝：${error instanceof Error ? error.message : String(error)}`.slice(0, 300)
      this.addJob(job)
      throw new Error(job.error)
    }
    this.addJob(job)
    return { sessionId: created.sessionId, cwd, title, jobId: job.id }
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
          skill: this.skill,
          uploadDir: this.config.uploadDir,
          outputDir: this.settings.outputDir,
          timeoutMinutes: this.settings.timeoutMinutes,
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
        const before = this.jobs.length
        this.jobs = this.jobs.filter((j) => j.id !== id)
        if (this.jobs.length === before) throw new Error('job not found')
        await this.saveJobs()
        this.sendJson(res, 200, { ok: true, removed: id })
        return
      }
      if (req.method === 'POST' && sub === '/jobs/clear') {
        const before = this.jobs.length
        this.jobs = this.jobs.filter((j) => j.status === 'running')
        await this.saveJobs()
        this.sendJson(res, 200, { ok: true, removed: before - this.jobs.length })
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

export function apply(ctx, config = {}) {
  new Pdf2Zh(ctx, config).start()
}
