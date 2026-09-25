#!/usr/bin/env python3
"""pdf2zh 输出体检 v4（基线真值）：只有「基线间距 < 自身字号」才是真叠印。

背景：MuPDF 报告的 char/line bbox 含 ±1.8em 量级的 em-box 留白，
用它判叠印会把正常的紧行距误报成「字压字」。CJK 字身实际占满 em 方框，
故判据取：相邻两行基线距离 pitch 与字号 fs 的关系
    pitch >= fs * 1.00  → 不会压字（汉字高度≈1em，上下无额外留白）
    pitch <  fs * 1.00  → 真实压字
并按横向重叠确认两行确实在同一栏内上下相邻。

用法: python3 diag4.py <译文.pdf> [--pages 1-10] [--min-ratio 0.98] [--verbose]
"""
import re
import sys
from collections import defaultdict

try:
    import pymupdf as fitz
except ImportError:
    import fitz


def _lines(page):
    """返回 [{base, size, x0, x1, text, block}]，按基线排序。"""
    out = []
    bid = 0
    for b in page.get_text("rawdict").get("blocks", []):
        if b.get("type") != 0:
            continue
        bid += 1
        for ln in b.get("lines", []):
            txt, size, base = "", 0.0, None
            x0, x1 = 1e9, -1e9
            for sp in ln.get("spans", []):
                chars = sp.get("chars") or []
                txt += sp.get("text") or "".join(c.get("c", "") for c in chars)
                size = max(size, sp.get("size", 0) or 0)
                rb = fitz.Rect(sp["bbox"])
                if rb.x1 > rb.x0:
                    x0, x1 = min(x0, rb.x0), max(x1, rb.x1)
                if base is None:
                    for ch in chars:
                        if ch.get("c", "").strip() and ch.get("origin"):
                            base = ch["origin"][1]
                            break
            if not txt.strip() or base is None:
                continue
            out.append({"base": base, "size": size, "x0": x0, "x1": x1,
                        "text": txt, "block": bid})
    out.sort(key=lambda l: (l["base"], l["x0"]))
    return out


def scan(page, min_ratio=0.98):
    L = _lines(page)
    bad = []
    for i in range(len(L)):
        a = L[i]
        for j in range(i + 1, len(L)):
            b = L[j]
            pitch = b["base"] - a["base"]
            if pitch <= 0.5:
                continue
            if pitch > 60:
                break  # 已排序，后面更远
            # 横向必须同栏重叠
            if min(a["x1"], b["x1"]) - max(a["x0"], b["x0"]) <= 6:
                continue
            fs = min(a["size"], b["size"])
            if fs <= 0:
                continue
            ratio = pitch / fs
            if ratio < min_ratio:
                bad.append((round(ratio, 2), round(pitch, 2), round(fs, 1),
                            a["text"][:34], b["text"][:34]))
    return L, bad


def main():
    path = sys.argv[1]
    lo, hi = 1, 10 ** 6
    if "--pages" in sys.argv:
        m = re.match(r"^(\d+)(?:-(\d+))?$", sys.argv[sys.argv.index("--pages") + 1])
        if m:
            lo, hi = int(m.group(1)), int(m.group(2) or m.group(1))
    min_ratio = 0.98
    if "--min-ratio" in sys.argv:
        min_ratio = float(sys.argv[sys.argv.index("--min-ratio") + 1])
    doc = fitz.open(path)
    tot_lines = tot_bad = 0
    pages = []
    ratios = []
    for i in range(doc.page_count):
        pno = i + 1
        if not (lo <= pno <= hi):
            continue
        L, bad = scan(doc[i], min_ratio)
        tot_lines += len(L)
        tot_bad += len(bad)
        for k in range(len(L) - 1):
            a, b = L[k], L[k + 1]
            p = b["base"] - a["base"]
            if 0.5 < p < 60 and min(a["x1"], b["x1"]) - max(a["x0"], b["x0"]) > 6 and a["size"] > 0:
                ratios.append(p / a["size"])
        if bad:
            pages.append((pno, bad))
    print("== %s ==" % path.split("/")[-1])
    print("文本行 %d  真叠印对 %d  问题页 %d/%d" % (tot_lines, tot_bad, len(pages), hi - lo + 1))
    if ratios:
        ratios.sort()
        n = len(ratios)
        print("基线间距/字号 分布: p5=%.2f p25=%.2f 中位=%.2f p75=%.2f p95=%.2f"
              % (ratios[int(n * .05)], ratios[int(n * .25)], ratios[n // 2],
                 ratios[int(n * .75)], ratios[min(n - 1, int(n * .95))]))
    if "--verbose" not in sys.argv:
        pages = pages[:10]
    for pno, bad in pages:
        print("\np%d  真叠印 %d 处" % (pno, len(bad)))
        for ratio, pitch, fs, ta, tb in bad[:5]:
            print("   间距/字号=%.2f (pitch=%.2f fs=%.1f)\n      %r\n      %r" % (ratio, pitch, fs, ta, tb))
    return 0


if __name__ == "__main__":
    sys.exit(main())
