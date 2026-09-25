#!/usr/bin/env python3
"""pdf2zh 离线重排版：拿已存档的真实译文转储，用**当前**渲染层重新产出 PDF。

用途：改排版/擦除/字号逻辑时，不必再调一次模型就能验证渲染层改动（几秒~几十秒），
也用于「同一份译文、两版渲染」的严格 A/B。

译文转储由 `run_pipeline.py` 自动写出（`<stem>.zh.translations.json`），v0.13 起带
`src`（源文）字段 —— 据此精确重映射段落，不再依赖 pid（提取逻辑一变 pid 就会漂移）。

用法:
  python3 rerender.py <源.pdf> <译文转储.json> <输出.pdf> [--shrink 1.5]

环境变量与正式管线一致（`PDF2ZH_FONT_SHRINK` / `PDF2ZH_FLOW` / `PDF2ZH_BODY_MARGIN` …）。
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

try:
    import pymupdf as fitz
except ImportError:
    import fitz

from extract import extract_paper       # noqa: E402
import render as R                      # noqa: E402


def load_dump(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def remap(paper, dump):
    """按 src 精确匹配，退化时按几何就近匹配（≤1.5pt）。返回 {pid: 译文} 与统计。"""
    tr, exact, geo = {}, 0, 0
    for pgd in paper.pages:
        old = [q for pg in dump.get("pages", []) if pg["pno"] == pgd.pno
               for q in pg.get("paragraphs", [])]
        bysrc = {q["src"]: q["text"] for q in old if q.get("src")}
        for p in pgd.paragraphs:
            if p.text in bysrc:
                tr[p.pid] = bysrc[p.text]
                exact += 1
                continue
            best, bd = None, 1e9
            for q in old:
                if not q.get("src"):
                    continue
                d = abs(q["y0"] - p.y0) + 0.25 * abs(q["x0"] - p.x0)
                if d < bd:
                    bd, best = d, q
            if best is not None and bd <= 1.5:
                tr[p.pid] = best["text"]
                geo += 1
    return tr, exact, geo


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("dump")
    ap.add_argument("out")
    ap.add_argument("--shrink", type=float,
                    default=float(os.environ.get("PDF2ZH_FONT_SHRINK", "1.5")))
    a = ap.parse_args()

    paper = extract_paper(a.pdf)
    tr, exact, geo = remap(paper, load_dump(a.dump))
    print("重映射：精确 %d 段 / 几何 %d 段（可译 %d 段）"
          % (exact, geo, len(list(paper.translatable_paragraphs()))), flush=True)

    orig = fitz.open(a.pdf)
    warnings = []
    t0 = time.time()
    n_keep = R.render_pdf(paper, tr, orig, a.out, warnings, font_shrink=a.shrink)
    print("render %.1fs → %s（保留原文 %d 段，警告 %d 条）"
          % (time.time() - t0, a.out, n_keep, len(warnings)))
    for w in warnings[:10]:
        print("  warn:", w)
    return 0


if __name__ == "__main__":
    sys.exit(main())
