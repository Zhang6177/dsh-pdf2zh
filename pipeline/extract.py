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
import os
import re
import unicodedata

_PID = itertools.count()

try:
    import pymupdf as fitz
except ImportError:  # 老版本 PyMuPDF
    import fitz

try:
    import protect as PROT
except ImportError:  # 独立运行时（skill 目录）无 protect：降级为无保护
    PROT = None

# ---------------------------------------------------------------- GNN 布局模型
# pymupdf-layout（Artifex 官方，BoxRFDGNN，纯 CPU ONNX，模型随 wheel 分发）
# 提供 table / formula / section-header / page-header / page-footer / picture 等
# 版面区域；不可用时全部降级回字体启发式。PDF2ZH_LAYOUT=off 可整体关闭。
_LAYOUT_ENV = (os.environ.get("PDF2ZH_LAYOUT") or "gnn").strip().lower()
_TABLES_ENV = (os.environ.get("PDF2ZH_TABLES") or "on").strip().lower()
_layout_fn = None
_layout_state = 0  # 0=未探测 1=可用 2=不可用


def _layout_backend():
    global _layout_fn, _layout_state
    if _LAYOUT_ENV in ("off", "0", "no", "heuristic"):
        return None
    if _layout_state == 2:
        return None
    if _layout_state == 1:
        return _layout_fn
    try:
        import pymupdf as _pm
        import pymupdf.layout  # noqa: F401  import 即 activate()
        fn = getattr(_pm, "_get_layout", None)
        if callable(fn):
            _layout_fn, _layout_state = fn, 1
            return fn
        _layout_state = 2
    except Exception:
        _layout_state = 2
    return None


_LAYOUT_LABELS = {
    "formula": "formula", "table": "table",
    "page-header": "header", "page-footer": "footer",
    "section-header": "section", "picture": "picture",
    "caption": "caption",
}


def layout_for_page(page):
    """GNN 版面分析 → {'formula': [Rect], ...}；不可用返回 None（附失败原因标记）。"""
    fn = _layout_backend()
    if fn is None:
        return None
    try:
        items = fn(page) or []
    except Exception:
        return None
    out = {"formula": [], "table": [], "header": [], "footer": [], "section": [], "picture": [],
           "caption": []}
    for it in items:
        try:
            r = fitz.Rect(it[0], it[1], it[2], it[3])
            label = _LAYOUT_LABELS.get(it[4])
        except Exception:
            continue
        if label and not r.is_empty and r.is_valid:
            out[label].append(r)
    return out


def find_tables_fallback(page):
    """无 GNN 时的兜底：pymupdf find_tables（书线表常有漏检，故仅作降级）。"""
    if _TABLES_ENV in ("off", "0", "no"):
        return []
    try:
        tf = page.find_tables()
    except Exception:
        return []
    out = []
    page_area = max(page.rect.get_area(), 1.0)
    for t in getattr(tf, "tables", []):
        try:
            if t.row_count < 2 or t.col_count < 2:
                continue
            r = fitz.Rect(t.bbox) & page.rect
            if not r.is_empty and r.get_area() >= 0.005 * page_area:
                out.append(r)
        except Exception:
            continue
    return out


def _cover(inner, outer):
    """inner 面积被 outer 覆盖的比例 0..1。"""
    try:
        inter = inner & outer
        a = inter.get_area() if not inter.is_empty else 0.0
        return a / max(inner.get_area(), 1e-6)
    except Exception:
        return 0.0


def _hit_any(rect, rects, thresh):
    return any(_cover(rect, r) >= thresh for r in rects)


def _line_in_tables(ln, table_rects):
    """单行是否落在任一表格的中线带（表顶-6 ~ 表底+3）且横向重叠。"""
    cy = (ln.y0 + ln.y1) / 2.0
    for r in table_rects:
        if min(ln.x1, r.x1) - max(ln.x0, r.x0) <= 4:
            continue
        if r.y0 - 6 <= cy <= r.y1 + 3:
            return True
    return False


def _in_table(brect, table_rects, caption_rects):
    """表格块判定：覆盖≥50% / 小块中心在内 / 薄行落在表顶-底中线带且横向重叠。
    表头行常略高于表格 rect 顶边，故带 6pt 上余量；caption 块豁免（要翻译）。"""
    cx = (brect.x0 + brect.x1) / 2.0
    cy = (brect.y0 + brect.y1) / 2.0
    for r in table_rects:
        if _cover(brect, r) >= 0.5:
            return True
        x_ov = min(brect.x1, r.x1) - max(brect.x0, r.x0)
        if x_ov <= 4:
            continue
        if r.x0 <= cx <= r.x1 and r.y0 <= cy <= r.y1 and brect.get_area() < r.get_area() * 0.2:
            return True
        if r.y0 - 6 <= cy <= r.y1 + 3 and brect.height < max(r.height * 0.5, 24):
            if not any(_hit_any(brect, [c], 0.5) for c in caption_rects):
                return True
    return False


def _rect_center_in(rect, region):
    cx, cy = (rect.x0 + rect.x1) / 2.0, (rect.y0 + rect.y1) / 2.0
    return region.x0 <= cx <= region.x1 and region.y0 <= cy <= region.y1


def _same_line(r1, r2):
    """两个 rect 是否大致同一行（垂直重叠过半）。"""
    try:
        ov = min(r1.y1, r2.y1) - max(r1.y0, r2.y0)
        return ov > 0.5 * min(r1.height, r2.height)
    except Exception:
        return False

# 仅“数学专用”字体（正文 Roman/Italic 不算公式）
MATH_FONT_RE = re.compile(
    r"CMMI|CMSY|CMSX|CMSL|MSMI|MSBM|NewTXMI|txsy|txmia|txexs|CambriaMath|DejaVuMath"
    r"|LatinMath|MathItalic|XITSMath|stix2math|LatinModernMath|Symbol|Math"
    r"|CMEX|MTMi|MTMi|MTSy|MTEx|MSAM|Euclid|Rsfs|Wingding|MTFont|MTH",
    re.I,
)
CM_MATH_RE = re.compile(r"^(?:\w{6}\+)?(?:CM(?:R\d*|BX|TI|SY|EX|MI|S\d*)|CMS\w+)$")
BOLD_FONT_RE = re.compile(r"Bold|Medi|Bd\b|Black|Bk\b", re.I)
ITALIC_FONT_RE = re.compile(r"Ital", re.I)
MATH_CHARS = set()
for _r in ((0x0391, 0x03A9), (0x03B1, 0x03C9), (0x2070, 0x209F), (0x2080, 0x2089),
           (0x2100, 0x214F), (0x2190, 0x21FF), (0x2200, 0x22FF), (0x2300, 0x23FF),
           (0x2A00, 0x2AFF), (0x2B00, 0x2BFF)):
    MATH_CHARS.update(chr(c) for c in range(_r[0], _r[1] + 1))
MATH_CHARS.update("±×·′″√∞≈≠≤≥∈∂∇∆Δ°∝∑∏⊕⊗⋯")

# 行内公式策略：'text'（默认，v0.13）= 行内符号一律还原为 Unicode 文本交给 LLM 修复；
# 'crop' = 旧行为（裁剪贴图），仅用于 A/B 对照。
INLINE_MATH = (os.environ.get("PDF2ZH_INLINE_MATH") or "text").strip().lower()
INLINE_TEXT_MAX_AREA = float(os.environ.get("PDF2ZH_INLINE_TEXT_AREA", "4000"))
INLINE_TEXT_MAX_CHARS = int(os.environ.get("PDF2ZH_INLINE_TEXT_CHARS", "200"))
# 整行纯公式且宽度超过此值 → 视为独立公式（保留原矢量，不并入正文）
INLINE_LINE_CROP_W = float(os.environ.get("PDF2ZH_INLINE_LINE_W", "150"))

ROMAN_HEAD_RE = re.compile(r"^(I{1,3}|IV|VI{0,3}|IX|XI{0,3})\.\s*[A-Z]")
NUM_HEAD_RE = re.compile(r"^\d{1,2}(\.\d{1,2}){0,2}\.\s+[A-Z][a-z]")
REF_HEAD_RE = re.compile(r"^\s*references?\b\.?\s*$", re.I)
COVER_MARKERS = ("See discussions, stats, and author profiles",
                 "The user has requested enhancement")


class Line:
    __slots__ = ("x0", "y0", "x1", "y1", "text", "size", "is_math", "is_bold",
                 "is_italic", "runs", "segs", "mr", "base")

    def __init__(self, x0, y0, x1, y1, text, size, is_math, is_bold, is_italic,
                 runs=None, base=None, span_rects=None):
        self.x0, self.y0, self.x1, self.y1, self.text, self.size = (
            x0, y0, x1, y1, text, size)
        self.is_math, self.is_bold, self.is_italic = is_math, is_bold, is_italic
        # runs: [("t", text, Rect)|("m", Rect)]，混合行才有
        self.runs = runs
        self.base = base if base is not None else (y1 - 0.79 * size)
        # 原位渲染需要：segs=可擦除文本矩形列表；mr=行内公式障碍矩形列表。
        # 优先 span 级矩形（tight，不吞页边距幻影 bbox）；合并条件=同行且间隙≤2.5pt。
        def _accum(dst, r):
            if dst:
                p = dst[-1]
                gap = r.x0 - p.x1
                if gap <= 2.5 and _same_line(p, r):
                    dst[-1] = p | r
                    return
            dst.append(fitz.Rect(r))
        segs, mrs = [], []
        if span_rects:
            for r, is_m in span_rects:
                _accum(mrs if is_m else segs, r)
        else:
            for kind, _txt, rr in (runs or []):
                if rr is None:
                    continue
                _accum(mrs if kind == "m" else segs, rr)
        if is_math and not mrs:
            mrs = [fitz.Rect(x0, y0, x1, y1)]
            segs = []
        elif not runs and not span_rects:
            segs = [fitz.Rect(x0, y0, x1, y1)]
        self.segs = segs
        self.mr = mrs


class Tok:
    """段落 token：kind='t' 文本 / kind='m' 公式（原页裁剪矩形）。"""
    __slots__ = ("kind", "text", "rect")

    def __init__(self, kind, text=None, rect=None):
        self.kind, self.text, self.rect = kind, text, rect


class Paragraph:
    def __init__(self, pid, page, col, tokens, x0, y0, x1, y1, font_size,
                 is_heading, is_ref, line_count, is_skip=False, lines=None):
        self.pid, self.page, self.col = pid, page, col
        self.tokens = tokens
        self.lines = lines or []  # 原位渲染用：行对象（含 base/segs/mr 几何）
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
        self.tables = []       # 表格区域 Rect（原样贴图不翻译）
        self.protected = []    # [(Rect, cover_threshold, kind)] 图/表保护区域
        self.figure_blocks = []  # 图内文字块 Rect（不翻译、不擦除、不回填）
        self.skipped_header_footer = 0
        self.inline_math_crop = 0   # 行内公式被迫贴图计数（v0.13 目标恒为 0）


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
        out = []
        for p in self.all_paragraphs():
            if p.is_math or p.is_ref or p.is_skip:
                continue
            t = [c for c in p.text if not c.isspace()]
            co = sum(1 for c in t if unicodedata.category(c) == "Co")
            if t and co > len(t) * 0.15:
                continue  # 残留私有区字形的碎片块：不翻译（渲染层会兜底贴图）
            out.append(p)
        return out

    def stats(self):
        ps = list(self.all_paragraphs())
        return {
            "pages": len(self.pages),
            "paragraphs": len(ps),
            "to_translate": len(self.translatable_paragraphs()),
            "math_items": sum(len(p.math_rects) for p in ps),
            "images": sum(len(pg.images) for pg in self.pages),
            "tables": sum(len(pg.tables) for pg in self.pages),
            "figure_blocks": sum(len(pg.figure_blocks) for pg in self.pages),
            "protected_regions": sum(len(pg.protected) for pg in self.pages),
            "inline_math_crop": sum(pg.inline_math_crop for pg in self.pages),
            "cover_skipped": self.cover_skipped,
        }


# ---------------------------------------------------------------- helpers

def _numeric_table_like(text, lines):
    """数字/占比为主的密行块（漏检的数值表格）：不翻译不擦除，原样留在页面上。"""
    t = [c for c in text if not c.isspace()]
    if len(t) < 24 or len(lines) < 3:
        return False
    dig = sum(1 for c in t if c.isdigit() or c in ".,%–-−~()")
    if dig / len(t) < 0.35:
        return False
    words = re.findall(r"\S+", text)
    if not words or sum(len(w) for w in words) / len(words) > 5.5:
        return False
    multi = sum(1 for l in lines
                if len(l.text.split()) >= 3
                and sum(1 for c in l.text if c.isdigit()) >= 2)
    return multi >= max(2, int(0.6 * len(lines)))


def _ruled_tables(page):
    """find_tables(lines 策略)：只认有框线的表，安全兜底/增补 GNN。"""
    try:
        tf = page.find_tables(strategy="lines")
    except Exception:
        return []
    out = []
    page_area = max(page.rect.get_area(), 1.0)
    for t in getattr(tf, "tables", []):
        try:
            if t.row_count < 2 or t.col_count < 2:
                continue
            r = fitz.Rect(t.bbox) & page.rect
            if r.is_empty:
                continue
            a = r.get_area()
            if 0.004 * page_area <= a <= 0.55 * page_area:
                out.append(r)
        except Exception:
            continue
    return out


def _census_math_fonts(doc):
    """全文档字体普查 → 数学字体集合。
    常规数学字体（CMMI/Symbol/Cambria Math/STIX…）直接算；CM 正文族
    （CMR/CMBX/CMTI）只有在全文占比很低（说明仅出现在数学上下文）才算；
    其余字体若样本密度高且占比低也算（PUA/希腊字母子集）。"""
    cnt, den = {}, {}
    tot = 0
    try:
        for page in doc:
            for b in page.get_text("dict").get("blocks", []):
                if b.get("type") != 0:
                    continue
                for ln in b.get("lines", []):
                    for sp in ln.get("spans", []):
                        txt = sp.get("text", "")
                        if not txt.strip():
                            continue
                        f = sp.get("font", "") or "?"
                        cnt[f] = cnt.get(f, 0) + len(txt)
                        den[f] = den.get(f, 0) + sum(
                            1 for c in txt
                            if unicodedata.category(c) in ("Sm", "Co", "Nd")
                            or c in MATH_CHARS or c in ".,%()")
                        tot += len(txt)
    except Exception:
        return set()
    out = set()
    for f, c in cnt.items():
        share = c / max(tot, 1)
        if MATH_FONT_RE.search(f):
            out.add(f)
        elif CM_MATH_RE.match(f) and share < 0.15:
            out.add(f)
        elif share < 0.06 and den.get(f, 0) / max(c, 1) > 0.75:
            out.add(f)
    return out


def _math_density(text):
    t = [c for c in text if not c.isspace()]
    if not t:
        return 0.0
    n = sum(1 for c in t if c in MATH_CHARS or unicodedata.category(c) in ("Sm", "Co"))
    return n / len(t)


def _reconstruct_inline_math(spans):
    """把「行内公式块」还原成可交给 LLM 的文本（如 `k ∈ R^c`）。

    spans: [(Rect, text)] —— 调用方从原始块收集的 span 文本与矩形。
    返回 None 表示**无法**还原为文本（含无法解码的私有区字形），调用方兜底裁图。
    v0.13 起行内公式默认全部文本化：只有「解码后仍是私有区码位」的极少数情况
    才退回裁图（实测语料 0 例）。
    """
    if not spans:
        return None
    dec = [(_rr, _decode_symbol_pua(t or "")) for _rr, t in spans]
    # 解码后仍含私有区字形（未收录的 Symbol 子集）→ 无法安全文本化
    for _rr, t in dec:
        if _is_math_span_text(t):
            return None
    ordered = sorted(dec, key=lambda s: (round(s[0].y0, 1), s[0].x0))
    parts = []
    for rr, t in ordered:
        s = t.strip()
        if not s:
            continue
        if parts and rr.x0 - parts[-1][0] > 1.2:
            parts.append((rr.x1, " "))
        parts.append((rr.x1, s))
    txt = re.sub(r"\s+", " ", "".join(p[1] for p in parts)).strip()
    if not txt or len(txt) > INLINE_TEXT_MAX_CHARS:
        return None
    return txt


# Adobe Symbol / CMSymbol 编码常把 ≦∑∈ 等映射到私有区 U+F0xx（PUA）。这些码位
# 渲染成文本会变豆腐块，必须按 Symbol 编码表还原成真正的 Unicode 数学符号。
_SYMBOL_PUA = {
    "\uf0a2": "′", "\uf0a3": "≤", "\uf0a4": "⁄", "\uf0a5": "∞", "\uf0b0": "°",
    "\uf0b1": "±", "\uf0b2": "″", "\uf0b3": "≥", "\uf0b4": "×", "\uf0b5": "∝",
    "\uf0b6": "∂", "\uf0b7": "•", "\uf0b8": "÷", "\uf0b9": "≠", "\uf0ba": "≡",
    "\uf0bb": "≈", "\uf0bc": "…", "\uf0c4": "⊗", "\uf0c5": "⊕", "\uf0c6": "∅",
    "\uf0c7": "∩", "\uf0c8": "∪", "\uf0c9": "⊃", "\uf0ca": "⊇", "\uf0cc": "⊂",
    "\uf0cd": "⊆", "\uf0ce": "∈", "\uf0cf": "∉", "\uf0d0": "∠", "\uf0d1": "∇",
    "\uf0d5": "∏", "\uf0d6": "√", "\uf0d7": "⋅", "\uf0d8": "¬", "\uf0d9": "∧",
    "\uf0da": "∨", "\uf0db": "⇔", "\uf0dc": "⇐", "\uf0dd": "⇑", "\uf0de": "⇒",
    "\uf0df": "⇓", "\uf0e0": "◊", "\uf0e1": "⟨", "\uf0e5": "∑", "\uf0f1": "⟩",
    "\uf0f2": "∫", "\uf0f3": "⌠", "\uf0f5": "⌡", "\uf022": "∀", "\uf024": "∃",
    "\uf027": "∋", "\uf02a": "∗", "\uf02d": "−", "\uf03d": "=", "\uf02b": "+",
    "\uf03c": "<", "\uf03e": ">", "\uf05c": "∴", "\uf05e": "⊥", "\uf07e": "∼",
    "\uf0a2": "′", "\uf0b7": "•", "\uf0d7": "⋅", "\uf0b4": "×", "\uf0b8": "÷",
    "\uf0e6": "(", "\uf0e7": ")", "\uf0e8": "[", "\uf0e9": "]",
    "\uf0ea": "{", "\uf0eb": "}", "\uf0ec": "⟨", "\uf0ed": "⟩", "\uf0ee": "|",
}
# 希腊字母：Symbol 编码 0x61-0x7A → α-ω，0x41-0x5A → Α-Ω
for _i in range(26):
    _SYMBOL_PUA[chr(0xF061 + _i)] = chr(0x03B1 + _i)
    _SYMBOL_PUA[chr(0xF041 + _i)] = chr(0x0391 + _i)


def _decode_symbol_pua(t):
    """Symbol/CMSymbol 私有区码位 → 真 Unicode 数学符号（无 PUA 时原样返回）。"""
    if not any("\ue000" <= c <= "\uf8ff" for c in t):
        return t
    return "".join(_SYMBOL_PUA.get(c, c) for c in t)


# 排版引擎把公式拆成碎块时泄漏出的 LaTeX 残片（如 "\b e gin"、"^{"、"}_{ij}"）。
# 这些字符流没有语义，混进正文会同时污染译文与排版，故在提取阶段剔除。
_LATEX_CMD_RE = re.compile(r"\\[A-Za-z]{1,}")
_MATH_TOKEN_RE = re.compile(
    r"""^(?:
        [(){}\[\]|&^_=+*/<>~.,;:!?'"`\\-]+      # 纯符号碎片
      | [A-Za-z]{1,3}[_^]\{?[^}]{0,12}\}?        # 上下标片段 a_{ij}
      | \\?[A-Za-z]{1,2}\s+[A-Za-z]{1,3}\s+[A-Za-z]{1,3}   # \b e gin
    )$""", re.X)


def _is_math_debris(tok):
    """token 是否为公式排版碎块/LaTeX 残片（而非正常文字）。

    只在高置信时返回 True：带反斜杠命令、含**硬数学字符**（^ _ \\ { } | & < > ~ = + * /
    及 ∑∈≤ 等）的短碎片。v0.13 起行内公式已改为文本流，故这里刻意不误伤
    逗号/括号/句点等正常标点 —— 否则正经公式会被整段吃掉。
    """
    t = tok.strip()
    if not t or len(t) > 40:
        return False
    if _LATEX_CMD_RE.search(t):        # \begin / \hat / \text
        return True
    core = [c for c in t if not c.isspace()]
    if not core:
        return False
    hard = [c for c in core if c in _HARD_MATH_CHARS]
    if not hard:
        return False                   # 纯标点/纯字母：一律保留
    if all(c in MATH_CHARS or unicodedata.category(c) in ("Sm", "Co")
           or c in "\\{}^_[]|&<>~" for c in core):
        alpha = sum(1 for c in core if c.isalpha())
        return alpha <= max(1, len(core) // 3)
    return bool(_MATH_TOKEN_RE.match(t) and not re.search(r"\d{2,}", t))


# 只有这些字符才让一个 token 够格被判定为「公式碎片」：正常标点（,.()[]:;!?）
# 与普通单词不在其列，避免把正文误删。
_HARD_MATH_CHARS = set("\\^_{}|&<>~=+*/∑∏√≤≥≠≈×±∂∇⊂⊃⊆⊇∈∉∩∪∅⋅∝∞∫")


def _is_math_span_text(text):
    """span 文本以私有区字形为主（SymbolMT/CMSymbol 等子集字体的 ≦∑= 常映射到 U+F0xx 码位）。"""
    t = [c for c in text if not c.isspace()]
    if not t:
        return False
    co = sum(1 for c in t if unicodedata.category(c) == "Co")
    return co >= max(1, len(t) // 2)


def _xaligned(b, cur):
    """块与当前段落是否同一文本栏：水平重叠占较窄块宽度 >55%。
    左右栏互斥，通栏块可与任一栏续接（与 col 语义一致），行尾参差不误伤。"""
    ov = min(b["x1"], cur["x1"]) - max(b["x0"], cur["x0"])
    w = min(b["x1"] - b["x0"], cur["x1"] - cur["x0"])
    return w > 0 and ov / w > 0.55


def _line_is_math(spans):
    total = sum(len(t) for t, _ in spans) or 1
    math_chars = sum(len(t) for t, f in spans if MATH_FONT_RE.search(f or ""))
    if math_chars / total > 0.5:
        return True
    return _math_density("".join(t for t, _ in spans)) > 0.45


def _span_runs(span_meta):
    """把行内 span 合并成有序 run：[('t', text, Rect) | ('m', text, Rect)]；
    纯文本行为 None（省内存，行级 segs 直接取整行 bbox）。

    数学 run 也**保留原文**（此前只留矩形）：渲染时若判定为「行内小符号」，
    需要把符号交回文本流给 LLM（见 _block_text_toks），没有原文就只能裁图。
    """
    runs = []
    for txt, bbox, is_math in span_meta:
        try:
            r = fitz.Rect(bbox)
        except Exception:
            r = None
        if r is not None and (r.is_empty or not r.is_valid):
            r = None
        if is_math:
            if r is None:
                continue
            if runs and runs[-1][0] == "m":
                pr = runs[-1][2]
                runs[-1] = ("m", runs[-1][1] + txt, (pr | r) if pr else r)
            else:
                runs.append(("m", txt, r))
        else:
            if not txt:
                continue
            if runs and runs[-1][0] == "t":
                runs[-1] = ("t", runs[-1][1] + txt,
                            (runs[-1][2] | r) if (runs[-1][2] and r) else (runs[-1][2] or r))
            else:
                runs.append(("t", txt, r))
    kinds = {k for k, _, _ in runs}
    return runs if "m" in kinds else None


def _split_blocks_at_tables(blocks, table_rects, caption_rects):
    """表格浮动插在段落中间时，整块 bbox 会横跨表格：按行把块切成
    表前/表后独立子块，表带内的行丢弃（由贴图呈现）。"""
    if not table_rects:
        return blocks
    def in_band(ln):
        r = fitz.Rect(ln.x0, ln.y0, ln.x1, ln.y1)
        if _hit_any(r, caption_rects, 0.5):
            return False
        return _line_in_tables(ln, table_rects)
    out = []
    for b in blocks:
        seg, segs = [], []
        for ln in b["lines"]:
            if in_band(ln):
                if seg:
                    segs.append(seg)
                seg = []
            else:
                seg.append(ln)
        if seg:
            segs.append(seg)
        if not segs:
            continue
        if len(segs) == 1 and segs[0] == b["lines"]:
            out.append(b)
            continue
        for s in segs:
            nb = dict(b)
            nb["lines"] = s
            nb["y0"] = min(l.y0 for l in s)
            nb["y1"] = max(l.y1 for l in s)
            nb["x0"] = min(l.x0 for l in s)
            nb["x1"] = max(l.x1 for l in s)
            out.append(nb)
    return out


def _block_text_toks(lines):
    """含混合行的块 → token 流；否则 None（走单 Tok 老路径）。

    v0.13：**行内数学 run 一律还原为 Unicode 文本**，不再裁剪贴图 —— 剪贴图会
    错位、会在原位留下孤立残字，而且 LLM 已经能把符号修复成可渲染的公式。
    只有同时满足「整行纯公式」且「足够宽（>= INLINE_LINE_CROP_W）」的行才按
    独立公式处理（保留原矢量/贴图）；无法解码的私有区字形同样兜底为贴图。
    """
    if not any(getattr(l, "runs", None) for l in lines):
        return None
    out = []
    for ln in lines:
        runs = getattr(ln, "runs", None) or [("t", ln.text, None)]
        has_text = any(k == "t" and (v or "").strip() for k, v, _r in runs)
        pure_math_line = bool(runs) and all(k == "m" for k, _v, _r in runs)
        for tup in runs:
            kind = tup[0]
            payload = tup[2] if kind == "m" else tup[1]
            if kind == "t":
                t = re.sub(r"\s+", " ", payload).strip()
                if t:
                    out.append(Tok("t", text=t))
                continue
            # 数学 run：默认文本化（解码 Symbol 私有区字形后交给 LLM）
            txt = _decode_symbol_pua(tup[1] or "")
            wide = payload is not None and payload.width >= INLINE_LINE_CROP_W
            display = pure_math_line and wide
            if (INLINE_MATH == "text" and not display
                    and txt.strip() and not _is_math_span_text(txt)):
                out.append(Tok("t", text=re.sub(r"\s+", " ", txt).strip()))
                continue
            if out and out[-1].kind == "m" and _same_line(out[-1].rect, payload) \
                    and payload.x0 - out[-1].rect.x1 <= 2.5:
                out[-1] = Tok("m", rect=out[-1].rect | payload)
            else:
                out.append(Tok("m", rect=payload))
    merged = []
    for tk in out:
        if tk.kind == "t" and merged and merged[-1].kind == "t":
            merged[-1] = Tok("t", text=merged[-1].text + " " + tk.text)
        else:
            merged.append(Tok(tk.kind, text=tk.text, rect=tk.rect))
    # 相邻数学 run 合并成一个矩形：同一表达式常被切成多个 run（如 `k` + `∈R^c`），
    # 不合并就变成多个裁剪图 + 多个占位符，译文里出现 `t ⟨1⟩ ⟨2⟩ , forming` 这种碎片。
    compact = []
    for tk in merged:
        if (tk.kind == "m" and compact and compact[-1].kind == "m"
                and tk.rect is not None and compact[-1].rect is not None):
            prev = compact[-1]
            gap = tk.rect.x0 - prev.rect.x1
            vov = min(prev.rect.y1, tk.rect.y1) - max(prev.rect.y0, tk.rect.y0)
            same_line = vov > 0.4 * min(prev.rect.height, tk.rect.height)
            if same_line and gap <= 3.0:
                compact[-1] = Tok("m", rect=prev.rect | tk.rect)
                continue
        # 两块数学之间的纯标点（如公式里的逗号）并回数学块：否则会裁出
        # 一个孤立逗号图片、或在中文回填里留下悬空标点
        if (tk.kind == "t" and re.fullmatch(r"[\s,;:.。，；：、]+", tk.text or "")
                and compact and compact[-1].kind == "m"):
            compact[-1] = Tok("m", rect=compact[-1].rect)
            continue
        compact.append(tk)
    merged = compact
    # 剔除纯 LaTeX/排版碎块 token：它们不进译文（否则会以原文形态叠印在正文里）
    merged = [tk for tk in merged if tk.kind != "t" or not _is_math_debris(tk.text)]
    return merged or None


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


def _split_blocks_by_column(blocks, mid, two_col):
    """把「行跨越栏间距」的块按栏切开（双栏页专用）。

    源 PDF 的文本层常把左右两栏的行塞进同一个 block，`_merge_blocks` 的续段逻辑
    会把它并成一段 —— 于是译文横跨两栏、压在另一栏正文上（v0.12 实测主要叠印
    来源）。此处按行所属栏把块切开，使每段只属于一栏，后续列内排版才有正确宽度。
    """
    if not two_col:
        return blocks
    lo, hi = mid - 6.0, mid + 6.0

    def side(ln):
        c = (ln.x0 + ln.x1) / 2.0
        if c < lo:
            return 0
        if c > hi:
            return 1
        return None          # 落在栏间距上：随上一行

    out = []
    for b in blocks:
        cur, cur_side, groups = [], None, []
        for ln in b["lines"]:
            sd = side(ln)
            if sd is None:
                sd = cur_side
            if cur and sd is not None and cur_side is not None and sd != cur_side:
                groups.append(cur)
                cur = []
            cur.append(ln)
            if sd is not None:
                cur_side = sd
        if cur:
            groups.append(cur)
        if len(groups) <= 1:
            out.append(b)
            continue
        for lines in groups:
            if not lines:
                continue
            nb = dict(b)
            nb["lines"] = lines
            nb["x0"] = min(l.x0 for l in lines)
            nb["x1"] = max(l.x1 for l in lines)
            nb["y0"] = min(l.y0 for l in lines)
            nb["y1"] = max(l.y1 for l in lines)
            out.append(nb)
    return out


def _merge_blocks(blocks, mid, protect_fn=None):

    """1) drop cap：单大写字母 + 下一块大写开头 → 合并（小写开头也合并）。
    2) 续段：同栏、小间隙、同字号、前块非句末 → 并入前块。
    protect_fn(line)->True：块内含受保护行（如表格带内）则永不与前块粘连。"""
    def _has_prot(b):
        return protect_fn is not None and any(protect_fn(l) for l in b["lines"])
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
    def _mathish(bk):
        ls = bk["lines"]
        return ls and sum(1 for l in ls if l.is_math) > len(ls) / 2.0

    out2 = [dict(out[0])] if out else []
    for b in out[1:]:
        if _has_prot(b):
            out2.append(dict(b))
            continue
        prev = out2[-1]
        if _has_prot(prev):
            out2.append(dict(b))
            continue
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
            and not _mathish(prev) and not _mathish(b)
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
    """原位渲染不贴图（原页位图自然保留），位图仅作障碍矩形用于回填高度限制。"""
    out = []
    for img in page.get_images(full=True):
        xref = img[0]
        try:
            rects = page.get_image_rects(xref)
        except Exception:
            continue
        for r in rects:
            r = r & fitz.Rect(0, 0, width, page.rect.height)
            if r.width > 25 and r.height > 25:
                out.append((fitz.Rect(r), None))
    return out


# ---------------------------------------------------------------- main

def _looks_bibliography(blocks):
    """参考文献页特征：密集成串的年份/(作者, 年份)/DOI 行。这类页面不需要表格检测。"""
    if not blocks:
        return False
    hits = 0
    for b in blocks[:120]:
        t = _block_text(b)
        if len(t) < 20:
            continue
        if re.search(r"\b(19|20)\d{2}\b", t) and re.search(r"[,\(]\s*[A-Z][a-z]+", t):
            hits += 1
        elif re.search(r"doi|https?://|vol\.|pp\.", t, re.I):
            hits += 1
    return hits >= max(3, int(0.25 * len(blocks)))


def _page_tables(page, blocks):
    """表格区域：protect 模块（lines + text 双策略）优先，失败回退旧实现。"""
    if PROT is not None:
        if _looks_bibliography(blocks):
            return []
        try:
            out = PROT.table_rects(page, use_text_strategy=True)
            # find_tables 对无双线的三线表常漏检 → 数值块兜底补充
            out = out + PROT.numeric_table_blocks(page, blocks)
            ded = []
            for r in out:
                if not any(_cover(r, q) > 0.9 for q in ded):
                    ded.append(r)
            return ded
        except Exception:
            pass
    return find_tables_fallback(page) + _ruled_tables(page)


def extract_paper(path):
    doc = fitz.open(path)
    paper = Paper(path)
    math_fonts = _census_math_fonts(doc)
    H_MARGIN = 45

    for pno in range(len(doc)):
        page = doc[pno]
        raw = page.get_text("dict")
        W, H = page.rect.width, page.rect.height
        lay = layout_for_page(page)
        formula_rects = lay["formula"] if lay else []

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
                span_meta = []
                span_rects = []
                base_y = None
                for sp in ln.get("spans", []):
                    txt = sp.get("text", "")
                    font = sp.get("font", "")
                    sb = sp.get("bbox") or ln["bbox"]
                    ltext += txt
                    spans.append((txt, font))
                    is_math_sp = (font in math_fonts) or _is_math_span_text(txt)
                    if not is_math_sp and formula_rects and txt.strip():
                        try:
                            sc = fitz.Rect(sb)
                            sc.y0, sc.y1 = (sc.y0 + sc.y1) / 2.0 - 0.5, \
                                (sc.y0 + sc.y1) / 2.0 + 0.5
                            sc.x0, sc.x1 = (sc.x0 + sc.x1) / 2.0 - 0.5, \
                                (sc.x0 + sc.x1) / 2.0 + 0.5
                            is_math_sp = any(_cover(sc, r) >= 0.99
                                             for r in formula_rects)
                        except Exception:
                            pass
                    if base_y is None and txt.strip() and sp.get("origin"):
                        base_y = sp["origin"][1]
                    span_meta.append((txt, sb, is_math_sp))
                    if txt.strip():
                        try:
                            sr = fitz.Rect(sb)
                            if sr.is_valid and not sr.is_empty:
                                span_rects.append((sr, is_math_sp))
                        except Exception:
                            pass
                    n = max(len(txt), 1)
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
                                  ital_chars / tot > 0.5,
                                  runs=_span_runs(span_meta), base=base_y,
                                  span_rects=span_rects))
            if not lines:
                continue
            for sb in _split_heading_lines({"x0": x0, "y0": y0, "x1": x1,
                                            "y1": y1, "lines": lines}):
                blocks.append(sb)

        mid = W / 2
        indexed = [(b["x0"], b["y0"], b["x1"], b["y1"], b) for b in blocks]
        ordered, two_col = _reading_order(page, indexed)
        ordered_dicts = [b[4] for b in ordered]

        if lay is not None:
            table_rects = list(lay["table"])
            if _TABLES_ENV not in ("off", "0", "no"):
                table_rects += _ruled_tables(page)
        else:
            table_rects = _page_tables(page, blocks)
        pgd = PageData(pno + 1, W, H, two_col)
        pgd.tables = list(table_rects)
        cap_rects = lay["caption"] if lay else []
        # 图/表保护区域：位图、矢量图形块、表格区
        if PROT is not None:
            try:
                pgd.protected = PROT.protected_regions(page, raw.get("blocks") or [],
                                                       table_rects)
            except Exception:
                pgd.protected = []
        ordered_dicts = _split_blocks_at_tables(ordered_dicts, table_rects, cap_rects)
        ordered_dicts = _split_blocks_by_column(ordered_dicts, mid, two_col)
        merged = _merge_blocks(ordered_dicts, mid,
                               protect_fn=(lambda l: _line_in_tables(l, table_rects))
                               if table_rects else None)

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
            brect = fitz.Rect(b["x0"], b["y0"], b["x1"], b["y1"])

            if b["y1"] < H_MARGIN or b["y0"] > H - H_MARGIN:
                if len(text) < 80:
                    pgd.skipped_header_footer += 1
                    continue
            if lay and _hit_any(brect, lay["header"] + lay["footer"], 0.55):
                pgd.skipped_header_footer += 1
                continue
            if lay and _hit_any(brect, lay["picture"], 0.7):
                continue  # 图内矢量文字：位图/裁剪层已含，重复绘制会花
            if table_rects and _in_table(brect, table_rects,
                                         lay["caption"] if lay else []):
                continue  # 表格区域（含头行中线带）：原样保留，不提取不翻译
            if _numeric_table_like(text, b["lines"]):
                pgd.tables.append(brect)  # 漏检数值表：原位渲染下不碰=零损伤
                continue
            # 图内文字（矢量绘制的流程图标注/图例/坐标轴/图号）：不翻译、不擦除、不回填
            if pgd.protected and PROT is not None:
                try:
                    if PROT.is_figure_text(brect, text, len(b["lines"]),
                                           pgd.protected):
                        pgd.figure_blocks.append(brect)
                        continue
                except Exception:
                    pass

            math_union = None
            if lay:
                for r in lay["formula"]:
                    if _cover(brect, r) >= 0.55 or (
                            _cover(r, brect) >= 0.75
                            and brect.get_area() <= 2.2 * max(r.get_area(), 1.0)):
                        math_union = r if math_union is None else math_union | r
            block_is_math = _block_is_math(b["lines"], b) or \
                (math_union is not None and _gnn_math_plausible(b, math_union))
            font_size = max((l.size for l in b["lines"]), default=9.0)

            if block_is_math:
                mr = (math_union | brect) if math_union is not None else brect
                # 行内公式：必须与当前段落末行同处一线（否则是独立公式，原位保留）
                if (cur is not None and _xaligned(b, cur)
                        and cur["y0"] - 2 <= b["y0"] <= last_text_y1 + 0.6 * font_size
                        and (b["y0"] - cur["y0"]) < 200
                        and _inline_on_last_line(cur, b, font_size)):
                    # v0.13：行内公式一律**还原为 Unicode 文本**交给 LLM 修复，
                    # 不再裁剪贴图（贴图会错位、会在原位留下孤立残字，且模型完全
                    # 有能力把符号修正成可在 PDF 里渲染的写法）。
                    # 唯一的兜底例外：Symbol 私有区字形无法解码 → 仍贴原图保真。
                    if INLINE_MATH != "crop":
                        _spans = []
                        for _ln in b["lines"]:
                            if isinstance(_ln, dict):
                                for _sp in _ln.get("spans", []):
                                    _t = _sp.get("text") or ""
                                    if _t.strip():
                                        try:
                                            _spans.append((fitz.Rect(_sp["bbox"]), _t))
                                        except Exception:
                                            pass
                            else:            # Line 对象（块被拆分/重排过）
                                _t = _ln.text or ""
                                if _t.strip():
                                    _spans.append((fitz.Rect(_ln.x0, _ln.y0,
                                                             _ln.x1, _ln.y1), _t))
                        txt_math = None
                        if _spans and sum(
                                (r.width * r.height) for r, _t in _spans
                        ) <= INLINE_TEXT_MAX_AREA:
                            txt_math = _reconstruct_inline_math(_spans)
                        if txt_math:
                            if cur["tokens"] and cur["tokens"][-1].kind == "t":
                                cur["tokens"][-1] = Tok(
                                    "t", text=(cur["tokens"][-1].text + " "
                                               + txt_math).strip())
                            else:
                                cur["tokens"].append(Tok("t", text=txt_math))
                            cur["y1"] = max(cur["y1"], b["y1"])
                            continue
                        pgd.inline_math_crop += 1   # 无法解码 → 兜底贴图（计数可见）
                    if cur["tokens"] and cur["tokens"][-1].kind == "m" \
                            and _same_line(cur["tokens"][-1].rect, mr) \
                            and abs(mr.x0 - cur["tokens"][-1].rect.x1) < 6:
                        cur["tokens"][-1] = Tok("m", rect=cur["tokens"][-1].rect | mr)
                    else:
                        cur["tokens"].append(Tok("m", rect=mr))
                    cur["y1"] = max(cur["y1"], mr.y1)
                else:
                    # 独立公式段（GNN rect 通常比文字块 bbox 更完整：含上下标）
                    flush()
                    if (pgd.paragraphs and pgd.paragraphs[-1].is_math
                            and not cur):
                        lp = pgd.paragraphs[-1]
                        lr = lp.tokens[0].rect
                        try:
                            inter = (min(mr.y1, lr.y1) - max(mr.y0, lr.y0)) * \
                                (min(mr.x1, lr.x1) - max(mr.x0, lr.x0))
                            if inter >= 0.55 * min(mr.get_area(), lr.get_area()):
                                lr2 = lr | mr
                                lp.tokens[0] = Tok("m", rect=lr2)
                                lp.x0, lp.y0 = min(lp.x0, lr2.x0), min(lp.y0, lr2.y0)
                                lp.x1, lp.y1 = max(lp.x1, lr2.x1), max(lp.y1, lr2.y1)
                                continue
                        except Exception:
                            pass
                    pgd.paragraphs.append(Paragraph(
                        (pno + 1, next(_PID)), pno + 1, col,
                        [Tok("m", rect=mr)],
                        mr.x0, mr.y0, mr.x1, mr.y1, font_size,
                        False, False, 1))
                    # 独立公式登记为保护区：正文既不会擦到它、也不会排到它上面
                    # （公式是页面上最脆弱的矢量内容，任何擦除/叠印都会毁掉它）
                    pgd.protected.append((fitz.Rect(mr), 0.5, "display"))
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

            if lay and _hit_any(brect, lay["section"], 0.6):
                is_heading = True

            is_ref = paper.ref_zone_started
            if re.match(r"^references?\b", first, re.I):
                is_ref = True
                is_heading = True
                paper.ref_zone_started = True

            _gap = b["y0"] - last_text_y1
            # 标题换行续行（如 “MODELS”）：短、全大写、紧跟标题 → 并入标题
            is_head_cont = (
                cur is not None and cur.get("heading") and _xaligned(b, cur)
                and _gap < 1.0 * font_size and len(text) <= 60
                and re.fullmatch(r"[A-Z0-9 \-\.\(\):]+", text))
            btoks = _block_text_toks(b["lines"]) or [Tok("t", text=text)]
            if (cur is not None and _xaligned(b, cur)
                    and _gap < 1.35 * font_size and not is_heading
                    and (is_head_cont or not cur.get("heading"))):
                cur["tokens"].extend(btoks)
                cur["y1"] = max(cur["y1"], b["y1"])
                cur["x1"] = max(cur["x1"], b["x1"])
                cur["x0"] = min(cur["x0"], b["x0"])
                cur["line_count"] += len(b["lines"])
                cur["lines"].extend(b["lines"])
                if not is_skip:
                    cur["skip"] = False  # 合并进正文后整段恢复可翻译
            else:
                flush()
                cur = {"col": col, "x0": b["x0"], "y0": b["y0"], "x1": b["x1"],
                       "y1": b["y1"], "fs": font_size, "heading": is_heading,
                       "ref": is_ref, "skip": is_skip,
                       "tokens": btoks,
                       "lines": list(b["lines"]),
                       "line_count": len(b["lines"]), "head_text": text}
            last_text_y1 = b["y1"]
        flush()

        pgd.images = _extract_images(doc, page, W)
        paper.pages.append(pgd)

    doc.close()
    return paper


def _gnn_math_plausible(b, mr):
    """GNN 公式框可信度闸门：幻觉大框常吞整栏正文——行数/高度/词长任一超标即否。"""
    if mr is None:
        return False
    if len(b["lines"]) > 10:
        return False
    if max(mr.height, b["y1"] - b["y0"]) > 105:
        return False
    words = _block_text(b).split()
    if len(words) >= 40:
        return False
    return sum(len(w) for w in words) / max(len(words), 1) <= 5.4


def _inline_on_last_line(cur, b, fs):
    """公式块是否**与当前段落末行同处一条文本行**（真·行内公式）。

    这是「行内 / 独立公式」的生死判据：判错就会把整条独立公式并进正文翻译掉
    （实测 SPECIAL p4 的公式 (4)、p4 的公式 (1)(2) 都被并进正文）。
    判据三条同时成立才算行内：
      1. 与末行纵向相交（不与任何文本行重叠的块一定是独立公式）；
      2. 中心高差 <= 0.65 行高（独立公式居中另起一行，中心必然被拉到 1 行以外）；
      3. 行内公式块本身不高于 2.2 倍行高（带分式/上下限的行内符号允许稍高）。
    """
    lns = cur.get("lines") or []
    if not lns:
        return False
    ln = lns[-1]
    lh = max(ln.y1 - ln.y0, fs * 0.9)
    cy_b = (b["y0"] + b["y1"]) / 2.0
    cy_l = (ln.y0 + ln.y1) / 2.0
    if abs(cy_b - cy_l) > 0.65 * lh:
        return False
    if min(b["y1"], ln.y1) - max(b["y0"], ln.y0) <= 0.15 * lh:
        return False
    return (b["y1"] - b["y0"]) <= 2.2 * lh


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
        is_skip=cur.get("skip", False), lines=cur.get("lines", []))