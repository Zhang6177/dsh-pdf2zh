#!/usr/bin/env python3
"""pdf2zh-web 渲染模块：保留原版式生成中文 PDF（纯 PyMuPDF，无浏览器）。

每页与原文同尺寸，三层：
  1. 位图图片层：按原 bbox 嵌入
  2. 独立公式段：整块从原 PDF 裁剪为 3x 图片（公式保真=原样）
  3. 文字层（流式排版）：译文按原段落 bbox 排入；行内公式以 ⟨n⟩ 占位符
     切分后原位插入裁剪小图；字号自适应收缩；CJK 逐字可换行
"""
import os
import re
import unicodedata

try:
    import pymupdf as fitz
except ImportError:  # 老版本 PyMuPDF
    import fitz

CJK_FONT = os.path.expanduser("~/.local/share/fonts/NotoSansCJKsc-Regular.otf")
CJK_FONT_BOLD = os.path.expanduser("~/.local/share/fonts/NotoSansCJKsc-Bold.otf")
MIN_FONT_SIZE = 7.0
MATH_ZOOM = 3
_CJK_PUNCT = set("，。；：？！""''（）《》、—…·．,.;:?!()[]<>\"'")


def _font_paths():
    if os.path.exists(CJK_FONT):
        return CJK_FONT, (CJK_FONT_BOLD if os.path.exists(CJK_FONT_BOLD) else None)
    return None, None


def _norm(s):
    """NFKC：数学字母数字（𝑥/𝐴/𝜇…）归一为普通字符，避免字体缺字出豆腐块。"""
    return unicodedata.normalize("NFKC", s or "")


def cjk_split(s):
    """CJK 感知分词：中文/标点逐字可断行，拉丁词整体。"""
    out, cur = [], ""
    for ch in s:
        if ("\u4e00" <= ch <= "\u9fff") or ch in _CJK_PUNCT:
            if cur:
                out.append(cur)
                cur = ""
            out.append(ch)
        elif ch == " ":
            if cur:
                out.append(cur)
                cur = ""
            out.append(" ")
        else:
            cur += ch
    if cur:
        out.append(cur)
    return out


def _split_markers(text, math_rects):
    """按 ⟨n⟩ 占位符把译文切回 [text, math_rect, ...] token 流。"""
    segs = re.split(r"⟨(\d+)⟩", text or "")
    toks, seen = [], set()
    for i in range(0, len(segs), 2):
        txt = re.sub(r"\s+", " ", segs[i] or "").strip()
        if txt:
            toks.append(("t", txt))
        if i + 1 < len(segs):
            n = int(segs[i + 1])
            if 1 <= n <= len(math_rects) and n not in seen:
                seen.add(n)
                toks.append(("m", math_rects[n - 1]))
    if math_rects and not seen:
        # 模型丢了占位符：兜底把行内公式排在段尾
        head = [t for t in toks if t[0] == "t"]
        rest = [t for t in toks if t[0] == "m"]
        toks = ([("t", " ".join(t[1] for t in head))] if head else []) + \
            [("m", r) for r in math_rects] + rest
    if not toks and (text or "").strip():
        toks = [("t", text.strip())]
    return toks


def _measure(toks, fs, x0, x1, font):
    """纯测量：返回段落结束 baseline y（相对 0 起）与是否超宽。"""
    line_h = fs * 1.42
    x, y = 0.0, 0.0
    for kind, payload in toks:
        if kind == "t":
            for w in cjk_split(payload):
                if w == " ":
                    x += font.text_length(" ", fontsize=fs)
                    continue
                wl = font.text_length(w, fontsize=fs)
                if x + wl > x1 - x0 + 1:
                    y += line_h
                    x = 0.0
                x += wl
        else:
            r = payload
            ih = line_h * 0.88
            iw = ih * (r.width / r.height) if r.height else ih
            if iw > x1 - x0:
                iw = x1 - x0
                ih = iw * r.height / max(r.width, 1)
            if x + iw > x1 - x0 + 1:
                y += line_h
                x = 0.0
            x += iw + 1.5
    return y


def _put_math(page, orig_page, pno, r, dest, warnings):
    try:
        pix = orig_page.get_pixmap(clip=r, matrix=fitz.Matrix(MATH_ZOOM, MATH_ZOOM),
                                   alpha=False)
        page.insert_image(dest, stream=pix.tobytes("png"))
    except Exception as e:  # noqa: BLE001
        if warnings is not None:
            warnings.append("p%d 公式裁剪失败: %s" % (pno, e))


def _draw_flow(page, font, font_bold, toks, orig_page, pno, x0, y0, x1,
               max_bottom, fs, is_head, warnings):
    fontname = "cjk_b" if (is_head and font_bold) else "cjk"
    f = font_bold if (is_head and font_bold) else font
    line_h = fs * 1.42
    overflow = _measure(toks, fs, x0, x1, f) + fs > max_bottom
    x, y = x0, y0 + fs
    for kind, payload in toks:
        if kind == "t":
            for w in cjk_split(payload):
                if w == " ":
                    x += f.text_length(" ", fontsize=fs)
                    continue
                if any(not f.has_glyph(ord(c)) for c in w if not c.isspace()):
                    w = "".join(c if (f.has_glyph(ord(c)) or c.isspace()) else "?"
                                for c in w)
                    wl = f.text_length(w, fontsize=fs)
                else:
                    wl = f.text_length(w, fontsize=fs)
                if x + wl > x1 + 1:
                    y += line_h
                    x = x0
                page.insert_text((x, y), w, fontname=fontname, fontsize=fs)
                x += wl
        else:
            r = payload
            ih = line_h * 0.88
            iw = ih * (r.width / r.height) if r.height else ih
            if iw > x1 - x0:
                iw = x1 - x0
                ih = iw * r.height / max(r.width, 1)
            if x + iw > x1 + 1:
                y += line_h
                x = x0
            _put_math(page, orig_page, pno, r,
                      fitz.Rect(x, y - ih * 0.80, x + iw, y - ih * 0.80 + ih),
                      warnings)
            x += iw + 1.5
    if overflow and warnings is not None:
        warnings.append("p%d 段落超出原块区域（已向下延伸）: %s..." %
                        (pno, "".join(t[1][:20] for t in toks if t[0] == "t")))


def render_pdf(paper, translations, orig_doc, out_path, warnings=None):
    reg, bold = _font_paths()
    if reg is None:
        raise RuntimeError("找不到中文字体 %s" % CJK_FONT)
    font_cjk = fitz.Font(fontfile=reg)
    font_bold = fitz.Font(fontfile=bold) if bold else None

    doc = fitz.open()
    n_failed = 0

    for pgd in paper.pages:
        page = doc.new_page(width=pgd.width, height=pgd.height)
        orig_page = orig_doc[pgd.pno - 1]

        for rect, png in pgd.images:
            try:
                page.insert_image(rect, stream=png)
            except Exception as e:  # noqa: BLE001
                if warnings is not None:
                    warnings.append("p%d 图片插入失败: %s" % (pgd.pno, e))

        page.insert_font(fontname="cjk", fontfile=reg)
        if bold:
            page.insert_font(fontname="cjk_b", fontfile=bold)

        paras = pgd.paragraphs
        for i, p in enumerate(paras):
            # 独立公式段：整块原图
            if p.is_math:
                r = fitz.Rect(*p.math_rects[0])
                _put_math(page, orig_page, pgd.pno, r, r, warnings)
                continue

            if p.is_ref or p.is_skip:
                toks = [("t", _norm(p.raw))] if p.raw else []
            else:
                t = translations.get(p.pid)
                if t is None:
                    n_failed += 1
                    t = "[翻译失败] " + p.raw
                toks = _split_markers(_norm(t), p.math_rects)
            if not toks:
                continue

            # 可用高度：同栏下一段顶边之前
            max_bottom = pgd.height - 20
            for q in paras[i + 1:]:
                if q.col == p.col and q.y0 > p.y1:
                    max_bottom = min(max_bottom, q.y0 - 2)
                    break

            fs = p.font_size
            if p.is_heading:
                fs = max(fs, 10.0)
            if p.is_ref:
                fs = max(fs - 0.5, MIN_FONT_SIZE)
            # 最小宽度保护：异常窄的块（碎片/标题残留）扩展为整栏（x0、x1 都重置）
            if p.x1 - p.x0 < 80:
                if p.col == 0:
                    p.x0, p.x1 = 49.0, pgd.width / 2 - 8
                else:
                    p.x0, p.x1 = pgd.width / 2 + 6.0, pgd.width - 49
            # 字号自适应
            while fs > MIN_FONT_SIZE:
                if _measure(toks, fs, p.x0, p.x1,
                            font_bold if (p.is_heading and font_bold) else font_cjk) + fs \
                        <= max_bottom:
                    break
                fs -= 0.5

            _draw_flow(page, font_cjk, font_bold, toks, orig_page, pgd.pno,
                       p.x0, p.y0 - 1, p.x1, max_bottom, fs,
                       p.is_heading and not p.is_ref, warnings)

    doc.subset_fonts()
    doc.save(out_path, garbage=3, deflate=True)
    doc.close()
    return n_failed