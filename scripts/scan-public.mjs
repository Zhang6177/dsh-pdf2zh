import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const rules = [
  ['private IPv4', /\b(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['credential token', /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16})\b/],
  ['URL password', /https?:\/\/[^\s/@:]+:[^\s/@]+@/],
  ['personal deployment path', /\/(?:data\d+|home)\/[^\s/"'<>]+\//],
]
const failures = []
let scanned = 0
function check(label, data) {
  scanned++
  for (const [name, pattern] of rules) if (pattern.test(data.toString('utf8'))) failures.push(`${label}: ${name}`)
}
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.venv', 'data', '__pycache__', '.ocr-test-data'].includes(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (!entry.name.endsWith('.tgz')) check(relative('.', path), readFileSync(path))
  }
}
walk('.')
if (process.argv.includes('--history')) {
  const lines = execFileSync('git', ['rev-list', '--objects', '--all'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  for (const line of lines) {
    const id = line.split(' ')[0]
    check(`git object ${id}`, execFileSync('git', ['cat-file', '-p', id], { maxBuffer: 20 * 1024 * 1024 }))
  }
}
for (const message of failures) console.error(message)
console.log(`Scanned ${scanned} files/objects; ${failures.length} findings. Matches are not printed.`)
process.exitCode = failures.length ? 1 : 0
