#!/usr/bin/env python3
"""pdf2zh 文本提取：学术论文 PDF → 结构化纯文本（自动处理双栏布局）。

用法:
  python3 extract.py paper.pdf                  # 输出 paper.txt（同目录）
  python3 extract.py paper.pdf -o out.txt       # 指定输出
  python3 extract.py paper.pdf --pages 1-8      # 只提取指定页（1,3,5-9 亦可）

依赖: PyMuPDF (fitz)。公式以原文符号保留，翻译阶段原样保留。
"""
import argparse
import os

import fitz  # PyMuPDF


def parse_pages(spec, total):
    if not spec:
        return list(range(1, total + 1))
    out = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            out.extend(range(int(a), min(int(b), total) + 1))
        else:
            out.append(int(part))
    return sorted(set(p for p in out if 1 <= p <= total))


def is_two_column(page, blocks):
    """启发式：窄文本块大多落在左半或右半，且不横跨中缝 → 双栏。"""
    if not blocks:
        return False
    W = page.rect.width
    mid = W / 2
    narrow_straddle = [
        b for b in blocks
        if b[0] < mid - 10 and b[2] > mid + 10 and (b[2] - b[0]) < W * 0.6
    ]
    if narrow_straddle and len(narrow_straddle) > 0.15 * len(blocks):
        return False
    left = sum(1 for b in blocks if (b[0] + b[2]) / 2 < mid)
    return max(left, len(blocks) - left) > 0.6 * len(blocks)


def sort_blocks(page, blocks):
    """双栏：先左栏从上到下，再右栏；单栏：按 (y, x) 排序。"""
    blocks = [b for b in blocks if b[6] == 0]  # 仅文本块
    if not blocks:
        return blocks
    W = page.rect.width
    if is_two_column(page, blocks):
        mid = W / 2
        left = sorted((b for b in blocks if (b[0] + b[2]) / 2 < mid),
                      key=lambda b: (b[1], b[0]))
        right = sorted((b for b in blocks if (b[0] + b[2]) / 2 >= mid),
                       key=lambda b: (b[1], b[0]))
        return left + right
    return sorted(blocks, key=lambda b: (b[1], b[0]))


def main():
    ap = argparse.ArgumentParser(description="学术论文 PDF 文本提取")
    ap.add_argument("pdf")
    ap.add_argument("-o", "--out", help="输出 txt 路径，默认与 PDF 同名")
    ap.add_argument("--pages", help="页码范围，如 1-8 或 1,3,5")
    args = ap.parse_args()

    doc = fitz.open(args.pdf)
    out_path = args.out or os.path.splitext(args.pdf)[0] + ".txt"
    pages = parse_pages(args.pages, len(doc))
    if not pages:
        print("ERROR: --pages 超出范围（全文共 %d 页）" % len(doc))
        raise SystemExit(1)

    lines = ["# source: %s" % os.path.basename(args.pdf),
             "# pages: %d" % len(pages), ""]
    for pno in pages:
        page = doc[pno - 1]
        texts = [b[4].strip() for b in sort_blocks(page, page.get_text("blocks"))]
        texts = [t for t in texts if t]
        lines.append("\n[PAGE %d]\n" % pno)
        lines.append("\n\n".join(texts) + "\n")

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print("OK %s  pages=%d chars=%d" % (out_path, len(pages),
                                        sum(len(l) for l in lines)))


if __name__ == "__main__":
    main()