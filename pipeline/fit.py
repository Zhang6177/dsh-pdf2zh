#!/usr/bin/env python3
"""pdf2zh 版式自适配引擎：把中文译文排进「确定放得下」的矩形里。

设计目标（v0.12 重排版式的核心）：
  1. **绝不压字**：行距 pitch 与字号 fs 强绑定，恒取 pitch >= fs * MIN_PITCH_RATIO。
     汉字字身占满 em 方框，pitch < fs 必然视觉压字 —— 本模块从几何上排除这一可能。
  2. **绝不越界**：在给定可用纵窗内求解最大可读字号；放不下就缩字号，而不是
     让文字溢出到下一个段落/图形上。
  3. **测量即排版**：`plan` 产出的行断点是 `draw` 唯一依据，二者共用同一份
     文本切分（CJK 逐字可断、拉丁词整体），因此「测量多少行」= 「画多少行」，
     不存在测量与回填不一致导致的溢出。
  4. **公式回文本流**（v0.13）：行内公式不再裁剪贴图，而是以 Unicode 文本进入
     排版。`t_k` / `R^{K×c}` / `∑_{i=1}^{n}` 的上下标按真实字号与基线上/下移绘制，
     因此 LLM 修复过的公式能像公式一样落在 PDF 里。
  5. **符号不缺字**：CJK 字体没有 ⟨⟩⋅⊤⁄ℝ 等数学符号，本模块按字符回退到
     DejaVu Sans 等数学字体（测量与绘制用同一套回退表，故宽度依然一致）。

本模块只做纯几何计算，不接触 PDF 写入（便于单测）。
"""
import os
import re
import unicodedata

CJK_FONT = os.path.expanduser("~/.local/share/fonts/NotoSansCJKsc-Regular.otf")
CJK_FONT_BOLD = os.path.expanduser("~/.local/share/fonts/NotoSansCJKsc-Bold.otf")

# 数学符号回退字体（CJK 字体缺 ⟨⟩⋅⊤⁄∘∼ℝℂℕℤ⌈⌉⌊⌋ 等；DejaVu 全覆盖）
MATH_FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    os.path.expanduser("~/.local/share/fonts/DejaVuSans.ttf"),
)
MATH_FONT_NAME = "mathsym"

# 汉字字身高度 ≈ 1.0em；行距低于 1.0em 必然压字。
# 1.30 是「不压字且不显松散」的经验下限，正文优先取 1.38～1.45。
MIN_PITCH_RATIO = float(os.environ.get("PDF2ZH_MIN_PITCH", "1.00"))
TARGET_PITCH_RATIO = float(os.environ.get("PDF2ZH_PITCH", "1.38"))
MIN_PITCH_FLOOR = 1.02      # 极端挤压时允许的绝对下限（仍 > 1.0em，不压字）
MIN_FONT_SIZE = float(os.environ.get("PDF2ZH_MIN_FONT", "4.5"))

# 上下标：字号缩放与基线位移（相对当前字号）
SCRIPT_SUB_SCALE = 0.72
SCRIPT_SUP_SCALE = 0.72
SCRIPT_SUB_DY = 0.14        # 下标基线相对主基线下移
SCRIPT_SUP_DY = 0.38        # 上标基线相对主基线上移

_CJK_PUNCT = set("，。；：？！“”‘’（）《》、—…·．,.;:?!()[]<>\"'/\\")
_MATH_MARK = re.compile(r"[⟨〈《【]\s*(\d{1,3})\s*[⟩〉》】]")
# 上下标写法：`_x`、`^{...}`、`_ij`（`_` 后接单个字母数字）
_SCRIPT_CHARS = "_^"


def _is_cjk(ch):
    return "\u4e00" <= ch <= "\u9fff" or "\u3400" <= ch <= "\u4dbf" or \
        "\u3000" <= ch <= "\u303f" or "\uff00" <= ch <= "\uffef"


def norm(s):
    """NFKC 归一：数学字母数字（𝑥/𝐴/𝜇…）转普通字符，避免字体缺字出豆腐块。"""
    return unicodedata.normalize("NFKC", s or "")


# Unicode 上下标字符（ᵀ ₖ ⁻¹ ² …）在 NFKC 下会退化成普通字符、丢失上下标语义。
# 故在 NFKC **之前**把它们展开成 `^{T}` / `_{k}`，交给 _split_script 走真实上下标排版。
_SUP_RANGES = ((0x00B2, 0x00B3), (0x00B9, 0x00B9), (0x2070, 0x2071),
               (0x2074, 0x207F), (0x1D2C, 0x1D61), (0x1D9C, 0x1DBF),
               (0x02B0, 0x02FF))
_SUB_RANGES = ((0x2080, 0x209C), (0x1D62, 0x1D6A), (0x2090, 0x209C))


def _script_kind(cp):
    for lo, hi in _SUB_RANGES:
        if lo <= cp <= hi:
            return "sub"
    for lo, hi in _SUP_RANGES:
        if lo <= cp <= hi:
            return "sup"
    return None


def expand_scripts(s):
    """ᵀ/ₖ/⁻¹/² → ^{T}/_{k}/^{-1}/^{2}（NFKC 前调用，否则上下标语义丢失）。"""
    if not s:
        return s
    if not any(_script_kind(ord(c)) for c in s):
        return s
    out, run, kind = [], [], None
    for c in s:
        k = _script_kind(ord(c))
        if k != kind or k is None:
            if run:
                out.append(_wrap_script(kind, run))
            run, kind = [], k
        if k is None:
            out.append(c)
        else:
            run.append(unicodedata.normalize("NFKC", c))
    if run:
        out.append(_wrap_script(kind, run))
    return "".join(out)


def _wrap_script(kind, chars):
    return "%s{%s}" % ("^" if kind == "sup" else "_", "".join(chars))


# --------------------------------------------------------------- 上下标切分

def _split_script(s):
    """`R^{K×c}` / `t_k` / `x_ij` / `∑_{i=1}^{n}` → [(kind, text)]。

    kind ∈ {"n","sub","sup"}：
      * `^{...}` / `_{...}`：花括号形式无条件切分；
      * `^x`：上标语义明确，无条件切分；
      * `_x`：只在「前导段 ≤ 3 字符」且「下标组自成词（后随非字母数字）」时切分，
        以免把 snake_case 标识符（`train_test_split`、`self_attention`）排成下标。
    """
    if not s or ("_" not in s and "^" not in s):
        return [("n", s)]
    out, buf = [], []
    i, n = 0, len(s)
    while i < n:
        ch = s[i]
        if ch in _SCRIPT_CHARS and i + 1 < n:
            nxt = s[i + 1]
            if nxt == "{":
                j = s.find("}", i + 2)
                grp, i = (s[i + 2:j], j + 1) if j > i else (s[i + 2:], n)
            elif nxt == "(":
                # `x^(L)` / `x_(i)`：把整个括号组当作上下标（含括号，视觉上更自然）
                j = s.find(")", i + 2)
                grp, k = (s[i + 1:j + 1], j + 1) if j > i else (s[i + 1:], n)
                if ch == "_":
                    tail = s[k] if k < n else ""
                    if len("".join(buf)) > 3 or (tail and tail.isalnum()):
                        buf.append(ch)
                        i += 1
                        continue
                i = k
            else:
                j = i + 1
                k = j
                if k < n and s[k] in "+-" and k + 1 < n and s[k + 1].isalnum():
                    k += 1                      # 带符号的上下标：`10^-3`、`x^+2`
                run_max = 6 if len("".join(buf)) <= 2 else 3
                while k < n and k - j < run_max and s[k].isalnum():
                    k += 1
                grp = s[j:k]
                if not grp:          # 后随非字母数字（如 `^=`）：单字符上下标
                    grp, k = s[i + 1:i + 2], i + 2
                if ch == "_":
                    # 无括号下标只在「前导段很短」或「下标自成词」时成立，
                    # 否则 snake_case 标识符（train_test_split）会被排成下标
                    pre = "".join(buf)
                    tail = s[k] if k < n else ""
                    ok = (len(pre) <= 2 and len(grp) <= 6) or \
                         (not (tail and tail.isalnum()) and len(pre) <= 3
                          and len(grp) <= 3)
                    if not ok:
                        buf.append(ch)
                        i += 1
                        continue
                i = k
            if grp:
                if buf:
                    out.append(("n", "".join(buf)))
                    buf = []
                out.append(("sub" if ch == "_" else "sup", grp))
                continue
        buf.append(ch)
        i += 1
    if buf:
        out.append(("n", "".join(buf)))
    return out or [("n", s)]


def tokens(text):
    """译文 → 排版原子序列。

    返回原子：
      ("w", str)      普通文本（拉丁串已按上下标切成 ("sub"/"sup", str) 原子）
      ("sub", str)    下标
      ("sup", str)    上标
      ("sp",)         空格
      ("math", n)     公式占位符 ⟨n⟩（行内公式已文本化，占位符仅剩少数场景）
    """
    out = []
    i, n = 0, len(text or "")
    while i < n:
        ch = text[i]
        m = _MATH_MARK.match(text, i)
        if m:
            out.append(("math", int(m.group(1))))
            i = m.end()
            continue
        if ch.isspace():
            out.append(("sp",))
            i += 1
            continue
        if _is_cjk(ch):
            out.append(("w", ch))
            i += 1
            continue
        # 拉丁/数字：吃到下一个 CJK 或空格，再按上下标切分
        j = i
        while j < n and not text[j].isspace() and not _is_cjk(text[j]) \
                and not _MATH_MARK.match(text, j):
            j += 1
        for kind, seg in _split_script(text[i:j]):
            out.append(("w" if kind == "n" else kind, seg))
        i = j
    # 合并相邻空格
    merged = []
    for t in out:
        if t[0] == "sp" and merged and merged[-1][0] == "sp":
            continue
        merged.append(t)
    return merged


class Layout:
    """一次排版规划：给定宽度/可用纵窗与候选字号，产出确定放得下的行盒。"""

    def __init__(self, font, bold_font=None, math_dims=None, fallbacks=None):
        """font: fitz.Font；math_dims: {n: Rect}；fallbacks: [(fitz.Font, name)]。"""
        self.font = font
        self.bold_font = bold_font
        self.math_dims = math_dims or {}
        # 字符 → 字体名缓存（测量与绘制共用，保证「测多少 = 画多少」）
        self.fallbacks = list(fallbacks or [])
        self._gcache = {}
        self._wcache = {}

    def set_math_dims(self, math_dims):
        """按页切换行内公式尺寸表（同一页内所有段落一致，保证列级测量可比）。"""
        self.math_dims = math_dims or {}
        self._wcache = {}

    # ------------------------------------------------------------ 字体选择
    def font_name(self, ch, bold=False):
        """该字符由哪套字体绘制（缺字自动回退到数学字体）。"""
        key = (ch, bool(bold))
        name = self._gcache.get(key)
        if name is not None:
            return name
        primary = self.bold_font if (bold and self.bold_font) else self.font
        name = "cjk_b" if (bold and self.bold_font) else "cjk"
        if not _has_glyph(primary, ch):
            for f, fn in self.fallbacks:
                if _has_glyph(f, ch):
                    name = fn
                    break
        self._gcache[key] = name
        return name

    def _font_of(self, ch, bold=False):
        nm = self.font_name(ch, bold)
        if nm == MATH_FONT_NAME:
            for f, fn in self.fallbacks:
                if fn == MATH_FONT_NAME:
                    return f
        if nm == "cjk_b" and self.bold_font:
            return self.bold_font
        return self.font

    def missing_chars(self, s, bold=False):
        return [c for c in s if not c.isspace() and not _has_glyph(
            self._font_of(c, bold), c)]

    # ------------------------------------------------------------ 测量
    def _text_w(self, s, fs, bold=False):
        key = (s, round(fs, 2), bool(bold))
        w = self._wcache.get(key)
        if w is None:
            tot = 0.0
            for ch in s:
                tot += self._font_of(ch, bold).text_length(ch, fontsize=fs)
            w = tot
            self._wcache[key] = w
        return w

    def _atom_w(self, t, fs, bold=False):
        """原子宽度（含上下标缩放）。返回 (宽, 绘制字号, 基线位移系数)。"""
        kind = t[0]
        if kind == "sub":
            sf = fs * SCRIPT_SUB_SCALE
            return self._text_w(t[1], sf, bold), sf, SCRIPT_SUB_DY * fs
        if kind == "sup":
            sf = fs * SCRIPT_SUP_SCALE
            return self._text_w(t[1], sf, bold), sf, -SCRIPT_SUP_DY * fs
        return self._text_w(t[1], fs, bold), fs, 0.0

    def _math_w(self, n, fs, line_h):
        """行内公式占位：按原图宽高比缩放到不超过 1.15 倍行高。"""
        r = self.math_dims.get(n)
        if r is None:
            return max(fs * 0.9, 2.0), line_h * 0.72
        ih = min(max(r.height, 3.0), line_h * 1.12)
        iw = ih * (r.width / r.height) if r.height else ih
        return iw, ih

    def wrap(self, toks, fs, line_h, width, bold=False):
        """断行：返回 [[原子,...], ...]（纯几何，与 draw 完全一致）。"""
        lines, cur, x = [], [], 0.0
        for t in toks:
            if t[0] == "sp":
                w = self._text_w(" ", fs, bold)
                if cur:
                    cur.append((t, w))
                    x += w
                continue
            if t[0] == "math":
                w, _h = self._math_w(t[1], fs, line_h)
                w += 1.5
            else:
                w = self._atom_w(t, fs, bold)[0]
            if cur and x + w > width + 0.5:
                # 行尾空格无意义，回退掉
                while cur and cur[-1][0][0] == "sp":
                    x -= cur[-1][1]
                    cur.pop()
                lines.append(cur)
                cur, x = [], 0.0
                if t[0] == "sp":
                    continue
            cur.append((t, w))
            x += w
        if cur:
            while cur and cur[-1][0][0] == "sp":
                cur.pop()
            if cur:
                lines.append(cur)
        return lines

    def measure(self, toks, fs, line_h, width, bold=False):
        lines = self.wrap(toks, fs, line_h, width, bold)
        return {"lines": len(lines), "height": len(lines) * line_h,
                "wrapped": lines}

    # ------------------------------------------------------------ 求解
    def fit(self, toks, width, height, fs_max, fs_min=None,
            pitch_ratio=None, bold=False):
        """在 width×height 内求最大可读字号（单一矩形版，保留给回放/调试）。"""
        fs_min = fs_min or MIN_FONT_SIZE
        pr = pitch_ratio or TARGET_PITCH_RATIO
        width = max(width, 1.0)
        height = max(height, 1.0)

        def tried(ratio):
            lo, hi = fs_min, max(fs_max, fs_min)
            best = None
            m = self.measure(toks, hi, hi * ratio, width, bold)
            if m["height"] <= height + 0.5:
                best = (hi, m)
            else:
                for _ in range(22):
                    if hi - lo < 0.05:
                        break
                    mid = (lo + hi) / 2.0
                    mm = self.measure(toks, mid, mid * ratio, width, bold)
                    if mm["height"] <= height + 0.5:
                        best = (mid, mm)
                        lo = mid
                    else:
                        hi = mid
            if best is None:
                m = self.measure(toks, fs_min, fs_min * ratio, width, bold)
                return fs_min, m, True
            return best[0], best[1], False

        ratio = pr if pr >= MIN_PITCH_FLOOR else MIN_PITCH_FLOOR
        fs, m, overflow = tried(ratio)
        if overflow:
            r = ratio
            while r > MIN_PITCH_FLOOR + 1e-6:
                r = max(MIN_PITCH_FLOOR, r - 0.04)
                fs2, m2, ov2 = tried(r)
                if not ov2:
                    fs, m, overflow, ratio = fs2, m2, False, r
                    break
            else:
                ratio = r
        line_h = fs * ratio
        fs = round(fs, 2)
        line_h = fs * ratio          # 用取整后的字号重算，保证「测量=绘制」
        m = self.measure(toks, fs, line_h, width, bold)
        return {"fs": fs, "line_h": line_h, "ratio": ratio,
                "lines": m["lines"], "height": m["height"],
                "overflow": overflow,
                "wrapped": m.get("wrapped") or [], "toks": toks}

    # ------------------------------------------------------ 纵窗装填（多段）
    def pack_windows(self, toks, fs, ratio, width, windows, bold=False):
        """把译文排进若干「可用纵窗」：窗内放满再跳到下一个窗（跨过图形/公式）。

        windows: [(y0, y1), ...] 升序、互不重叠的可用纵向区间（绝对页码坐标）。
        返回 dict(ok, fs, line_h, placed=[(y0, [line,...])], used, total, need)
        - placed 里每个 y0 是该窗内首行基线位置（= 窗顶 + fs）
        - ok=False 表示所有窗装完仍剩行（调用方缩字号或另想办法）
        """
        fs = round(fs, 2)
        lh = fs * ratio
        lines = self.wrap(toks, fs, lh, width, bold)
        placed, used = [], 0
        for (wy0, wy1) in windows:
            avail = wy1 - wy0
            cap = int(avail / lh + 1e-6) if lh > 0 else 0
            if cap <= 0:
                continue
            take = lines[used:used + cap]
            if not take:
                break
            placed.append((wy0, take))
            used += len(take)
        total = len(lines)
        return {"ok": used >= total, "fs": fs, "line_h": lh,
                "ratio": ratio, "placed": placed, "used": used, "total": total,
                "wrapped": lines, "toks": toks}

    def draw(self, page, plan, x0, y0, fontname, width,
             insert_text_fn=None, put_math_fn=None, max_bottom=None,
             bold=False):
        """按单矩形 plan 回填。返回实际末行 baseline（保留给回放/调试）。"""
        fs, line_h = plan["fs"], plan["line_h"]
        y = y0 + fs
        last = y
        clipped = 0
        for line in plan["wrapped"]:
            if max_bottom is not None and y > max_bottom:
                clipped += 1
                continue
            self._draw_line(page, line, x0, y, fs, fontname, insert_text_fn,
                            put_math_fn, line_h, bold)
            last = y
            y += line_h
        plan["clipped_lines"] = clipped
        return last

    def draw_windows(self, page, plan, x0, fontname, insert_text_fn=None,
                     put_math_fn=None, bold=False):
        """按 pack_windows 的结果回填（每窗独立起排）。返回末行 baseline。"""
        fs, line_h = plan["fs"], plan["line_h"]
        last = 0.0
        for (wy0, lines) in plan["placed"]:
            y = wy0 + fs
            for line in lines:
                self._draw_line(page, line, x0, y, fs, fontname,
                                insert_text_fn, put_math_fn, line_h, bold)
                last = y
                y += line_h
        return last

    def _draw_line(self, page, line, x0, y, fs, fontname, insert_text_fn,
                   put_math_fn, line_h, bold=False):
        x = x0
        for (t, _w) in line:
            if t[0] == "sp":
                x += self._atom_w(("w", " "), fs, bold)[0]
                continue
            if t[0] == "math":
                iw, ih = self._math_w(t[1], fs, line_h)
                if put_math_fn is not None:
                    top = y - ih + 0.20 * ih
                    put_math_fn(t[1], x, top, iw, ih)
                x += iw + 1.5
                continue
            s = t[1]
            w, sfs, dy = self._atom_w(t, fs, bold)
            if insert_text_fn is not None:
                self._draw_text(page, x, y + dy, s, sfs, fontname,
                                insert_text_fn, bold)
            x += w

    def _draw_text(self, page, x, y, s, fs, fontname, insert_text_fn, bold=False):
        """逐字符选字体后按字体分段绘制（缺字回退数学字体，宽度口径与测量一致）。"""
        chunks = []
        for ch in s:
            nm = self.font_name(ch, bold)
            if chunks and chunks[-1][0] == nm:
                chunks[-1] = (nm, chunks[-1][1] + ch)
            else:
                chunks.append((nm, ch))
        cx = x
        for nm, part in chunks:
            insert_text_fn(page, (cx, y), part, nm, fs)
            cx += sum(self._font_of(ch, bold).text_length(ch, fontsize=fs)
                      for ch in part)

    # ------------------------------------------------------------ 小工具
    def text_width(self, s, fs, bold=False):
        return self._text_w(s, fs, bold)

    def first_baseline(self, window_top, fs):
        return window_top + fs


def _has_glyph(font, ch):
    try:
        return bool(font.has_glyph(ord(ch)))
    except Exception:
        return False


def split_markers(text, math_rects):
    """译文 ⟨n⟩ → 原子序列。

    占位符齐全时按原位插入；缺失/多余时**只保留译文里真正出现的占位符**，绝不把
    段落所有公式矩形追加到段尾 —— 那会让所有公式图挤在同一个位置互相叠印。
    若译文完全没带占位符，则不贴任何公式：公式位置宁可留白，也不叠印。
    """
    toks = tokens(text)
    n_rects = len(math_rects)
    if not n_rects:
        return [t for t in toks if t[0] != "math"]
    return [t for t in toks
            if t[0] != "math" or 1 <= t[1] <= n_rects]
