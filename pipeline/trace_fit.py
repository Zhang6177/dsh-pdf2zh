#!/usr/bin/env python3
"""pdf2zh 渲染决策诊断：打印每段「落点 / 预算 / 字号 / 是否放弃」，定位残留英文来源。"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import pymupdf as fitz  # noqa: E402
import fitz as _f  # noqa: E402
import replay  # noqa: E402
import render as R  # noqa: E402
from extract import extract_paper  # noqa: E402

orig_pack = R.LAYOUT.pack_windows
_CTX = {"page": 0}


def traced_pack(toks, fs, ratio, width, windows, bold=False):
    plan = orig_pack(toks, fs, ratio, width, windows, bold=bold)
    traced_pack.calls.append((_CTX["page"], round(fs, 2), round(width, 1),
                              len(windows), plan["used"], plan["total"],
                              [round(b - a, 1) for a, b in windows][:6]))
    return plan


traced_pack.calls = []
R.LAYOUT.pack_windows = traced_pack

_orig_render = R.render_pdf


def main():
    pdf = sys.argv[1]
    pages = sys.argv[2] if len(sys.argv) > 2 else ""
    lo, hi = (1, 10 ** 6)
    if pages:
        lo, hi = (int(x) for x in pages.split("-"))
    # 保持整篇结构（render 用 pgd.pno 定位页面），只打印目标页的决策
    paper = extract_paper(pdf)
    translations = {}
    for pg in paper.pages:
        for p in pg.paragraphs:
            if p.is_math or p.is_ref or p.is_skip:
                continue
            translations[p.pid] = replay.synth(p.text, 0.60)

    # 目标页逐段前置条件（定位「段落为何没进入排版」）
    for pg in paper.pages:
        if not (lo <= pg.pno <= hi):
            continue
        for p in pg.paragraphs:
            t = translations.get(p.pid)
            toks = R.FIT.split_markers(R._norm(t), p.math_rects) if t else []
            zh = " ".join(tk[1] for tk in toks if tk[0] == "w")
            sp = tuple(round(v, 1) for v in R._paragraph_span(pg, p)) if p.lines else "-"
            print("  前置 p%d pid%-4s col=%d lines=%2d math=%s skip=%s ref=%s "
                  "tr=%s cjk=%s span=%s"
                  % (pg.pno, p.pid[1], p.col, len(p.lines), p.is_math, p.is_skip,
                     p.is_ref, "有" if t else "无",
                     R._is_cjk_text(zh) if zh else "-", sp))

    out = "/tmp/pdf2zh_trace.zh.pdf"
    with open(pdf, "rb") as fh:
        orig = fitz.open(stream=fh.read(), filetype="pdf")
    _orig_ps = R._paragraph_span
    _SP = {}

    def traced_ps(pgd, p):
        v = _orig_ps(pgd, p)
        _SP[(pgd.pno, p.pid[1])] = (round(v[0], 1), round(v[1], 1), p.col,
                                    round(p.x0, 1), round(p.x1, 1),
                                    round(min((l.x0 for l in p.lines), default=0), 1),
                                    round(max((l.x1 for l in p.lines), default=0), 1))
        _CTX["page"] = pgd.pno
        return v

    R._paragraph_span = traced_ps
    R.render_pdf(paper, translations, orig, out, [], font_shrink=1.5)
    R._paragraph_span = _orig_ps
    print("=== 段落 span (页,pid) -> (x0,x1) col bbox [lx0-lx1] ===")
    for k in sorted(_SP):
        if lo <= k[0] <= hi:
            print("   p%-3d pid%-4s %s" % (k[0], k[1], _SP[k]))

    print("=== 纵窗装填调用 %d 次 ===" % len(traced_pack.calls))
    for (pno, fs, w, nwin, used, total, wins) in traced_pack.calls:
        if not (lo <= pno <= hi):
            continue
        flag = "" if used >= total else "  ← 装不下（保留原文）"
        print("  p%-3d 宽%.1f fs=%.2f 窗%d 行%d/%d 窗高%s%s"
              % (pno, w, fs, nwin, used, total, wins, flag))
    # 输出中仍含英文成句的行
    doc = fitz.open(out)
    print("\n=== 残留英文（成句，仅 p%d-%d）===" % (lo, hi))
    import re
    for i, pg in enumerate(doc):
        if not (lo <= i + 1 <= hi):
            continue
        for b in pg.get_text("dict")["blocks"]:
            if b.get("type") != 0:
                continue
            for ln in b.get("lines", []):
                t = "".join(s["text"] for s in ln["spans"]).strip()
                w = re.findall(r"[A-Za-z][A-Za-z\-']+", t)
                if len(w) >= 5 and sum(1 for c in t if c.isalpha()) / max(len(t), 1) > 0.6:
                    print("  p%-3d y=%-6.1f %r" % (i + 1, ln["bbox"][1], t[:64]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
