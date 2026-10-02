import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { apply } from '../src/index.js'

test('API protocol and error regression checks', () => {
  const python = process.env.PDF2ZH_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  const result = spawnSync(python, ['-X', 'utf8', 'tests/translator.py'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const ocr = spawnSync(python, ['-X', 'utf8', 'tests/ocr.py'], { encoding: 'utf8' })
  assert.equal(ocr.status, 0, ocr.stderr)
})

test('host API, real Python pipeline, recovery and credential safety', { timeout: 90000 }, async () => {
  const python = process.env.PDF2ZH_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  const dir = await mkdtemp(join(tmpdir(), 'pdf2zh-test-'))
  const home = join(dir, 'home')
  const dataDir = join(home, 'pdf2zh', 'desktop')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'sentinel.txt'), 'existing private data')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const pdf = join(dir, 'example 中文 paper.pdf')
  const fixture = spawnSync(python, ['-X', 'utf8', 'tests/fixture.py', pdf], { encoding: 'utf8' })
  assert.equal(fixture.status, 0, fixture.stderr)
  const key = 'test-only-not-a-real-credential'
  let rejectAuth = false
  let requests = 0
  const model = createServer(async (req, res) => {
    if (req.method === 'GET') { res.end(JSON.stringify({ data: [{ id: 'test-model' }] })); return }
    const chunks = []; for await (const c of req) chunks.push(c)
    requests++
    assert.equal(req.headers.authorization, `Bearer ${key}`)
    if (rejectAuth) { res.writeHead(401); res.end(JSON.stringify({ error: key })); return }
    const body = JSON.parse(Buffer.concat(chunks))
    const user = body.messages.at(-1).content
    const text = user.split('\n').filter(l => /^\d+\./.test(l)).map(l => `${l.match(/^\d+/)[0]}. 这是一段用于验证翻译和排版的中文内容，方法保留文档结构并评估准确率。`).join('\n')
    res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }))
  })
  await new Promise(ok => model.listen(0, '127.0.0.1', ok))
  const base = `http://127.0.0.1:${model.address().port}/v1`
  const profiles = { example: { api: 'openai-completions', baseURL: base, apiKeyEnv: 'EXAMPLE_API_KEY' } }
  const catalog = { groups: [{ id: 'example', models: [{ id: 'test-model' }] }], default: { provider: 'example', model: 'test-model' } }
  let handler
  const cleanups = []
  const ctx = {
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    webServer: { register(route) { handler = route.handler; return () => {} } },
    logger: { info() {}, warn(error) { throw error } },
    get(name) {
      if (name === 'sessionController') return { modelCatalog: async () => catalog }
      if (name === 'credentials') return { resolve: async () => ({ value: key }) }
      if (name === 'settings') return { describe: () => [{ ns: 'llm-pi-ai', user: { providers: profiles }, value: { providers: profiles } }], mutate: async () => {} }
    },
  }
  apply(ctx, { python, dataDir, migrateFromHome: true })
  const host = createServer((req, res) => handler(req, res))
  await new Promise(ok => host.listen(0, '127.0.0.1', ok))
  const origin = `http://127.0.0.1:${host.address().port}/api/pdf2zh`
  const call = async (route, body) => {
    const response = await fetch(origin + route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  const terminal = async (id) => {
    for (let i = 0; i < 120; i++) {
      const view = await call('/jobs')
      const j = view.data.jobs.find(j => j.id === id)
      if (j.status !== 'running') return j
      await new Promise(ok => setTimeout(ok, 250))
    }
    throw new Error('Job did not settle')
  }
  try {
    const health = await call('/health'); assert.equal(health.data.ok, true)
    await assert.rejects(stat(join(dataDir, 'desktop')), { code: 'ENOENT' })
    const preview = await call('/extract', { path: pdf }); assert.equal(preview.status, 200); assert.ok(preview.data.chars > 500)
    const invalid = await call('/settings', { python: join(dir, 'missing-python') }); assert.equal(invalid.status, 400)
    assert.equal((await call('/health')).data.ok, true)
    const invalidUpload = await fetch(origin + '/upload', { method: 'POST', body: 'not a pdf' }); assert.equal(invalidUpload.status, 400)
    const bytes = await readFile(pdf)
    const uploads = await Promise.all([1, 2].map(() => fetch(origin + '/upload', { method: 'POST', headers: { 'x-pdf2zh-filename': 'same.pdf' }, body: bytes }).then(r => r.json())))
    assert.notEqual(uploads[0].path, uploads[1].path)
    const first = await call('/translate', { path: pdf, bilingual: true }); assert.equal(first.status, 200, JSON.stringify(first.data))
    assert.equal((await call('/translate', { path: pdf })).status, 400)
    const done = await terminal(first.data.jobId); assert.equal(done.status, 'done', done.error)
    assert.equal(done.outputPaths.length, 3)
    const file = await fetch(origin + '/file?job=' + done.id + '&path=' + encodeURIComponent(done.outputPaths[0])); assert.equal(file.status, 200); await file.arrayBuffer()
    const forbidden = await fetch(origin + '/file?job=' + done.id + '&path=' + encodeURIComponent(pdf)); assert.equal(forbidden.status, 400); await forbidden.json()
    const md = await readFile(done.outputPaths.find(p => p.endsWith('.zh.md')), 'utf8'); assert.match(md, /中文内容/)
    const verify = spawnSync(python, ['-X', 'utf8', 'pipeline/verify.py', pdf, done.outputPaths[0], '--strict'], { encoding: 'utf8' }); assert.equal(verify.status, 0, verify.stderr + verify.stdout)
    console.log(verify.stdout.trim())
    const check = spawnSync(python, ['-X', 'utf8', 'tests/check-layout.py', pdf, done.outputPaths[0]], { encoding: 'utf8' })
    assert.equal(check.status, 0, check.stderr)
    rejectAuth = true
    const failure = await call('/translate', { path: pdf }); const failed = await terminal(failure.data.jobId)
    assert.equal(failed.status, 'failed'); assert.ok(!failed.error.includes(key))
    for (const f of await readdir(join(dataDir, 'jobs'))) assert.ok(!(await readFile(join(dataDir, 'jobs', f), 'utf8')).includes(key), 'credential in job data')
    rejectAuth = false
    const retry = await call('/jobs/retry', { id: failed.id }); assert.equal(retry.status, 200)
    assert.equal((await terminal(retry.data.jobId)).status, 'done')
    const ledger = JSON.parse(await readFile(join(dataDir, 'jobs.json'), 'utf8')); assert.ok(ledger.jobs.length >= 2)
    assert.ok(requests > 0)
  } finally {
    for (const cleanup of cleanups) cleanup()
    host.closeAllConnections(); model.closeAllConnections()
    await new Promise(ok => host.close(ok)); await new Promise(ok => model.close(ok))
    await rm(dir, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})
