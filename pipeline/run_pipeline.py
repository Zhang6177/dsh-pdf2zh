#!/usr/bin/env python3
"""dsh-pdf2zh 快速翻译管线（v0.8）：提取 → 分段并发翻译（关思考） → 排版保真渲染。

由插件宿主以 `detached` 子进程方式启动（脱离宿主会话组，宿主重启不影响在途任务）。
全部参数走环境变量；进度与结果写入 PDF2ZH_PROGRESS_PATH 指向的 JSON 文件
（原子替换），宿主看板轮询该文件。stdout/stderr 归日志文件，仅供排错。

必需 env：
  PDF2ZH_PDF            源 PDF 绝对路径
  PDF2ZH_OUT_DIR        产出目录（宿主已建好）
  PDF2ZH_PROGRESS_PATH  进度/结果 JSON 路径
  PDF2ZH_VLLM_URL / PDF2ZH_MODEL / PDF2ZH_API / PDF2ZH_API_KEY   模型端点
可选 env：
  PDF2ZH_PAGES          页码规格 "1-8" / "1,3"
  PDF2ZH_BILINGUAL      "1" 时额外产出 <stem>.en-zh.md
  PDF2ZH_CONCURRENCY    篇内并发请求数（默认 8）
  PDF2ZH_GLOSSARY / PDF2ZH_TEMPERATURE / PDF2ZH_CJK_FONT
"""
import json
import os
import re
import sys
import tempfile
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import pymupdf as fitz  # noqa: E402  (系统 python3 已有；渲染/提取共用)

import translate as T  # noqa: E402
import render as R  # noqa: E402
from extract import extract_paper  # noqa: E402

PROGRESS = os.environ.get("PDF2ZH_PROGRESS_PATH", "")
_OUT_RAW = os.environ.get("PDF2ZH_OUT_DIR", "")
PDF = os.environ.get("PDF2ZH_PDF", "")
PAGES = (os.environ.get("PDF2ZH_PAGES") or "").strip()
BILINGUAL = os.environ.get("PDF2ZH_BILINGUAL") == "1"

STATE = {"stage": "start", "done": 0, "total": 0, "phase": "启动",
         "pid": os.getpid(), "ts": int(time.time() * 1000)}


def write_progress(final=None):
    """原子写进度文件；final={'ok':bool,...} 时并入 result 供宿主结算。"""
    if not PROGRESS:
        return
    data = dict(STATE)
    data["ts"] = int(time.time() * 1000)
    if final is not None:
        data["result"] = final
    tmp = PROGRESS + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, PROGRESS)
    except OSError:
        pass


def stage(name, phase, done=None, total=None):
    STATE.update(stage=name, phase=phase)
    if done is not None:
        STATE["done"] = done
    if total is not None:
        STATE["total"] = total
    write_progress()
    print("[%s] %s" % (name, phase), flush=True)


def set_pages(doc, spec):
    """解析 "1-8,11" → 0 基索引列表。"""
    idx = []
    for part in re.split(r"[,，]", spec):
        part = part.strip()
        if not part:
            continue
        m = re.match(r"^(\d+)(?:-(\d+))?$", part)
        if not m:
            raise ValueError("页码规格无法解析: %s" % part)
        a = int(m.group(1))
        b = int(m.group(2) or m.group(1))
        if a < 1 or b < a:
            raise ValueError("页码规格非法: %s" % part)
        idx.extend(range(a - 1, min(b, doc.page_count)))
    return sorted(set(idx))


def slice_pdf(path, spec):
    """按页码规格切出临时 PDF；返回 (path, temp|None)。"""
    src = fitz.open(path)
    try:
        idx = set_pages(src, spec)
        if not idx:
            raise ValueError("页码范围内没有可翻译的页")
        if len(idx) == src.page_count:
            return path, None
        out = fitz.open()
        for i in idx:
            out.insert_pdf(src, from_page=i, to_page=i)
        fd, tmp = tempfile.mkstemp(suffix=".pdf", prefix="pdf2zh_pages_")
        os.close(fd)
        out.save(tmp)
        out.close()
        return tmp, tmp
    finally:
        src.close()


def build_markdown(paper, translations, stem):
    """排版保真 PDF 的伴生 Markdown（正文级结构，公式/插图注明见 PDF）。"""
    lines, ref_note_written = [], False
    for pgd in paper.pages:
        for p in pgd.paragraphs:
            if p.is_math:
                lines.append("（公式，见 PDF 原位）")
                lines.append("")
                continue
            if p.is_ref:
                if not ref_note_written:
                    lines.append("> 参考文献（References）未翻译，见原文 / 上方 PDF。")
                    ref_note_written = True
                continue
            if p.is_skip:
                if p.raw:
                    lines.append(p.raw)
                    lines.append("")
                continue
            zh = translations.get(p.pid) or ("[翻译失败] " + p.raw)
            zh = re.sub(r"⟨\d+⟩", "（式）", zh)
            if p.is_heading:
                fs = p.font_size
                level = "#" if fs >= 17 else ("##" if fs >= 13 else "###")
                lines.append("%s %s" % (level, zh))
            else:
                lines.append(zh)
            lines.append("")
    body = "\n".join(lines).strip() + "\n"
    head = "# %s（中文译文）\n\n> 图、公式、表格保持原文与原位，详见同名 PDF。\n\n" % stem
    return head + body


def build_bilingual(paper, translations):
    chunks = []
    for pgd in paper.pages:
        for p in pgd.paragraphs:
            if p.is_math or p.is_ref or p.is_skip or not p.raw:
                continue
            zh = translations.get(p.pid) or "[翻译失败]"
            zh = re.sub(r"⟨\d+⟩", "（式）", zh)
            en = " ".join(p.raw.split())
            chunks.append(en + "\n\n> " + zh)
    return "\n\n".join(chunks) + "\n"


def main():
    if not PDF or not os.path.isfile(PDF):
        raise RuntimeError("PDF2ZH_PDF 未设置或文件不存在")
    out_dir = _OUT_RAW or os.path.dirname(PDF)
    os.makedirs(out_dir, exist_ok=True)
    if os.environ.get("PDF2ZH_CJK_FONT"):
        R.CJK_FONT = os.environ["PDF2ZH_CJK_FONT"]
    if not os.path.exists(R.CJK_FONT):
        raise RuntimeError("缺少中文字体 %s，无法渲染中文版式 PDF" % R.CJK_FONT)

    stage("extract", "解析版式结构", 0, 0)
    work_pdf, tmp_pdf = slice_pdf(PDF, PAGES) if PAGES else (PDF, None)
    t0 = time.time()
    try:
        paper = extract_paper(work_pdf)
        st = paper.stats()
        print("extract: %.1fs %s" % (time.time() - t0, st), flush=True)
        if st["paragraphs"] < 5:
            raise RuntimeError("看起来是扫描版 PDF（无文本层），需要先 OCR 或改用 arXiv 源码")
        sample = "".join(p.text for p in list(paper.all_paragraphs())[:300])
        if sample:
            cjk = sum(1 for c in sample if "\u4e00" <= c <= "\u9fff")
            if cjk / max(len(sample), 1) > 0.2:
                raise RuntimeError("原文已是中文为主，无需翻译")

        paras = paper.translatable_paragraphs()
        tr = T.Translator()
        print("engine: %s %s %s conc=%d" % (tr.api, tr.url, tr.model, T.CONCURRENCY), flush=True)
        if not tr.health():
            raise RuntimeError("模型端点不可用（%s）。请在设置中更换 API 或启动模型服务后重试" % tr.url)

        total = len(paras)
        last_write = [0.0]

        def cb(done, tot):
            STATE.update(done=done, total=tot)
            if time.time() - last_write[0] >= 0.5 or done >= tot:
                last_write[0] = time.time()
                stage("translate", "翻译 %d/%d 段" % (done, tot), done, tot)

        t0 = time.time()
        stage("translate", "翻译 0/%d 段" % total, 0, total)
        translations = tr.translate_paragraphs(paras, cb)
        n_failed = sum(1 for v in translations.values() if v is None)
        print("translate: %.1fs %d paras %d failed" % (time.time() - t0, total, n_failed), flush=True)
        if total and n_failed >= max(2, int(total * 0.7)):
            raise RuntimeError("绝大多数段落翻译失败（端点 %s / 模型 %s）：%s" % (
                tr.url, tr.model, "；".join(tr.errors) or "无错误详情"))

        stage("render", "渲染排版保真 PDF")
        stem = re.sub(r"\.pdf$", "", os.path.basename(PDF), flags=re.I)
        t0 = time.time()
        orig = fitz.open(work_pdf)
        warnings = []
        out_pdf = os.path.join(out_dir, stem + ".zh.pdf")
        n_render_failed = R.render_pdf(paper, translations, orig, out_pdf, warnings)
        orig.close()
        print("render: %.1fs -> %s" % (time.time() - t0, out_pdf), flush=True)

        outputs = [out_pdf]
        md_path = os.path.join(out_dir, stem + ".zh.md")
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(build_markdown(paper, translations, stem))
        outputs.append(md_path)
        if BILINGUAL:
            bz_path = os.path.join(out_dir, stem + ".en-zh.md")
            with open(bz_path, "w", encoding="utf-8") as f:
                f.write(build_bilingual(paper, translations))
            outputs.append(bz_path)

        write_progress(final={
            "ok": True,
            "outputs": outputs,
            "stats": st,
            "failedParagraphs": n_failed + n_render_failed,
            "warnings": warnings[:30],
        })
        print("DONE %.1fs" % (time.time()), flush=True)
    finally:
        if tmp_pdf:
            try:
                os.unlink(tmp_pdf)
            except OSError:
                pass


if __name__ == "__main__":
    try:
        main()
        sys.exit(0)
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        msg = str(exc) or repr(exc)
        msg = re.sub(r"sk-[A-Za-z0-9\-_]{6,}", "sk-***", msg)  # 防 key 泄漏进看板
        write_progress(final={"ok": False, "error": msg[:500]})
        sys.exit(1)
