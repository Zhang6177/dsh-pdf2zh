#!/usr/bin/env python3
"""pdf2zh v0.13 渲染：把中文译文排进「列几何」，图/表/独立公式整区零改动。

v0.11 的三个致命缺陷与对应修法：
  1. **压字**：行距写死 LINE_H=1.28，而源论文行距常只有 1.0~1.4 倍英文行高
     → 汉字字身高于英文，回填后与下一行叠印。
     修法：`fit.Layout` 把行距与字号强绑定（pitch >= 1.0em），测量即排版。
  2. **越界**：段落可用高度 = 到下一段的小间隙，中文比英文多出的行只能溢出到
     下一段/表格上。
     修法（v0.13）：列内**纵窗流式排版** —— 页面被图/表/独立公式/未译文本切成若干
     可用纵窗，同栏段落按阅读序依次灌入，窗内放满即跳到下一个窗（跨过图形），
     并用统一字号比例把整列压到放得下。
  3. **图内文字被翻译搬到正文**：以矢量文字绘制的图内标注被当成正文提取、翻译、
     回填，正好叠在图上。
     修法：`protect.py` 识别图/表区域，这些区域内的文字不提取、不擦除、不回填。

v0.13 的两条硬承诺：
  * **原文必须保留**：放不下的段落不再擦成留白，而是原样留在页面上（不擦、不回填）；
    `keep` 段落进入障碍带，后续中文绝不压它。
  * **段落可拆**：与公式/图重叠的段落会被拆成「图形上方 + 图形下方」两段分别回填，
    而不是整段放弃。

不可变性：绝不对保护区域内的图元做擦除。
"""
import os
import re
import time
import unicodedata

try:
    import pymupdf as fitz
except ImportError:  # 老版本 PyMuPDF
    import fitz

import fit as FIT
import protect as PROT

CJK_FONT = FIT.CJK_FONT
CJK_FONT_BOLD = FIT.CJK_FONT_BOLD
MIN_FONT_SIZE = FIT.MIN_FONT_SIZE
MATH_ZOOM = int(os.environ.get("PDF2ZH_MATH_ZOOM", "6"))
BODY_MARGIN = float(os.environ.get("PDF2ZH_BODY_MARGIN", "10"))
# 段间最小呼吸量（pt）
PARA_GAP = float(os.environ.get("PDF2ZH_PARA_GAP", "2.0"))
# 可用纵窗的最小高度（pt）：低于此不值得排一行
WINDOW_MIN = float(os.environ.get("PDF2ZH_WINDOW_MIN", "3.0"))
PITCH = float(os.environ.get("PDF2ZH_PITCH", "1.38"))
# 列内流式排版：compact（默认，同栏段落首尾相接、允许上移填缝）| anchor（各段钉在原文 y0）
FLOW = (os.environ.get("PDF2ZH_FLOW") or "compact").strip().lower()


_FALLBACK_FONTS = (
    "~/.local/share/fonts/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
)
_BOLD_FONTS = (
    "~/.local/share/fonts/NotoSansCJKsc-Bold.otf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
)


def _try_font(path, attempts=3):
    """加载字体并校验可用；文件瞬时不可读时重试（后台任务不容一次读盘失败即挂）。"""
    if not path or not os.path.exists(path):
        return None
    for i in range(attempts):
        try:
            fo = fitz.Font(fontfile=path)
            if getattr(fo, "valid", True) and fo.text_length("中", fontsize=10) > 0:
                return fo
        except Exception:
            pass
        time.sleep(0.4 * (i + 1))
    return None


def _resolve_fonts():
    """(常规字体路径, 粗体路径|None)：优先用户字体，失效则回退系统 CJK 字体。"""
    reg = CJK_FONT if os.path.exists(CJK_FONT) else None
    if reg and _try_font(reg, attempts=1) is None:
        reg = None
    if reg is None:
        for cand in _FALLBACK_FONTS:
            p = os.path.expanduser(cand)
            if _try_font(p, attempts=1) is not None:
                reg = p
                break
    bold = CJK_FONT_BOLD if os.path.exists(CJK_FONT_BOLD) else None
    if bold is None:
        for cand in _BOLD_FONTS:
            p = os.path.expanduser(cand)
            if os.path.exists(p):
                bold = p
                break
    return reg, bold


def _resolve_math_font():
    """数学符号回退字体（CJK 字体缺 ⟨⟩⋅⊤⁄ℝ 等）：加载失败返回 (None, None)。"""
    for cand in FIT.MATH_FONT_CANDIDATES:
        p = os.path.expanduser(cand)
        f = _try_font(p, attempts=1)
        if f is not None:
            return p, f
    return None, None


def _font_paths():
    return _resolve_fonts()


def _fill_page_font(page, reg, bold, mathf=None):
    """把中文字体（+数学符号回退字体）写入页面资源；带重试与备用字体。"""
    for cand, name in ((reg, "cjk"), (bold, "cjk_b"), (mathf, FIT.MATH_FONT_NAME)):
        if not cand:
            continue
        last = None
        for i in range(3):
            try:
                page.insert_font(fontname=name, fontfile=cand)
                last = None
                break
            except Exception as e:  # noqa: BLE001
                last = e
                time.sleep(0.4 * (i + 1))
        if last is not None and name != FIT.MATH_FONT_NAME:
            alt = None
            for c in _FALLBACK_FONTS:
                p = os.path.expanduser(c)
                if os.path.exists(p) and _try_font(p, attempts=1) is not None:
                    alt = p
                    break
            if alt:
                page.insert_font(fontname=name, fontfile=alt)
            else:
                raise RuntimeError("中文字体写入失败（%s）: %s" % (cand, last))


# 占位符容错：模型偶尔把 ⟨n⟩ 写成 ⟨3》/〈3〉/《3》等变体，若不归一该公式图会丢失
_PLACEHOLDER_FIX = re.compile(r"[⟨〈《【]\s*(\d{1,3})\s*[⟩〉》】]")


# ---------------------------------------------------------------- LaTeX 兜底
# 提示词已明令禁止 LaTeX，但模型仍会偶发（实测 5 篇共 40+ 处：\mathcal{L}、\hat{M}、
# \times、$\{p_1, p_2\}$…）。渲染器不解析 LaTeX，原样排出来就是一堆反斜杠 ——
# 故在此做**最后一道转写**：美元符 / 反斜杠命令 / 花括号组统统变成可渲染的 Unicode。
_LATEX_SYMBOL = {
    "times": "×", "cdot": "·", "ast": "∗", "star": "⋆", "odot": "⊙",
    "otimes": "⊗", "oplus": "⊕", "circ": "∘", "bullet": "•",
    "in": "∈", "notin": "∉", "ni": "∋", "subset": "⊂", "subseteq": "⊆",
    "supset": "⊃", "supseteq": "⊇", "cup": "∪", "cap": "∩", "emptyset": "∅",
    "le": "≤", "leq": "≤", "ge": "≥", "geq": "≥", "neq": "≠", "ne": "≠",
    "approx": "≈", "equiv": "≡", "sim": "∼", "propto": "∝", "pm": "±",
    "mp": "∓", "div": "÷", "infty": "∞", "partial": "∂", "nabla": "∇",
    "sum": "∑", "prod": "∏", "int": "∫", "sqrt": "√", "angle": "∠",
    "top": "ᵀ", "perp": "⊥", "forall": "∀", "exists": "∃", "neg": "¬",
    "wedge": "∧", "vee": "∨", "rightarrow": "→", "to": "→", "leftarrow": "←",
    "leftrightarrow": "↔", "Rightarrow": "⇒", "Leftarrow": "⇐",
    "Leftrightarrow": "⇔", "ldots": "…", "dots": "…", "cdots": "⋯",
    "quad": " ", "qquad": "  ",
    "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε",
    "varepsilon": "ε", "zeta": "ζ", "eta": "η", "theta": "θ", "iota": "ι",
    "kappa": "κ", "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ", "pi": "π",
    "rho": "ρ", "sigma": "σ", "tau": "τ", "upsilon": "υ", "phi": "φ",
    "varphi": "φ", "chi": "χ", "psi": "ψ", "omega": "ω", "ell": "ℓ",
    "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ",
    "Pi": "Π", "Sigma": "Σ", "Upsilon": "Υ", "Phi": "Φ", "Psi": "Ψ",
    "Omega": "Ω",
}
# \mathbb{R} / \mathcal{L} / \mathrm{d} / \text{if} → 取组内字符（花体无通用 Unicode 解）
_LATEX_WRAP = ("mathbb", "mathcal", "mathbf", "mathrm", "mathit", "mathsf",
               "mathtt", "text", "textbf", "textit", "operatorname",
               "textnormal", "boldsymbol")
# \hat{M} / \bar{x} / \tilde{y} / \vec{v} → 组合附加符
_LATEX_ACCENT = {"hat": "\u0302", "bar": "\u0304", "tilde": "\u0303",
                 "vec": "\u20d7", "dot": "\u0307", "ddot": "\u0308",
                 "check": "\u030c", "breve": "\u0306", "acute": "\u0301",
                 "grave": "\u0300"}
_LATEX_GROUP = re.compile(r"\\(" + "|".join(_LATEX_WRAP) + r")\s*\{([^{}]*)\}")
_LATEX_ACC = re.compile(r"\\(" + "|".join(_LATEX_ACCENT) + r")\s*\{?([A-Za-z0-9])\}?")
_LATEX_FRAC = re.compile(r"\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}")
_LATEX_SQRT = re.compile(r"\\sqrt\s*\{([^{}]*)\}")
_LATEX_DELIM = re.compile(r"\\(?:left|right|big|Big|bigg|Bigg)\s*")
_LATEX_SIMPLE = re.compile(r"\\([a-zA-Z]+)(\s*)")
_LATEX_ESC = re.compile(r"\\([%&_#$~^{}])")
# 这些命令只是「正体函数名」：去掉反斜杠即可，不动字母
_LATEX_FUNCS = frozenset((
    "log", "ln", "lg", "exp", "sin", "cos", "tan", "cot", "sec", "csc",
    "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "max", "min",
    "arg", "det", "dim", "lim", "sup", "inf", "gcd", "deg", "mod", "bmod",
    "Pr", "rank", "tr", "diag", "softmax", "sigmoid", "relu"))


def desanitize_latex(s):
    """把残留 LaTeX 转写成可渲染的 Unicode（模型没守规矩时的最后一道保险）。"""
    if not s or ("\\" not in s and "$" not in s):
        return s
    t = s
    for _ in range(3):                       # 嵌套花括号组：迭代剥离
        t2 = _LATEX_GROUP.sub(lambda m: m.group(2), t)
        if t2 == t:
            break
        t = t2
    t = _LATEX_FRAC.sub(lambda m: "%s/%s" % (m.group(1), m.group(2)), t)
    t = _LATEX_SQRT.sub(lambda m: "√(%s)" % m.group(1), t)
    t = _LATEX_ACC.sub(lambda m: m.group(2) + _LATEX_ACCENT[m.group(1)], t)
    t = _LATEX_DELIM.sub("", t)
    t = re.sub(r"\\begin\s*\{[^{}]*\}", " ", t)   # cases/aligned 环境
    t = re.sub(r"\\end\s*\{[^{}]*\}", " ", t)
    t = t.replace("\\\\", "；").replace("&", "，")

    def _cmd(m):
        name, sp = m.group(1), m.group(2)
        if name in _LATEX_SYMBOL:
            return _LATEX_SYMBOL[name] + sp
        if name in _LATEX_FUNCS:
            return name + sp
        return m.group(0)          # 未知命令原样保留（别把 C:\Users 这类正文改坏）

    t = _LATEX_SIMPLE.sub(_cmd, t)
    t = _LATEX_ESC.sub(lambda m: m.group(1), t)
    t = t.replace("$$", "").replace("$", "")
    t = t.replace("\\{", "{").replace("\\}", "}")
    return re.sub(r"[ \t]{2,}", " ", t)


def _norm(s):
    """上下标展开 → NFKC → LaTeX 兜底 → 占位符括号容错。

    顺序要紧：上下标字符（ᵀ/ₖ/²）必须**在 NFKC 之前**展开成 ^{T}/_{k}/^{2}，
    否则会被 NFKC 退化成普通字符、丢失上下标语义（公式就排不成公式了）。
    """
    t = FIT.expand_scripts(s or "")
    t = unicodedata.normalize("NFKC", t)
    t = desanitize_latex(t)
    return _PLACEHOLDER_FIX.sub(lambda m: "⟨%s⟩" % m.group(1), t)


def cjk_split(s):
    """兼容旧接口：CJK 感知分词（新排版走 fit.tokens）。"""
    out, cur = [], ""
    for ch in s:
        if ("\u4e00" <= ch <= "\u9fff") or ch in FIT._CJK_PUNCT:
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


def _apply_redactions(page):
    try:
        page.apply_redactions(
            images=fitz.PDF_REDACT_IMAGE_NONE,
            graphics=fitz.PDF_REDACT_LINE_ART_NONE)
    except TypeError:  # 老版本无 graphics 参数
        try:
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
        except Exception:
            page.apply_redactions()


def _put_math(page, src_page, pno, r, dest, warnings):
    """兜底：无法用字体渲染的区域，从源页高清裁剪贴回（不翻译、不改字）。"""
    try:
        clip = (fitz.Rect(r) + (-1.0, -1.5, 1.0, 1.5)) & src_page.rect
        if clip.is_empty:
            clip = fitz.Rect(r) & src_page.rect
        if clip.is_empty:
            return
        pix = src_page.get_pixmap(clip=clip, matrix=fitz.Matrix(MATH_ZOOM, MATH_ZOOM),
                                  alpha=False)
        page.insert_image(dest, stream=pix.tobytes("png"))
    except Exception as e:  # noqa: BLE001
        if warnings is not None:
            warnings.append("p%d 公式贴图失败: %s" % (pno, e))


def _build_layout():
    """模块级排版器：字体只加载一次（CJK 字体 ~16MB，逐页构造太贵）。"""
    reg, bold = _resolve_fonts()
    f_reg = _try_font(reg, attempts=3)
    if f_reg is None:
        return None
    f_bold = _try_font(bold, attempts=1) if bold else None
    _p, f_math = _resolve_math_font()
    fallbacks = [(f_math, FIT.MATH_FONT_NAME)] if f_math is not None else []
    return FIT.Layout(f_reg, f_bold, None, fallbacks=fallbacks)


LAYOUT = _build_layout()


def _body_base_size(paper, font_shrink):
    """正文基准字号：可翻译非标题段落字号（按字数加权）的众数 - 收缩量。"""
    from collections import Counter
    c = Counter()
    for p in paper.translatable_paragraphs():
        if p.is_heading or len(p.text) < 40:
            continue
        c[round(p.font_size, 1)] += len(p.text)
    if not c:
        return None
    base = c.most_common(1)[0][0]
    return max(6.0, float(base) - font_shrink)


def _is_cjk_text(s):
    t = [c for c in s if not c.isspace()]
    if not t:
        return False
    return sum(1 for c in t if "\u4e00" <= c <= "\u9fff") / len(t) > 0.05


# ---------------------------------------------------------------- 页面几何

def _typical_line_width(pgd):
    """页面典型正文行长（行长中位数）：用于给退化段落兜底定宽。"""
    widths = []
    for p in pgd.paragraphs:
        if p.is_math or not p.lines:
            continue
        for l in p.lines:
            w = l.x1 - l.x0
            if w > 30:
                widths.append(w)
    if not widths:
        return 0.0
    widths.sort()
    return widths[len(widths) // 2]


def _fallback_span(pgd, x0):
    """退化段落（源文本层被切成极窄碎片）的兜底区间：向左对齐取典型行长。"""
    tw = _typical_line_width(pgd)
    if tw <= 0:
        return x0, x0 + 100.0
    left = min(x0, 44.0)
    right = min(pgd.width - 20.0, left + tw)
    if right - left < 60.0:
        left, right = max(6.0, x0 - 8.0), min(pgd.width - 6.0, x0 + 220.0)
    return left, right


def _paragraph_span(pgd, p):
    """段落回填区间：本段全部行的横向范围；过窄碎片退化为典型正文宽度。

    为什么不用行首聚类定宽：源 PDF 文本层常把一段正文切成多个碎块，块内混着
    公式行与续行，聚类只取到局部几行会得出 14pt 这类荒谬宽度 —— 中文每行只能
    排 2 个字并纵向溢出。跨栏并集的段落已在提取阶段按栏切开。
    """
    lines = [l for l in p.lines if l.x1 - l.x0 > 4]
    if not lines:
        return _fallback_span(pgd, p.x0)
    x0 = min(l.x0 for l in lines)
    x1 = max(l.x1 for l in lines)
    if x1 - x0 < 8.0:
        return _fallback_span(pgd, x0)
    if x1 - x0 < 70.0 and len(p.text) >= 12:
        # 碎片：源宽度不足以承载成句译文 → 按典型行长向左对齐扩展
        return _fallback_span(pgd, x0)
    return x0, x1


def _as_rect(r):
    rr = r[0] if isinstance(r, (tuple, list)) else r
    try:
        rr = fitz.Rect(rr)
    except Exception:
        return None
    return None if rr.is_empty else rr


def _merge_intervals(iv):
    iv = sorted(iv)
    out = []
    for a, b in iv:
        if out and a <= out[-1][1] + 0.6:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def _windows(x0, x1, y_from, y_to, bands):
    """[y_from, y_to] 内扣除障碍带后的可用纵窗（升序、互不重叠）。

    障碍带 = 图/表/独立公式保护区 + 未译文本行。只要与本段横向相交（>4pt），
    就不能把中文排进去 —— 这是「段落被公式/图切成上下两段分别回填」的实现：
    上窗排到图形上沿，下窗从图形下沿接着排，中间那块原样不动。
    """
    if y_to - y_from <= 1.0:
        return []
    iv = []
    for r in bands:
        if min(x1, r.x1) - max(x0, r.x0) <= 4.0:
            continue
        a, b = max(r.y0, y_from), min(r.y1, y_to)
        if b - a > 0.5:
            iv.append((a, b))
    out, cur = [], y_from
    for a, b in _merge_intervals(iv):
        if a - cur >= WINDOW_MIN:
            out.append((cur, a))
        cur = max(cur, b)
    if y_to - cur >= WINDOW_MIN:
        out.append((cur, y_to))
    return out


def _plan_bottom(plan):
    """plan 实际占用的最低 y（含字身下缘）。"""
    fs, lh = plan["fs"], plan["line_h"]
    last = None
    for (wy0, lines) in plan["placed"]:
        if lines:
            last = wy0 + fs + (len(lines) - 1) * lh
    if last is None:
        return None
    return last + 0.25 * fs


def _regions_of(pgd):
    """页面保护区域（图/表/独立公式）→ [Rect]。"""
    out = []
    for reg in (getattr(pgd, "protected", None) or []):
        rr = _as_rect(reg)
        if rr is not None:
            out.append(rr)
    for blk in (getattr(pgd, "figure_blocks", None) or []):
        try:
            rr = fitz.Rect(blk)
            if not rr.is_empty:
                out.append(rr)
        except Exception:
            continue
    return out


def _cut_out(r, regions):
    """r 减去与保护区域相交的部分 → 若干矩形（保护区内图元绝不擦除）。

    比「一碰保护区就整块放弃」精确得多：正文行常常贴着图/公式边缘，整块放弃会
    让该行的英文残留下来与中文叠印（v0.12 实测残留英文行偏多的原因之一）。
    """
    parts = [r]
    for reg in regions:
        if not parts:
            break
        nxt = []
        for p in parts:
            it = p & reg
            if it.is_empty or it.get_area() < 0.5:
                nxt.append(p)
                continue
            if it.y0 > p.y0 + 0.2:
                nxt.append(fitz.Rect(p.x0, p.y0, p.x1, it.y0))
            if it.y1 < p.y1 - 0.2:
                nxt.append(fitz.Rect(p.x0, it.y1, p.x1, p.y1))
            if it.x0 > p.x0 + 0.2:
                nxt.append(fitz.Rect(p.x0, it.y0, it.x0, it.y1))
            if it.x1 < p.x1 - 0.2:
                nxt.append(fitz.Rect(it.x1, it.y0, p.x1, it.y1))
        parts = [q for q in nxt if q.width >= 1.0 and q.height >= 1.0]
    return parts


def _covered_frac(rect, rects):
    """rect 被 rects 覆盖的比例（用于判断一行原文是否会被整行擦掉）。"""
    a = rect.get_area()
    if a <= 0:
        return 1.0
    tot = 0.0
    for r in rects:
        it = rect & r
        if not it.is_empty:
            tot += it.get_area()
            if tot >= 0.8 * a:
                return 1.0
    return tot / a


# ---------------------------------------------------------------- 主过程

def render_pdf(paper, translations, orig_doc, out_path, warnings=None,
               font_shrink=1.0, protect_regions=True):
    """就地渲染：orig_doc 保持不动（仅作兜底裁剪源）；
    另开可编辑副本做擦除 + 回填，保存到 out_path。"""
    if LAYOUT is None:
        raise RuntimeError("找不到可用的中文字体（候选: %s）" % ", ".join(
            [CJK_FONT] + [os.path.expanduser(c) for c in _FALLBACK_FONTS]))
    reg, bold = _resolve_fonts()
    mathf, _fm = _resolve_math_font()
    font_cjk = _try_font(reg, attempts=3)
    if font_cjk is None:
        raise RuntimeError("找不到可用的中文字体（候选: %s）" % ", ".join(
            [CJK_FONT] + [os.path.expanduser(c) for c in _FALLBACK_FONTS]))
    font_bold = _try_font(bold, attempts=2) if bold else None
    if font_bold is None:
        bold = None
    base_fs = _body_base_size(paper, font_shrink) or 7.0

    doc = fitz.open(paper.path) if paper.path and os.path.exists(paper.path) \
        else fitz.open(stream=orig_doc.write(), filetype="pdf")
    n_kept = 0
    stats = {"fitted": 0, "kept_en": 0, "split": 0, "below_min": 0, "cover_only": 0}

    for pgd in paper.pages:
        page = doc[pgd.pno - 1]
        src_page = orig_doc[pgd.pno - 1]
        y_bot_page = pgd.height - BODY_MARGIN

        regions = _regions_of(pgd)
        if regions:
            PROT.neutralize_drawings(page, regions)

        # 行内公式尺寸表：按段落局部编号（⟨n⟩ 对应该段第 n 个公式矩形）
        per_par_md = {}
        for p in pgd.paragraphs:
            if p.is_math:
                continue
            md = {k: r for k, r in enumerate(p.math_rects, 1)}
            if md:
                per_par_md[p.pid] = md
        LAYOUT.set_math_dims({})

        def _with_dims(job, fn):
            """切换该段自己的公式尺寸表做测量（量完即还原）。"""
            LAYOUT.set_math_dims(per_par_md.get(job["p"].pid) or {})
            try:
                return fn()
            finally:
                LAYOUT.set_math_dims({})

        # ---- 1) 组稿：每段确定「横向区间 + 起始字号」，译不好的留给原文
        jobs = []
        for p in pgd.paragraphs:
            if p.is_math or p.is_ref or p.is_skip or not p.lines:
                continue
            t = translations.get(p.pid)
            if not t:
                n_kept += 1
                continue
            toks = FIT.split_markers(_norm(t), p.math_rects)
            if not toks:
                continue
            if not _is_cjk_text(" ".join(tk[1] for tk in toks if tk[0] == "w")):
                stats["kept_en"] += 1   # 译文不含中文（公式/数字碎片）：保持原样
                continue
            x0, x1 = _paragraph_span(pgd, p)
            fs0 = min(p.font_size, base_fs) if not p.is_heading else \
                min(p.font_size, max(base_fs + 1.0, 8.0))
            jobs.append({"p": p, "toks": toks, "x0": x0, "x1": x1,
                         "w": max(x1 - x0, 1.0), "fs0": max(fs0, MIN_FONT_SIZE),
                         "bold": bool(p.is_heading and font_bold)})
        if not jobs and n_kept == 0:
            continue

        job_paras = {id(j["p"]) for j in jobs}

        # ---- 2) 擦除集：只有「会被擦掉的原文」才是可覆盖区，其余一律是障碍带
        def _redact_rects(p, span=None):
            """该段将被打上擦除标注的矩形（与真正 _add 的完全一致）。

            取「span 级紧密矩形」∪「整行盒」：Word 导出的公式被拆成几十个 span，
            只擦 span 会在 span 缝隙里留下笔画（实测 manuscript-3 的 `=`/`⊗` 就是这样
            残留下来并与中文叠印的）。整行盒补齐缝隙，与保护区相交的部分再切掉。
            """
            out = []
            clip = None
            if span is not None:
                clip = fitz.Rect(min(span), 0, max(span), page.rect.height)
            cand = []
            for ln in p.lines:
                segs = [fitz.Rect(r0) for r0 in (ln.segs or [])]
                mrs = [fitz.Rect(r0) for r0 in (ln.mr or [])]
                if not segs and not mrs:
                    segs = [fitz.Rect(ln.x0, ln.y0, ln.x1, ln.y1)]
                else:
                    segs.append(fitz.Rect(ln.x0, ln.y0, ln.x1, ln.y1))
                cand.extend(segs + mrs)
            for mr in p.math_rects:
                cand.append(fitz.Rect(mr))
            for r in cand:
                r = fitz.Rect(r) + (-0.5, -0.6, 0.5, 0.6)
                if clip is not None:
                    r = r & clip
                r = r & page.rect
                if r.is_empty or r.width < 1 or r.height < 1:
                    continue
                for q in _cut_out(r, regions):
                    if PROT.rect_hits_regions(q, regions):
                        continue
                    out.append(q)
            return out

        erasable = []
        for j in jobs:
            j["erase"] = _redact_rects(j["p"], span=(j["x0"], j["x1"]))
            erasable.extend(j["erase"])
        kept_paras = [p for p in pgd.paragraphs if id(p) not in job_paras]

        # 源页所有文本行 → 减去擦除集 = 仍会留在页面上的文字（硬障碍）
        page_lines = []
        try:
            for b in src_page.get_text("dict").get("blocks", []):
                for l in b.get("lines", []):
                    try:
                        page_lines.append(fitz.Rect(l["bbox"]))
                    except Exception:
                        continue
        except Exception:
            for p in kept_paras:
                for ln in p.lines:
                    page_lines.append(fitz.Rect(ln.x0, ln.y0, ln.x1, ln.y1))
        static_bands = list(regions)
        for r in page_lines:
            if _covered_frac(r, erasable) < 0.75:
                static_bands.append(r)
        # 未参与翻译的段落行（图内文字/参考文献/跳过段）也作为障碍
        for p in kept_paras:
            for ln in p.lines:
                static_bands.append(fitz.Rect(ln.x0, ln.y0, ln.x1, ln.y1))

        # ---- 3) 列内纵窗流式排版：统一字号比例，逐段灌入可用纵窗
        keep = set()        # 放弃回填（保留原文）的段落 id

        def _simulate(ratio, keep_ids):
            placed = []
            plans = {}
            for ji, j in enumerate(jobs):
                if id(j["p"]) in keep_ids:
                    continue
                x0, x1 = j["x0"], j["x1"]
                fs = max(j["fs0"] * ratio, MIN_FONT_SIZE)
                start = j["p"].y0
                prev_bot = None
                for (px0, px1, pbot) in placed:
                    if min(x1, px1) - max(x0, px0) > 4.0:
                        prev_bot = pbot if prev_bot is None else max(prev_bot, pbot)
                if prev_bot is not None:
                    # 同栏已有内容：首尾相接（可上移填空）。旧口径「不得早于原文 y0」
                    # 会让中文比英文短时在栏中留下上百 pt 空洞，而这些空洞又用不上，
                    # 反过来把整页字号比例压到 0.55（实测 HZSCM p4 掉到 4.7pt）。
                    start = prev_bot + PARA_GAP if FLOW == "compact" \
                        else max(prev_bot + PARA_GAP, start)
                if start >= y_bot_page - 2.0:
                    return {"ok": False, "fail": ji, "why": "no_room",
                            "start": start, "ybot": y_bot_page}
                bands = static_bands + [
                    fitz.Rect(ln.x0, ln.y0, ln.x1, ln.y1)
                    for jj in jobs if id(jj["p"]) in keep_ids
                    for ln in jj["p"].lines]
                wins = _windows(x0, x1, start, y_bot_page, bands)
                if not wins:
                    return {"ok": False, "fail": ji, "why": "no_window",
                            "start": start, "ybot": y_bot_page}
                plan = _with_dims(j, lambda: LAYOUT.pack_windows(
                    j["toks"], fs, PITCH, j["w"], wins, bold=j["bold"]))
                if not plan["ok"]:
                    if os.environ.get("PDF2ZH_DEBUG_SIM"):
                        print("[sim] r=%.3f p%d pid=%s fs=%.2f need=%d/%d wins=%s"
                              % (ratio, pgd.pno, j["p"].pid[1], fs, plan["used"],
                                 plan["total"],
                                 [(round(a, 1), round(b, 1)) for a, b in wins]),
                              flush=True)
                    return {"ok": False, "fail": ji, "why": "overflow",
                            "plan": plan, "start": start, "wins": wins}
                plans[ji] = (plan, start)
                placed.append((x0, x1, _plan_bottom(plan) or start))
            return {"ok": True, "plans": plans}

        # 3a) 极端情况：即使全页最小字号也放不下 → 逐个保留原文（原文必须保留）
        for _ in range(len(jobs) + 2):
            r0 = _simulate(0.0, keep)
            if r0["ok"]:
                break
            keep.add(id(jobs[r0["fail"]]["p"]))
            if os.environ.get("PDF2ZH_DEBUG_LAYOUT"):
                _pj = jobs[r0["fail"]]
                print("[keep] p%d pid=%s y0=%.1f span[%.1f-%.1f] lines=%d why=%s "
                      "start=%s wins=%s txt=%s"
                      % (pgd.pno, _pj["p"].pid[1], _pj["p"].y0, _pj["x0"], _pj["x1"],
                         len(_pj["p"].lines), r0.get("why"),
                         round(r0.get("start", 0), 1),
                         r0.get("wins") or r0.get("ybot"),
                         _pj["p"].text[:40]), flush=True)
        else:
            keep = set(id(j["p"]) for j in jobs)

        # 3b) 二分最大统一字号比例
        best = _simulate(0.0, keep)
        ratio = 0.0
        if best["ok"] and _simulate(1.0, keep)["ok"]:
            ratio = 1.0
        elif best["ok"]:
            lo, hi = 0.0, 1.0
            for _ in range(12):
                mid = (lo + hi) / 2.0
                if _simulate(mid, keep)["ok"]:
                    lo = mid
                else:
                    hi = mid
            ratio = lo
        final = _simulate(ratio, keep) if ratio > 0 else best
        plans = final.get("plans") or {}
        if os.environ.get("PDF2ZH_DEBUG_LAYOUT"):
            print("[ratio] p%d jobs=%d ratio=%.3f keep=%d fail=%s" % (
                pgd.pno, len(jobs), ratio, len(keep),
                best.get("why")), flush=True)

        todo = [j for ji, j in enumerate(jobs)
                if ji in plans and id(j["p"]) not in keep]
        stats["fitted"] += len(todo)
        stats["kept_en"] += len(keep)
        n_kept += len(keep)
        for ji, j in enumerate(jobs):
            if id(j["p"]) in keep or ji not in plans:
                continue
            plan, start = plans[ji]
            if len(plan["placed"]) > 1:
                stats["split"] += 1
            j["plan"], j["start"] = plan, start
            if os.environ.get("PDF2ZH_DEBUG_LAYOUT"):
                print("[layout] p%d pid=%s x[%.1f-%.1f] y[%.1f] fs=%.2f lines=%d "
                      "wins=%d used=%d/%d erase=%d" % (
                          pgd.pno, j["p"].pid[1], j["x0"], j["x1"], start,
                          plan["fs"], len(plan["placed"]), len(plan["placed"]),
                          plan["used"], plan["total"], len(j["erase"])), flush=True)

        if not todo:
            continue

        # ---- 4) 擦除：只擦「会被中文替代」的原文；保留原文的段落一字不动
        # 一律带白色填充：MuPDF 的文本删除对某些 Word 导出页**静默失效**
        # （manuscript-3 有 5/35 页，二次擦除/save 往返均无效），此时白底填充仍会
        # 被绘制，从而保证「原文不会与中文叠印」这条视觉底线。
        all_erase = [r for j in todo for r in j["erase"]]
        probe = all_erase[:48]
        n_txt_before = sum(1 for r in probe if page.get_text("text", clip=r).strip())
        for r in all_erase:
            page.add_redact_annot(r, fill=(1, 1, 1), cross_out=False)
        _apply_redactions(page)
        n_txt_after = sum(1 for r in probe if page.get_text("text", clip=r).strip())
        if n_txt_before and n_txt_after > max(1, 0.2 * n_txt_before):
            stats["cover_only"] += 1
            if warnings is not None:
                warnings.append("p%d 文本层擦除失效（MuPDF 限制），已改用白底覆盖 %d 处"
                                % (pgd.pno, n_txt_after))

        _fill_page_font(page, reg, bold, mathf)

        # ---- 5) 回填：逐行避让仍留在页面上的原文（第二道保险）
        replaced = {id(j["p"]) for j in todo}
        kept_hits, seen = [], set()

        def _add_hit(r):
            k = (round(r.x0, 1), round(r.y0, 1), round(r.x1, 1), round(r.y1, 1))
            if k in seen:
                return
            seen.add(k)
            kept_hits.append(r)

        for p in pgd.paragraphs:
            if id(p) in replaced:
                continue
            for ln in p.lines:
                r = fitz.Rect(ln.x0, ln.y0, ln.x1, ln.y1)
                if not PROT.rect_hits_regions(r, regions):
                    _add_hit(r)
        for r in static_bands:      # 页眉/页脚等未进 paragraphs 的残留文字
            if not PROT.rect_hits_regions(r, regions):
                _add_hit(r)

        def _will_collide(cx0, cx1, cy, fs):
            """本行是否与「留下的原文」实质重叠 → 跳过不画。

            以本行字身盒（cy-fs .. cy+0.25fs）与旧行盒求交：汉字墨迹仅占 ~0.72em，
            故按字身而非行盒判定，避免把正常紧排误判成冲突。
            """
            top, bot = cy - 0.82 * fs, cy + 0.28 * fs
            for q in kept_hits:
                if min(cx1, q.x1) - max(cx0, q.x0) <= 6:
                    continue
                if min(bot, q.y1) - max(top, q.y0) > 0.35 * fs:
                    return True
            return False

        for j in todo:
            p, plan = j["p"], j["plan"]
            fs = plan["fs"]
            use_bold = j["bold"]
            fname = "cjk_b" if use_bold else "cjk"
            f = font_bold if use_bold else font_cjk

            # 找不到能画的字体（极端字符集）→ 贴回原图保真，绝不画豆腐块
            _toks_txt = "".join(t[1] for t in plan["toks"]
                                if t[0] in ("w", "sub", "sup"))
            if LAYOUT.missing_chars(_toks_txt, use_bold):
                r = (fitz.Rect(p.x0, p.y0, p.x1, p.y1) + (-1, -1, 1, 1)) & src_page.rect
                _put_math(page, src_page, pgd.pno, r, r, warnings)
                continue

            if plan["fs"] <= MIN_FONT_SIZE + 0.01:
                stats["below_min"] += 1

            def _ins(pg, pt, s, fn, size, _j=j):
                if not s.strip():
                    return
                w = LAYOUT.text_width(s, size, _j["bold"])
                if _will_collide(pt[0], pt[0] + w, pt[1] - size * 0.22, size):
                    _j["skipped"] = _j.get("skipped", 0) + 1
                    return
                pg.insert_text(pt, s, fontname=fn, fontsize=size)

            LAYOUT.draw_windows(page, plan, j["x0"], fname,
                                insert_text_fn=_ins, bold=use_bold)
            if plan["used"] < plan["total"] and warnings is not None:
                warnings.append("p%d 段落下沿越入图/表保护区，已截断 %d 行（字号 %.1f）"
                                % (pgd.pno, plan["total"] - plan["used"], plan["fs"]))
            if warnings is not None and plan["fs"] < 5.0:
                warnings.append("p%d 段落空间紧张，字号降至 %.1f：%s…" % (
                    pgd.pno, plan["fs"], "".join(t[1] for t in plan["toks"]
                                                 if t[0] == "w")[:18]))

    try:
        doc.subset_fonts()
    except Exception:
        pass
    doc.save(out_path, garbage=3, deflate=True)
    doc.close()
    return n_kept


def make_layout(math_dims=None):
    """构造排版器（供 run_pipeline 复用）。"""
    L = _build_layout()
    if L is None:
        raise RuntimeError("找不到可用的中文字体")
    if math_dims:
        L.set_math_dims(math_dims)
    return L
