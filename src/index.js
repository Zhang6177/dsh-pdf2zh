#!/usr/bin/env node
/**
 * dsh-pdf2zh — host entry (plain ESM, no build step).
 *
 * Responsibilities:
 *  1. On every boot, sync the bundled pdf2zh skill (SKILL.md, extract.py)
 *     into the DSH skill directory (`<DSH home>/skills/pdf2zh`), seeding
 *     glossary.md only when absent so the user's accumulated terms survive.
 *  2. Register a small API under /api/pdf2zh (same-origin, loopback only):
 *       GET  /health    — plugin / python / pymupdf / skill status
 *       GET  /skill     — installed skill file listing
 *       GET  /glossary  — current glossary text
 *       POST /extract   — run the PyMuPDF extractor on a server-side PDF path
 *       POST /translate — open a fresh session and queue the pdf2zh skill prompt
 *
 * Translation itself is done by the session model driven by the skill; this
 * plugin only syncs the skill, extracts text, dispatches sessions, and
 * reports status. No external services, no new runtime dependencies.
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
export const inject = ['webServer', 'sessionController']

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
    }
    this.skill = { dir: this.config.skillDir, synced: false, files: [] }
    this.pymupdf = { checked: false, available: false, version: '' }
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
    const cwd = input.workspace && isAbsolute(input.workspace)
      ? resolve(input.workspace)
      : dirname(pdfPath)
    const created = await sessionController.create({ cwd })
    if (created?.sessionId === undefined) throw new Error('sessionController.create returned no sessionId')
    const title = `[pdf2zh] ${basename(pdfPath)}`
    try {
      await sessionController.rename({ sessionId: created.sessionId, title })
    } catch { /* cosmetic only */ }
    const options = []
    if (input.pages) options.push(`只翻 ${input.pages} 页`)
    if (input.bilingual) options.push('中英对照')
    if (input.appendix) options.push('含附录')
    const text = [
      `请使用 pdf2zh 技能把这篇论文翻译成中文：${pdfPath}`,
      options.length ? `要求：${options.join('，')}。` : '',
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
      throw new Error(`session created (${created.sessionId}) but prompt was refused: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { sessionId: created.sessionId, cwd, title }
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
        const terms = text.split('\n').filter((l) => /^[^#\s][^:]*:\s*\S/.test(l)).length
        this.sendJson(res, 200, { ok: true, terms, text })
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
          workspace: typeof body.workspace === 'string' && isAbsolute(body.workspace) ? body.workspace : undefined,
        })
        this.sendJson(res, 200, { ok: true, ...result })
        return
      }
      this.sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      this.sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

export function apply(ctx, config = {}) {
  new Pdf2Zh(ctx, config).start()
}
