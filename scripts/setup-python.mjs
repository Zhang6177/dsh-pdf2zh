import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const venv = resolve(option('--venv') || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'python-envs', 'pdf2zh'))
const python = join(venv, ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']))
function run(bin, params) {
  const r = spawnSync(bin, params, { stdio: 'inherit', windowsHide: true })
  if (r.error || r.status !== 0) throw new Error(`Command failed: ${bin}. Check Python installation and network access.`)
}
try {
  if (!existsSync(python)) {
    const explicit = option('--python')
    const candidates = explicit ? [[explicit, []]] : process.platform === 'win32' ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]]
    const selected = candidates.find(([bin, prefix]) => spawnSync(bin, [...prefix, '-c', 'import sys; assert sys.version_info >= (3,10)'], { windowsHide: true, stdio: 'ignore' }).status === 0)
    if (!selected) throw new Error('Install 64-bit Python >= 3.10, or pass --python /path/to/python.')
    run(selected[0], [...selected[1], '-m', 'venv', venv])
  }
  const req = args.includes('--layout') ? 'requirements-layout.txt' : 'requirements.txt'
  run(python, ['-X', 'utf8', '-m', 'pip', 'install', '-r', join(root, 'pipeline', req)])
  run(python, ['-X', 'utf8', '-c', 'import pymupdf,requests; print("Python dependencies OK")'])
  console.log(`Python: ${python}\nIf DSH uses a different data home, paste this path into PDF translation Settings > Output and performance > Python.`)
} catch (error) { console.error(error.message); process.exitCode = 1 }
