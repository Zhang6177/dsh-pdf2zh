#!/usr/bin/env python3
"""pdf2zh 输出验收：一次跑完「压字 / 图保真 / 表保真 / 翻译覆盖率」四项硬指标。

用法: python3 verify.py <源.pdf> <译文.pdf> [--pages 1-10] [--verbose]

指标口径（--min-ratio 默认 0.75）：
  overlap   相邻文本行基线间距 / 字号 < 阈值 → 视觉压字。
            注意不能用 1.0 当阈值：字身墨迹只占 ~0.72em（Noto Sans CJK 实测），
            公式字体更小，基线与字号等距时并无实际叠墨。0.75 才是「真的叠上」。
  fig_intact 源图位图矩形是否仍存在（图必须原样保留）
  fig_zh    位图区域内是否出现中文（图内不该有译文）
  tail      文本是否落到页脚以下/页面外（越界）
"""
import argparse
import re
import sys

try:
    import pymupdf as fitz
except ImportError:
    import fitz

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
try:
    import protect as PROT
except Exception:
    PROT = None


def lines_of(page):
    out = []
    for b in page.get_text("rawdict").get("blocks", []):
        if b.get("type") != 0:
            continue
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
            if txt.strip() and base is not None and size > 0:
                out.append({"base": base, "size": size, "x0": x0, "x1": x1,
                            "text": txt, "r": fitz.Rect(x0, ln["bbox"][1], x1, ln["bbox"][3])})
    out.sort(key=lambda l: (l["base"], l["x0"]))
    return out


def img_rects(page):
    """位图矩形（去重：redaction 重写内容流后同一图片可能被记录两次）。"""
    out, seen = [], set()
    for im in page.get_images(full=True):
        try:
            rects = page.get_image_rects(im[0])
        except Exception:
            continue
        for r in rects:
            if r.width > 40 and r.height > 40:
                k = (round(r.x0), round(r.y0), round(r.width), round(r.height))
                if k in seen:
                    continue
                seen.add(k)
                out.append(fitz.Rect(r))
    return out


def white_fills(page):
    """页面上被白底覆盖的矩形（渲染层擦除失败的兜底填充）。

    MuPDF 的文本删除对某些 Word 导出页静默失效，渲染层改用白底覆盖保证视觉不叠印；
    此时旧文本仍留在文本层里，会被压字检测误报 —— 靠这个函数把这类「幽灵压字」分辨出来。
    """
    out = []
    try:
        draw = page.get_drawings()
    except Exception:
        return out
    for d in draw:
        f = d.get("fill")
        if not f or len(f) < 3:
            continue
        if all(abs(c - 1.0) < 0.04 for c in f[:3]):
            r = d.get("rect")
            if r is not None and r.width > 8 and r.height > 4:
                out.append(fitz.Rect(r))
    return out


def covered(rect, rects, frac=0.6):
    a = rect.get_area()
    if a <= 0:
        return False
    tot = 0.0
    for r in rects:
        it = rect & r
        if not it.is_empty:
            tot += it.get_area()
            if tot >= frac * a:
                return True
    return False


def cjk_ratio(t):
    t = [c for c in t if not c.isspace()]
    return (sum(1 for c in t if "\u4e00" <= c <= "\u9fff") / len(t)) if t else 0.0


def english_sentence(t):
    words = re.findall(r"[A-Za-z][A-Za-z\-']+", t)
    if len(words) < 5:
        return False
    letters = sum(1 for c in t if c.isalpha())
    return letters / max(len(t), 1) >= 0.6 and any(len(w) >= 3 for w in words)


def phantom_rect(L, pair):
    """压字对里「下面那一行」的矩形（用来判断是否被白底覆盖）。"""
    for ln in L:
        if ln["text"][:32] == pair[2]:
            return ln["r"]
    return fitz.Rect(0, 0, 0, 0)


def overlap_pairs(L, min_ratio):
    """(全部相邻行距比, 「压字」对)。

    压字 = 相邻文本行基线间距 / 字号 < 阈值；同时返回全部比值供分布统计。
    """
    ov, ratios = [], []
    for x in range(len(L)):
        for y in range(x + 1, min(x + 8, len(L))):
            p, q = L[x], L[y]
            pitch = q["base"] - p["base"]
            if pitch <= 0.5 or pitch > 60:
                break
            # 必须真正处于同一栏并且垂直相邻：仅「水平位置相近」不足以判压字
            hov = min(p["x1"], q["x1"]) - max(p["x0"], q["x0"])
            if hov <= 6:
                continue
            fs = min(p["size"], q["size"])
            r = pitch / fs if fs else 9
            ratios.append(r)
            if r < min_ratio:
                ov.append((round(r, 2), p["text"][:32], q["text"][:32]))
    return ratios, ov


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--pages", default="")
    ap.add_argument("--min-ratio", type=float, default=0.75)
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()
    lo, hi = 1, 10 ** 6
    if a.pages:
        m = re.match(r"^(\d+)(?:-(\d+))?$", a.pages)
        if m:
            lo, hi = int(m.group(1)), int(m.group(2) or m.group(1))

    src, out = fitz.open(a.src), fitz.open(a.out)
    n = min(src.page_count, out.page_count)
    tot = {"lines": 0, "overlap": 0, "new_overlap": 0, "ghost": 0,
           "fig_missing": 0, "fig_zh": 0, "leak_en": 0, "tail": 0,
           "new_tail": 0, "pages": 0, "new_img": 0}
    bad = []
    ratios = []
    for i in range(n):
        pno = i + 1
        if not (lo <= pno <= hi):
            continue
        tot["pages"] += 1
        page, spage = out[i], src[i]
        L = lines_of(page)
        tot["lines"] += len(L)
        ov_r, ov = overlap_pairs(L, a.min_ratio)
        ratios.extend(ov_r)
        # 源文档本来就压着的对（字体/公式固有几何）不算回归
        pre = {(p, q) for _r, p, q in overlap_pairs(lines_of(spage), a.min_ratio)[1]}
        whites = white_fills(page)
        # 文本层残留但已被白底覆盖 → 视觉上不存在，单列一类，不算真实压字
        ghost = [t for t in ov if (t[1], t[2]) not in pre
                 and covered(phantom_rect(L, t), whites)]
        new_ov = [t for t in ov if (t[1], t[2]) not in pre
                  and t not in ghost]
        # 图保真
        s_imgs, o_imgs = img_rects(spage), img_rects(page)
        fig_missing = max(0, len(s_imgs) - len(o_imgs))
        tot["new_img"] += max(0, len(o_imgs) - len(s_imgs))
        fig_zh = []
        for ln in L:
            cx, cy = (ln["r"].x0 + ln["r"].x1) / 2, (ln["r"].y0 + ln["r"].y1) / 2
            if any(r.x0 <= cx <= r.x1 and r.y0 <= cy <= r.y1 for r in o_imgs):
                if cjk_ratio(ln["text"]) > 0.25:
                    fig_zh.append(ln["text"][:34])
        leak = []
        for ln in L:
            cx, cy = (ln["r"].x0 + ln["r"].x1) / 2, (ln["r"].y0 + ln["r"].y1) / 2
            if any(r.x0 <= cx <= r.x1 and r.y0 <= cy <= r.y1 for r in o_imgs):
                continue
            if english_sentence(ln["text"]):
                leak.append(ln["text"][:44])
        tail = [ln["text"][:30] for ln in L if ln["r"].y1 > page.rect.height - 2]
        pre_tail = [ln["text"][:30] for ln in lines_of(spage)
                    if ln["r"].y1 > spage.rect.height - 2]
        new_tail = [t for t in tail if t not in pre_tail]
        tot["overlap"] += len(ov)
        tot["new_overlap"] += len(new_ov)
        tot["ghost"] += len(ghost)
        tot["fig_missing"] += fig_missing
        tot["fig_zh"] += len(fig_zh)
        tot["leak_en"] += len(leak)
        tot["tail"] += len(tail)
        tot["new_tail"] += len(new_tail)
        if new_ov or fig_missing or fig_zh or new_tail:
            bad.append((pno, new_ov, fig_missing, fig_zh, new_tail, len(leak)))

    print("== %s → %s ==" % (a.src.split("/")[-1][:44], a.out.split("/")[-1]))
    print("页 %d 文本行 %d | 压字 %d（源固有 %d / 新增 %d / 白底幽灵 %d）| 图缺失 %d "
          "| 新增图片 %d | 图内中文 %d | 越界 %d（新增 %d）| 残留英文行 %d"
          % (tot["pages"], tot["lines"], tot["overlap"],
             tot["overlap"] - tot["new_overlap"] - tot["ghost"],
             tot["new_overlap"], tot["ghost"],
             tot["fig_missing"], tot["new_img"], tot["fig_zh"], tot["tail"],
             tot["new_tail"], tot["leak_en"]))
    if ratios:
        ratios.sort()
        m = len(ratios)
        print("行距/字号: 最小 %.2f p5 %.2f 中位 %.2f"
              % (ratios[0], ratios[int(m * .05)], ratios[m // 2]))
    if bad:
        print("\n问题页:")
        for pno, ov, fm, fz, tl, lk in (bad if a.verbose else bad[:10]):
            print("  p%-4d 压字%d 图缺%d 图内中文%d 越界%d 残留英文%d"
                  % (pno, len(ov), fm, len(fz), len(tl), lk))
            for r, ta, tb in ov[:3]:
                print("      压字 %.2f %r × %r" % (r, ta, tb))
            for t in fz[:2]:
                print("      图内中文: %r" % t)
            for t in tl[:2]:
                print("      越界: %r" % t)
    return 0


if __name__ == "__main__":
    sys.exit(main())
