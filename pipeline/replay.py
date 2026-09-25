#!/usr/bin/env python3
"""pdf2zh 离线回放台：不依赖模型端点，验证渲染层（版式/图保真）。

用途：vLLM 未启动时也能对「提取 → 排版 → 回填」全链路做回归与体检。
译文有两种来源：
  1. `--translations dump.json`：真实译文转储（run_pipeline.py 的 PDF2ZH_DUMP_TRANSLATIONS）
  2. 缺省：按英文字符数 × 0.60 合成的占位中文（学术英译中的经验密度），
     足以复现「中文比英文占位更多/更少」两类极端，检验不会压字、不越界。

用法:
  python3 replay.py <源.pdf> [--pages 1-6] [--out /tmp/x.zh.pdf] [--translations t.json]
"""
import argparse
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

try:
    import pymupdf as fitz
except ImportError:
    import fitz

from extract import extract_paper           # noqa: E402
import render as R                          # noqa: E402
import protect as PROT                      # noqa: E402

# 合成译文用句库（覆盖学术论文高频表达，尽量贴近真实译文长度分布）
_SENT = ("本文提出了一种用于少样本高光谱图像分类的上下文交互孪生网络，"
         "通过特征交互模块显著增强了两个子网络之间的语义对齐能力。"
         "实验结果表明，该方法在多个公开数据集上均取得了优于现有技术的分类精度，"
         "同时保持了较低的计算开销与良好的泛化性能。"
         "为了缓解参数过多导致的过拟合问题，所有卷积核的尺寸均设置为最小规模，"
         "并在特征融合阶段引入余弦相似度与空间注意力机制。"
         "此外，我们采用了元学习策略来处理训练样本严重受限的场景。")


def synth(text, ratio=0.60):
    """合成译文：长度 ≈ 英文字符数 × ratio（中文信息密度更高，故 <1）。"""
    n = max(6, int(len(re.sub(r"\s+", "", text)) * ratio))
    out = []
    while sum(len(s) for s in out) < n:
        out.append(_SENT)
    return "".join(out)[:n]


def load_real(path):
    if not path:
        return None
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    # {"pages": [{"pno":1,"paragraphs":[{"pid":[1,3],"text":"..."}]}]}
    out = {}
    for pg in data.get("pages", []):
        for par in pg.get("paragraphs", []):
            pid = par.get("pid")
            if isinstance(pid, list):
                pid = tuple(pid)
            out[pid] = par.get("text")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--pages", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--translations", default="")
    ap.add_argument("--ratio", type=float, default=0.60)
    ap.add_argument("--shrink", type=float, default=1.5,
                    help="正文基准字号收缩量（pt），与 run_pipeline 默认一致")
    args = ap.parse_args()

    src = args.pdf
    if args.pages:
        doc = fitz.open(src)
        idx = []
        for part in args.pages.split(","):
            m = re.match(r"^(\d+)(?:-(\d+))?$", part.strip())
            if m:
                a = int(m.group(1))
                b = int(m.group(2) or m.group(1))
                idx.extend(range(a - 1, min(b, doc.page_count)))
        out = fitz.open()
        for i in sorted(set(idx)):
            out.insert_pdf(doc, from_page=i, to_page=i)
        tmp = "/tmp/pdf2zh_replay_slice.pdf"
        out.save(tmp)
        out.close()
        doc.close()
        src = tmp

    t0 = time.time()
    paper = extract_paper(src)
    t_extract = time.time() - t0
    real = load_real(args.translations) if args.translations else None

    translations = {}
    for pg in paper.pages:
        for p in pg.paragraphs:
            if p.is_math or p.is_ref or p.is_skip:
                continue
            translations[p.pid] = (real.get(p.pid) if real else None) or synth(p.text, args.ratio)

    out_path = args.out or (os.path.splitext(args.pdf)[0] + ".replay.zh.pdf")
    warnings = []
    orig = fitz.open(src)
    t0 = time.time()
    n_fail = R.render_pdf(paper, translations, orig, out_path, warnings,
                          font_shrink=args.shrink)
    t_render = time.time() - t0
    orig.close()

    fig_blocks = sum(len(pg.figure_blocks) for pg in paper.pages)
    print("extract %.1fs / render %.1fs → %s" % (t_extract, t_render, out_path))
    print("段落 %d 可译 %d 图内保护块 %d 未回填 %d"
          % (paper.stats()["paragraphs"], paper.stats()["to_translate"],
             fig_blocks, n_fail))
    for w in warnings[:8]:
        print("  warn:", w)
    print("OUT=%s" % out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
