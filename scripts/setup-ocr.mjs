import { mkdir, writeFile, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const dir = process.env.PDF2ZH_TESSDATA || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'ocr', 'tessdata')
await mkdir(dir, { recursive: true })
for (const language of ['eng', 'chi_sim']) {
  const target = join(dir, `${language}.traineddata`)
  try { if ((await stat(target)).size > 1000000) continue } catch { /* not installed */ }
  let bytes
  for (const url of [
    `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/${language}.traineddata`,
    `https://github.com/tesseract-ocr/tessdata_fast/raw/refs/heads/main/${language}.traineddata`,
  ]) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) })
      if (response.ok) bytes = Buffer.from(await response.arrayBuffer())
    } catch { /* Try system curl, which can use system proxy settings. */ }
    if (!bytes || bytes.length < 1000000) {
      try {
        bytes = execFileSync('curl', ['--silent', '--show-error', '--fail', '--location', '--retry', '2', '--connect-timeout', '15', url], { maxBuffer: 8000000, windowsHide: true })
      } catch { /* Try the other official download URL. */ }
    }
    if (bytes?.length > 1000000) break
  }
  if (!bytes || bytes.length < 1000000) throw new Error(`OCR 数据下载失败，请手动下载 ${language}.traineddata 到 ${dir}`)
  const temporary = join(dir, `${language}.traineddata.${process.pid}.tmp`)
  try {
    await writeFile(temporary, bytes)
    await rename(temporary, target)
  } finally { await rm(temporary, { force: true }) }
}

console.log(`中英文 OCR 数据已安装：${dir}。重新开始翻译即可；识别在本机进行。`)
