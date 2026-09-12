#!/usr/bin/env python3
"""pdf2zh-web 提取模块：PyMuPDF → 结构化数据（段落 token 流 / 公式 / 图片 / 章节）。

核心设计（保留原版式渲染）：
- 每页文本 block 按 左栏→右栏、栏内 y 升序 的阅读序排列
- 两次合并：drop cap（孤立大写字母+下一块大写开头）、续段（同栏小间隙同字号非句末）
- 公式字体块（CambriaMath / NewTX / CMMI 等）不并入翻译文本：
  * 夹在正文块之间的 → 行内公式 token（渲染时原位插小图，翻译文本用 ⟨n⟩ 占位）
  * 连续独立的 → 独立公式（整块从原 PDF 裁剪为图片，不翻译）
- 每个段落 = token 流 [text, math, text, ...]，保留原 bbox 与字号
- 章节标题识别；REFERENCES 之后为参考文献区（不翻译）
- 页眉/页脚/封面页剔除；位图图片提取
"""
import itertools
import re
import unicodedata

_PID = itertools.count()

try:
    import pymupdf as fitz
except ImportError:  # 老版本 PyMuPDF
    import fitz

# 仅“数学专用”字体（正文 Roman/Italic 不算公式）
MATH_FONT_RE = re.compile(
    r"CMMI|CMSY|CMSX|CMSL|MSMI|MSBM|NewTXMI|txsy|txmia|txexs|CambriaMath|DejaVuMath"
    r"|LatinMath|MathItalic|XITSMath|stix2math|LatinModernMath|Symbol|Math",
    re.I,
)
BOLD_FONT_RE = re.compile(r"Bold|Medi|Bd\b|Black|Bk\b", re.I)
ITALIC_FONT_RE = re.compile(r"Ital", re.I)
MATH_CHARS = set()
for _r in ((0x0391, 0x03A9), (0x03B1, 0x03C9), (0x2070, 0x209F), (0x2080, 0x2089),
           (0x2100, 0x214F), (0x2190, 0x21FF), (0x2200, 0x22FF), (0x2300, 0x23FF),
           (0x2A00, 0x2AFF), (0x2B00, 0x2BFF)):
    MATH_CHARS.update(chr(c) for c in range(_r[0], _r[1] + 1))
MATH_CHARS.update("±×·′″√∞≈≠≤≥∈∂∇∆Δ°∝∑∏⊕⊗⋯")

ROMAN_HEAD_RE = re.compile(r"^(I{1,3}|IV|VI{0,3}|IX|XI{0,3})\.\s*[A-Z]")
NUM_HEAD_RE = re.compile(r"^\d{1,2}(\.\d{1,2}){0,2}\.\s+[A-Z][a-z]")
REF_HEAD_RE = re.compile(r"^\s*references?\b\.?\s*$", re.I)
COVER_MARKERS = ("See discussions, stats, and author profiles",
                 "The user has requested enhancement")


class Line:
    __slots__ = ("x0", "y0", "x1", "y1", "text", "size", "is_math", "is_bold",
                 "is_italic")

    def __init__(self, x0, y0, x1, y1, text, size, is_math, is_bold, is_italic):
        self.x0, self.y0, self.x1, self.y1, self.text, self.size = (
            x0, y0, x1, y1, text, size)
        self.is_math, self.is_bold, self.is_italic = is_math, is_bold, is_italic


class Tok:
    """段落 token：kind='t' 文本 / kind='m' 公式（原页裁剪矩形）。"""
    __slots__ = ("kind", "text", "rect")

    def __init__(self, kind, text=None, rect=None):
        self.kind, self.text, self.rect = kind, text, rect


class Paragraph:
    def __init__(self, pid, page, col, tokens, x0, y0, x1, y1, font_size,
                 is_heading, is_ref, line_count, is_skip=False):
        self.pid, self.page, self.col = pid, page, col
        self.tokens = tokens
        self.x0, self.y0, self.x1, self.y1 = x0, y0, x1, y1
        self.font_size, self.is_heading, self.is_ref = font_size, is_heading, is_ref
        self.line_count, self.is_skip = line_count, is_skip
        self.is_math = all(t.kind == "m" for t in tokens)  # 独立公式段

    @property
    def raw(self):
        """无占位符的原始文本（skip/ref 段落渲染用）。"""
        return re.sub(r"\s+", " ", " ".join(t.text for t in self.tokens
                                             if t.kind == "t")).strip()

    @property
    def text(self):
        """翻译用文本：行内公式以 ⟨n⟩ 占位。"""
        parts, mi = [], 0
        for t in self.tokens:
            if t.kind == "t":
                parts.append(t.text)
            else:
                mi += 1
                parts.append("⟨%d⟩" % mi)
        return re.sub(r"\s+", " ", " ".join(parts)).strip()

    @property
    def math_rects(self):
        return [t.rect for t in self.tokens if t.kind == "m"]


class PageData:
    def __init__(self, pno, width, height, two_column):
        self.pno = pno
        self.width, self.height = width, height
        self.two_column = two_column
        self.paragraphs = []
        self.images = []       # (rect, png_bytes)
        self.skipped_header_footer = 0


class Paper:
    def __init__(self, path):
        self.path = path
        self.pages = []
        self.cover_skipped = False
        self.ref_zone_started = False

    def all_paragraphs(self):
        for pg in self.pages:
            yield from pg.paragraphs

    def translatable_paragraphs(self):
        return [p for p in self.all_paragraphs()
                if not p.is_math and not p.is_ref and not p.is_skip]

    def stats(self):
        ps = list(self.all_paragraphs())
        return {
            "pages": len(self.pages),
            "paragraphs": len(ps),
            "to_translate": len(self.translatable_paragraphs()),
            "math_items": sum(len(p.math_rects) for p in ps),
            "images": sum(len(pg.images) for pg in self.pages),
            "cover_skipped": self.cover_skipped,
        }


# ---------------------------------------------------------------- helpers

def _math_density(text):
    t = [c for c in text if not c.isspace()]
    if not t:
        return 0.0
    n = sum(1 for c in t if c in MATH_CHARS or unicodedata.category(c).startswith("Sm"))
    return n / len(t)


def _line_is_math(spans):
    total = sum(len(t) for t, _ in spans) or 1
    math_chars = sum(len(t) for t, f in spans if MATH_FONT_RE.search(f or ""))
    if math_chars / total > 0.5:
        return True
    return _math_density("".join(t for t, _ in spans)) > 0.45


def _join_lines(lines):
    """栏内换行合并 + 连字符还原（前行以 - 结尾且下行小写开头 → 去连字符不留空格）。"""
    parts = []
    for ln in lines:
        if parts and parts[-1].endswith("-") and ln[:1].islower():
            parts[-1] = parts[-1][:-1] + ln
        else:
            parts.append(ln)
    return re.sub(r"\s+", " ", " ".join(parts)).strip()


def _is_two_column(page, text_blocks):
    if not text_blocks:
        return False
    W = page.rect.width
    mid = W / 2
    narrow_straddle = [
        b for b in text_blocks
        if b[0] < mid - 10 and b[2] > mid + 10 and (b[2] - b[0]) < W * 0.6
    ]
    if narrow_straddle and len(narrow_straddle) > 0.15 * len(text_blocks):
        return False
    left = sum(1 for b in text_blocks if (b[0] + b[2]) / 2 < mid)
    return max(left, len(text_blocks) - left) > 0.6 * len(text_blocks)


def _reading_order(page, text_blocks):
    W = page.rect.width
    mid = W / 2
    if _is_two_column(page, text_blocks):
        left = sorted((b for b in text_blocks if (b[0] + b[2]) / 2 < mid),
                      key=lambda b: (b[1], b[0]))
        right = sorted((b for b in text_blocks if (b[0] + b[2]) / 2 >= mid),
                       key=lambda b: (b[1], b[0]))
        return left + right, True
    return sorted(text_blocks, key=lambda b: (b[1], b[0])), False


def _block_text(b):
    return re.sub(r"\s+", " ", " ".join(l.text for l in b["lines"])).strip()


def _merge_blocks(blocks, mid):
    """1) drop cap：单大写字母 + 下一块大写开头 → 合并（小写开头也合并）。
    2) 续段：同栏、小间隙、同字号、前块非句末 → 并入前块。"""
    out = []
    i = 0
    while i < len(blocks):
        b = blocks[i]
        t = _block_text(b)
        if i + 1 < len(blocks) and len(t) == 1 and t.isalpha() and t.isupper():
            nt = _block_text(blocks[i + 1])
            if nt[:1].isupper() or nt[:1].islower():
                nb = dict(blocks[i + 1])
                nb["lines"] = b["lines"] + nb["lines"]
                nb["x0"] = min(b["x0"], nb["x0"])
                nb["y0"] = min(b["y0"], nb["y0"])
                out.append(nb)
                i += 2
                continue
        out.append(b)
        i += 1
    out2 = [dict(out[0])] if out else []
    for b in out[1:]:
        prev = out2[-1]
        pt = _block_text(prev)
        bt = _block_text(b)
        fs_p = max((l.size for l in prev["lines"]), default=10)
        fs_b = max((l.size for l in b["lines"]), default=10)
        col_p = 0 if (prev["x0"] + prev["x1"]) / 2 < mid else 1
        col_b = 0 if (b["x0"] + b["x1"]) / 2 < mid else 1
        gap = b["y0"] - prev["y1"]
        same_para = (
            col_p == col_b and abs(fs_p - fs_b) < 1.5 and -2 < gap < 0.9 * fs_p
            and (pt.endswith("-") or bt[:1].islower() or fs_p > 18)
            and not re.search(r"[.!?:;\"']\s*$", pt)
        )
        if same_para:
            prev["lines"] = prev["lines"] + b["lines"]
            prev["y1"] = max(prev["y1"], b["y1"])
        else:
            out2.append(dict(b))
    return out2


def _split_heading_lines(b):
    """block 内混有标题行时拆成子块：
    - 粗体行紧跟非粗体行 → 边界（标题开始）
    - 单行短粗体（标题）后跟长非粗体行 → 边界（正文开始）
    - Roman/字母编号模式行（前一行非粗体）→ 边界（兜底）
    """
    lines = b["lines"]
    if len(lines) <= 1:
        return [b]
    groups, cur = [], []
    for i, ln in enumerate(lines):
        if cur:
            prev = cur[-1]
            t = ln.text.strip()
            is_head_pat = bool(ROMAN_HEAD_RE.match(t) or re.match(r"^[A-Z]\.\s", t)
                               or re.match(r"^\d{1,2}\)\s", t))
            if (ln.is_bold and not prev.is_bold):
                groups.append(cur)
                cur = []
            elif (not ln.is_bold and prev.is_bold and len(cur) == 1
                    and len(t) > 35):
                groups.append(cur)
                cur = []
            elif (prev.is_italic and not ln.is_italic and not ln.is_bold
                    and len(cur) == 1 and len(prev.text) <= 60 and len(t) > 35):
                groups.append(cur)
                cur = []
            elif is_head_pat and not prev.is_bold:
                groups.append(cur)
                cur = []
        cur.append(ln)
    if cur:
        groups.append(cur)
    if len(groups) <= 1:
        return [b]
    out = []
    for g in groups:
        nb = dict(b)
        nb["lines"] = g
        nb["y0"] = min(l.y0 for l in g)
        nb["y1"] = max(l.y1 for l in g)
        out.append(nb)
    return out


def _extract_images(doc, page, width):
    out = []
    for img in page.get_images(full=True):
        xref = img[0]
        try:
            rects = page.get_image_rects(xref)
        except Exception:
            continue
        try:
            pix = fitz.Pixmap(doc, xref)
        except Exception:
            continue
        if pix.colorspace and pix.colorspace.n == 4:  # CMYK → RGB
            pix = fitz.Pixmap(fitz.csRGB, pix)
        png = pix.tobytes("png")
        pix = None
        for r in rects:
            r = r & fitz.Rect(0, 0, width, page.rect.height)
            if r.width > 25 and r.height > 25:
                out.append((fitz.Rect(r), png))
    return out


# ---------------------------------------------------------------- main

def extract_paper(path):
    doc = fitz.open(path)
    paper = Paper(path)
    H_MARGIN = 45

    for pno in range(len(doc)):
        page = doc[pno]
        raw = page.get_text("dict")
        W, H = page.rect.width, page.rect.height

        if pno == 0:
            ptext = page.get_text("text")
            if any(m in ptext for m in COVER_MARKERS):
                paper.cover_skipped = True
                continue

        blocks = []
        for b in raw.get("blocks", []):
            if b.get("type") != 0:
                continue
            x0, y0, x1, y1 = b["bbox"]
            lines = []
            for ln in b.get("lines", []):
                ltext, spans = "", []
                size_num = 0.0
                size_den = 0
                for sp in ln.get("spans", []):
                    ltext += sp.get("text", "")
                    spans.append((sp.get("text", ""), sp.get("font", "")))
                    n = max(len(sp.get("text", "")), 1)
                    size_num += sp.get("size", 0) * n
                    size_den += n
                ltext = ltext.strip()
                if not ltext:
                    continue
                tot = max(sum(len(t) for t, _ in spans), 1)
                bold_chars = sum(len(t) for t, f in spans if BOLD_FONT_RE.search(f or ""))
                ital_chars = sum(len(t) for t, f in spans if ITALIC_FONT_RE.search(f or ""))
                lines.append(Line(ln["bbox"][0], ln["bbox"][1], ln["bbox"][2],
                                  ln["bbox"][3], ltext, size_num / max(size_den, 1),
                                  _line_is_math(spans),
                                  bold_chars / tot > 0.5,
                                  ital_chars / tot > 0.5))
            if not lines:
                continue
            for sb in _split_heading_lines({"x0": x0, "y0": y0, "x1": x1,
                                            "y1": y1, "lines": lines}):
                blocks.append(sb)

        mid = W / 2
        indexed = [(b["x0"], b["y0"], b["x1"], b["y1"], b) for b in blocks]
        ordered, two_col = _reading_order(page, indexed)
        ordered_dicts = [b[4] for b in ordered]
        merged = _merge_blocks(ordered_dicts, mid)

        pgd = PageData(pno + 1, W, H, two_col)

        # 逐块构造 token 流段落
        cur = None       # 当前段落 dict
        last_text_y1 = -1

        def flush():
            nonlocal cur
            if cur and cur["tokens"]:
                pgd.paragraphs.append(_make_paragraph(
                    pgd, cur, pno, mid, paper))
            cur = None

        for bi, b in enumerate(merged):
            text = _join_lines([l.text for l in b["lines"]])
            if not text:
                continue
            col = 1 if (b["x0"] + b["x1"]) / 2 >= mid and two_col else 0

            if b["y1"] < H_MARGIN or b["y0"] > H - H_MARGIN:
                if len(text) < 80:
                    pgd.skipped_header_footer += 1
                    continue

            block_is_math = _block_is_math(b["lines"], b)
            font_size = max((l.size for l in b["lines"]), default=9.0)

            if block_is_math:
                # 行内公式：垂直落点在当前段落文本范围内 → 挂到 cur
                if (cur is not None and cur["col"] == col
                        and cur["y0"] - 2 <= b["y0"] <= last_text_y1 + 0.6 * font_size
                        and (b["y0"] - cur["y0"]) < 200):
                    cur["tokens"].append(Tok("m", rect=fitz.Rect(b["x0"], b["y0"],
                                                                 b["x1"], b["y1"])))
                    cur["y1"] = max(cur["y1"], b["y1"])
                else:
                    # 独立公式段
                    flush()
                    pgd.paragraphs.append(Paragraph(
                        (pno + 1, next(_PID)), pno + 1, col,
                        [Tok("m", rect=fitz.Rect(b["x0"], b["y0"], b["x1"], b["y1"]))],
                        b["x0"], b["y0"], b["x1"], b["y1"], font_size,
                        False, False, 1))
                continue

            # 数字/符号为主的块（轴标签、编号碎片等）不翻译，原样渲染
            _alpha = sum(1 for c in text if c.isalpha())
            is_skip = not re.search(r"[\u4e00-\u9fff]", text) and \
                _alpha / max(len(text), 1) < 0.6

            first = b["lines"][0].text.strip()
            is_heading = False
            if len(text) <= 110:
                if (ROMAN_HEAD_RE.match(first) or NUM_HEAD_RE.match(first)
                        or re.match(r"^[A-Z]\.\s+[A-Z]", first)):
                    is_heading = True
                elif re.match(r"^(abstract|index terms|keywords|introduction|conclusion(ary)?|method(ology)?|results?|references?|appendix|experiments?)\b", first, re.I):
                    is_heading = True

            is_ref = paper.ref_zone_started
            if re.match(r"^references?\b", first, re.I):
                is_ref = True
                is_heading = True
                paper.ref_zone_started = True

            _gap = b["y0"] - last_text_y1
            # 标题换行续行（如 “MODELS”）：短、全大写、紧跟标题 → 并入标题
            is_head_cont = (
                cur is not None and cur.get("heading") and cur["col"] == col
                and _gap < 1.0 * font_size and len(text) <= 60
                and re.fullmatch(r"[A-Z0-9 \-\.\(\):]+", text))
            if (cur is not None and cur["col"] == col
                    and _gap < 1.35 * font_size and not is_heading
                    and (is_head_cont or not cur.get("heading"))):
                cur["tokens"].append(Tok("t", text=text))
                cur["y1"] = max(cur["y1"], b["y1"])
                cur["line_count"] += len(b["lines"])
                if not is_skip:
                    cur["skip"] = False  # 合并进正文后整段恢复可翻译
            else:
                flush()
                cur = {"col": col, "x0": b["x0"], "y0": b["y0"], "x1": b["x1"],
                       "y1": b["y1"], "fs": font_size, "heading": is_heading,
                       "ref": is_ref, "skip": is_skip,
                       "tokens": [Tok("t", text=text)],
                       "line_count": len(b["lines"]), "head_text": text}
            last_text_y1 = b["y1"]
        flush()

        pgd.images = _extract_images(doc, page, W)
        paper.pages.append(pgd)

    doc.close()
    return paper


def _block_is_math(lines, b):
    """块整体是否公式：多数行是数学字体（span 级判定），或符号密度高兜底。"""
    t = _block_text(b)
    if not t:
        return False
    if len(lines) >= 1 and sum(l.is_math for l in lines) > len(lines) / 2:
        return True
    return _math_density(t) > 0.45


def _make_paragraph(pgd, cur, pno, mid, paper):
    text = re.sub(r"\s+", " ", " ".join(t.text for t in cur["tokens"]
                                         if t.kind == "t")).strip()
    return Paragraph(
        (pno + 1, next(_PID)), pno + 1, cur["col"], cur["tokens"],
        cur["x0"], cur["y0"], cur["x1"], cur["y1"], cur["fs"],
        cur["heading"], cur["ref"], cur["line_count"],
        is_skip=cur.get("skip", False))