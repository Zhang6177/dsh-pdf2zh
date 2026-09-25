#!/usr/bin/env python3
"""pdf2zh 图形/表格保护层：识别「不该翻译」的区域，让图内文字零改动。

背景（v0.11 的真实缺陷）：原版只有在 pymupdf-layout(GNN) 可用时才拿到
picture 区域。GNN 不可用时整条保护链退化为字体启发式 —— 于是**以矢量文字
绘制的图内标注**（如流程图里的 "Prompt Encoder"、"Refined Masks"、坐标轴
刻度、图例）会被当成正文提取、翻译、回填，正好叠在图上 → 排版主体事故。

本模块用「不依赖任何模型」的三类证据来划定保护区域：
  R1 位图区域     ：page.get_image_rects —— 图内像素文字本就无法翻译，且
                    其上的矢量标注同样属于图形内容
  R2 矢量图形区域 ：get_drawings 聚类成连通块，块内「短文本行」视为图内标注
  R3 表格区域     ：find_tables(lines/text) —— 表格整区不翻译

判定「文本属于图形」的三条闸门（宁松勿紧会误伤正文，故要求同时满足）：
  (a) 与保护区域重叠 ≥ 阈值（位图 0.92 近全含；矢量块 0.8）
  (b) 文本很短（≤ MAX_FIG_TEXT_CHARS）或所在块极短（≤ MAX_FIG_LINES 行）
  (c) 不以句末标点结束（正文句子特征）

正文段落在图形区域内的情形（跨栏浮动图、图下正文）由 (b)(c) 放行，
不会因为「版面交叠」而整段丢失翻译。
"""
import os
import re
import unicodedata

try:
    import pymupdf as fitz
except ImportError:
    import fitz

MAX_FIG_TEXT_CHARS = 64      # 位图区域内：单块文本长度上限（超过视为正文）
MAX_FIG_LINES = 3            # 位图区域内：行数上限
# 矢量图区域内放宽（图例/流程标注常是多行短语，但每行都很短）
VEC_MAX_TEXT_CHARS = 130
VEC_MAX_LINES = 8
VEC_MAX_AVG_LINE = 34        # 平均行长上限：正文行通常 ≥ 60 字符
IMG_COVER = float(os.environ.get("PDF2ZH_FIG_COVER", "0.92"))
VEC_COVER = 0.80
DRAW_MIN_SIDE = 8.0          # 过滤装饰性短线
DRAW_MERGE_GAP = 1.0         # 图元合并容差：真图内部图元相接/微交叠；松邻接会把无关图形粘成巨块
DRAW_MIN_REGION = 9000.0     # 矢量图块最小面积（pt²）：真图有实体尺寸
VEC_MIN_ITEMS = 12           # 真图由大量笔画构成；稀疏边框（Word 修订框）被排除
VEC_MIN_INK = 0.06           # 图块内墨迹占比下限
VEC_MAX_ITEMS = 6000         # 极端矢量页采样上限（防退化）
_SENT_END = re.compile(r"[.。！？!?；;:：]\s*$")


def _cover(inner, outer):
    try:
        it = inner & outer
        a = it.get_area() if not it.is_empty else 0.0
        return a / max(inner.get_area(), 1e-6)
    except Exception:
        return 0.0


def _is_light_fill(drawing, rect, min_area=4000.0):
    """大块浅色纯填充（页面底色、侧栏底纹）→ 不属于图形内容。"""
    if rect.get_area() < min_area:
        return False
    fill = drawing.get("fill")
    if not fill:
        return False
    if drawing.get("color") is not None:  # 有描边 → 可能是实体图元
        return False
    try:
        return all(float(c) > 0.90 for c in fill[:3])
    except Exception:
        return False


def image_rects(page, min_side=40.0):
    out = []
    for img in page.get_images(full=True):
        try:
            rects = page.get_image_rects(img[0])
        except Exception:
            continue
        for r in rects:
            try:
                r = fitz.Rect(r)
            except Exception:
                continue
            if r.is_empty or not r.is_valid:
                continue
            if r.width >= min_side and r.height >= min_side:
                out.append(r)
    return out


def vector_regions(page, text_blocks=None):
    """矢量图形连通块 → [Rect]。

    做法：取所有有面积的 drawing 矩形，按「间隙 ≤ DRAW_MERGE_GAP」并查集合并，
    保留面积 ≥ DRAW_MIN_REGION 且「内部含短文本行」的块 —— 后者是与正文区分的关键，
    纯装饰性色带/分隔线不会被误判。
    """
    try:
        drawings = page.get_drawings()
    except Exception:
        return []
    items = []
    for d in drawings:
        r = d.get("rect")
        if r is None:
            continue
        try:
            r = fitz.Rect(r)
        except Exception:
            continue
        if r.is_empty or not r.is_valid:
            continue
        if r.width < 1.0 and r.height < 1.0:
            continue
        # 页面级大色块（背景/整栏底纹）不算图形
        if r.get_area() > 0.75 * page.rect.get_area():
            continue
        # 大块浅色填充 = 底色/侧栏，不是图的内容；否则会把整页并成一个"图"
        if _is_light_fill(d, r):
            continue
        items.append(r)
    if len(items) < VEC_MIN_ITEMS:
        return []
    # 极端矢量页（上万笔画）降级采样：真图的主要图元面积大，先按面积取头部
    if len(items) > VEC_MAX_ITEMS:
        items.sort(key=lambda r: -r.get_area())
        items = items[:VEC_MAX_ITEMS]
    n = len(items)
    g = DRAW_MERGE_GAP
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i, j):
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[rj] = ri

    # 均匀网格分桶：只与邻近格子比较，避免 O(n²)（大图元会跨多个格子）
    cell = 48.0
    buckets = {}
    for i in range(n):
        r = items[i]
        if r.width > 400 or r.height > 400:
            buckets.setdefault(None, []).append(i)   # 超大图元放全局桶
            continue
        ix0, ix1 = int(r.x0 // cell), int(r.x1 // cell)
        iy0, iy1 = int(r.y0 // cell), int(r.y1 // cell)
        for gx in range(ix0, ix1 + 1):
            for gy in range(iy0, iy1 + 1):
                buckets.setdefault((gx, gy), []).append(i)
    seen = set()
    for key, ids in buckets.items():
        if key is None:
            cand = ids
        else:
            gx, gy = key
            cand = []
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    cand.extend(buckets.get((gx + dx, gy + dy), ()))
        for ii in range(len(cand)):
            a_i = cand[ii]
            a = items[a_i]
            for jj in range(ii + 1, len(cand)):
                b_i = cand[jj]
                if a_i == b_i:
                    continue
                pair = (a_i, b_i) if a_i < b_i else (b_i, a_i)
                if pair in seen:
                    continue
                seen.add(pair)
                b = items[b_i]
                if a.x1 + g < b.x0 or b.x1 + g < a.x0 or \
                        a.y1 + g < b.y0 or b.y1 + g < a.y0:
                    continue
                union(a_i, b_i)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(items[i])
    texts = []
    for b in (text_blocks or []):
        for ln in b.get("lines", []):
            t = "".join(s.get("text", "") for s in ln.get("spans", [])).strip()
            if t:
                texts.append((fitz.Rect(ln["bbox"]), t))
    out = []
    for rs in groups.values():
        # 真图由大量笔画/填充构成；Word 的段落边框、修订框只有零星矩形
        if len(rs) < VEC_MIN_ITEMS:
            continue
        big = rs[0]
        for r in rs[1:]:
            big = big | r
        if big.get_area() < DRAW_MIN_REGION:
            continue
        # 墨迹占比：真图有明显填充/连线密度，稀疏边框不算
        ink = 0.0
        for r in rs:
            ink += r.get_area()
        if ink / max(big.get_area(), 1.0) < VEC_MIN_INK:
            continue
        # 块内须有图内标注形态的短文本（且行宽明显窄于块）
        has_label = False
        for tr, t in texts:
            if _cover(tr, big) >= 0.7 and len(t) <= 48 and \
                    tr.width < 0.72 * big.width:
                has_label = True
                break
        if has_label:
            out.append(big)
    return out


def is_figure_text(rect, text, n_lines, regions):
    """单块文本是否属于图形内容（不该翻译）。

    regions: [(Rect, cover_threshold, kind)]，kind ∈ {"img","vec","table"}
    """
    if not regions:
        return False
    t = re.sub(r"\s+", " ", (text or "")).strip()
    if not t:
        return False
    for r, thresh, kind in regions:
        if _cover(rect, r) < thresh:
            continue
        if kind == "vec":
            # 矢量图区：只吃「图内标注」形态的文本 —— 短语块 + 行都很短 + 非句末。
            # 这样 Word 修订框/文本框里的正文（行长、以句号结尾）不会被误杀。
            if len(t) > VEC_MAX_TEXT_CHARS or n_lines > VEC_MAX_LINES:
                continue
            if _SENT_END.search(t) and len(t) > 24:
                continue
            if rect.width > max(240.0, 0.72 * r.width):
                continue  # 行宽接近整栏 → 正文
            if len(t) / max(n_lines, 1) > VEC_MAX_AVG_LINE:
                continue
            return True
        # 位图 / 表格区域：短块 + 非句末
        if len(t) > MAX_FIG_TEXT_CHARS or n_lines > MAX_FIG_LINES:
            continue
        if _SENT_END.search(t) and len(t) > 24:
            continue
        return True
    return False


def protected_regions(page, text_blocks=None, table_rects=None):
    """页面保护区域：[(Rect, cover_threshold, kind)]。"""
    tables = []
    for r in (table_rects or []):
        try:
            tables.append(fitz.Rect(r))
        except Exception:
            continue
    regs = []
    for r in image_rects(page):
        regs.append((r, IMG_COVER, "img"))
    for r in vector_regions(page, text_blocks):
        # 书线表格的框线也是矢量图形：与已识别表格重合的块交给表逻辑处理
        if any(_cover(r, t) >= 0.6 for t in tables):
            continue
        regs.append((r, VEC_COVER, "vec"))
    for t in tables:
        regs.append((t, 0.55, "table"))
    return regs


_TABLE_CACHE = {}


def rect_hits_regions(rect, regions, min_area=0.5):
    """矩形是否与任一保护区域相交（用于「绝不擦除保护区内图元」的判定）。"""
    if not regions:
        return False
    try:
        r = fitz.Rect(rect)
    except Exception:
        return False
    if r.is_empty:
        return False
    for reg in regions:
        rr = reg[0] if isinstance(reg, (tuple, list)) else reg
        try:
            rr = fitz.Rect(rr)
        except Exception:
            continue
        it = r & rr
        if not it.is_empty and it.get_area() >= min_area:
            return True
    return False


def text_in_regions(rect, text, n_lines, regions):
    """兼容旧接口：文本块是否被判为图内文字。kind 缺省时按位图口径处理。"""
    norm = []
    for reg in (regions or []):
        if isinstance(reg, (tuple, list)) and len(reg) >= 3:
            norm.append((reg[0], reg[1], reg[2]))
        elif isinstance(reg, (tuple, list)) and len(reg) == 2:
            norm.append((reg[0], reg[1], "img"))
        else:
            norm.append((reg, IMG_COVER, "img"))
    return is_figure_text(rect, text, n_lines, norm)


def neutralize_drawings(page, regions, min_cover=0.95):
    """删除「完全落在保护区域内」的矢量图形，避免其与回填译文叠印。

    原因：MuPDF 的 redaction 只作用于文本与图像，图形原样保留；若图内标注是以
    矢量正文绘制的，译文回填到该位置后笔画仍在 → 叠印。仅处理 100% 落在图内的
    图形，页面边框/正文装饰线不会被误删。
    """
    if not regions:
        return 0
    rects = []
    for reg in regions:
        rr = reg[0] if isinstance(reg, (tuple, list)) else reg
        try:
            rr = fitz.Rect(rr)
        except Exception:
            continue
        if not rr.is_empty:
            rects.append(rr)
    if not rects:
        return 0
    n = 0
    try:
        drawings = page.get_drawings()
    except Exception:
        return 0
    for d in drawings:
        r = d.get("rect")
        if r is None:
            continue
        try:
            r = fitz.Rect(r)
        except Exception:
            continue
        if r.is_empty:
            continue
        if not any(_cover(r, reg) >= min_cover for reg in rects):
            continue
        try:
            if hasattr(page, "delete_drawings"):
                page.delete_drawings(r)
                n += 1
        except Exception:
            continue
    return n


_CELL_FILL_MIN = 0.55    # 有内容的单元格占比下限
_CELL_SHORT_MAX = 42     # 多数单元格内容长度上限（表格单元格是短语/数字，不是整句）


def _looks_like_table(t, rect, page_area, strat):
    """表格可信度校验。

    text 策略极易把「带文本框/批注框的单栏正文」判成一整页大表（实测 Word 稿件
    每页都会命中），故必须校验真实单元格结构：多行多列 + 单元格有内容 + 内容为
    短条目。宁可漏检（正文多翻一点）也不能把整页正文当成表格而完全不翻。
    """
    try:
        rows, cols = t.row_count, t.col_count
    except Exception:
        return False
    if rows < 2 or cols < 2:
        return False
    a = rect.get_area()
    if strat == "lines":
        return 0.004 * page_area <= a <= 0.55 * page_area
    if rows < 3 or cols < 3:
        return False
    if not (0.01 * page_area <= a <= 0.5 * page_area):
        return False
    try:
        data = t.extract()
    except Exception:
        return False
    cells = [c for row in (data or []) for c in row]
    if not cells:
        return False
    filled = [c for c in cells if c and str(c).strip()]
    if len(filled) / max(len(cells), 1) < _CELL_FILL_MIN:
        return False
    # 表格特征：绝大多数单元格是短条目（数字/短语），而不是整句正文
    short = sum(1 for c in filled if len(re.sub(r"\s+", " ", str(c)).strip()) <= _CELL_SHORT_MAX)
    return short / len(filled) >= 0.7


def is_numeric_table_like(text, lines):
    """数值表格特征：数字/占比占多数、条目短、多行含数字。

    find_tables 对无双线的三线表常漏检，漏检的表格文字会被当正文翻译并压在
    表格上（实测 HZSCM 第 14/15 页）。此判据用于兜底：真表格单元格几乎不含
    句末标点，且每行都是短条目。
    """
    t = [c for c in (text or "") if not c.isspace()]
    if len(t) < 6 or len(lines) < 1:
        return False
    dig = sum(1 for c in t if c.isdigit() or c in ".,%±-–—~()<>+")
    if dig / len(t) < 0.30:
        return False
    words = re.findall(r"\S+", text or "")
    if not words or sum(len(w) for w in words) / len(words) > 7.0:
        return False
    multi = sum(1 for l in lines
                if len(l.text.split()) >= 2
                and sum(1 for c in l.text if c.isdigit()) >= 1)
    return multi >= max(1, int(0.6 * len(lines)))


def numeric_table_blocks(page, text_blocks, min_area=2500.0):
    """相邻数值短块聚成表格区域（find_tables 漏检时的兜底）。

    仅在「≥3 个数值块 + 横向可切出 ≥2 栏」时才认，避免把公式编号、单列数字
    碎片误判成表格而丢掉正文翻译。
    """
    rows = []
    for b in (text_blocks or []):
        try:
            r = fitz.Rect(b["bbox"])
        except Exception:
            continue
        lines = b.get("lines", [])
        txt = " ".join("".join(s.get("text", "") for s in ln.get("spans", []))
                       for ln in lines)
        if not txt.strip() or r.width > 0.45 * page.rect.width:
            continue
        if not is_numeric_table_like(txt, lines):
            continue
        rows.append(r)
    if len(rows) < 3:
        return []
    iv = sorted((r.x0, r.x1) for r in rows)
    merged = [list(iv[0])]
    for x0, x1 in iv[1:]:
        if x0 <= merged[-1][1] + 2.0:
            merged[-1][1] = max(merged[-1][1], x1)
        else:
            merged.append([x0, x1])
    if len(merged) < 2:
        return []
    box = fitz.Rect(min(r.x0 for r in rows), min(r.y0 for r in rows),
                    max(r.x1 for r in rows), max(r.y1 for r in rows))
    return [box] if box.get_area() >= min_area else []


def table_rects(page, use_text_strategy=True, use_cache=True):
    """表格区域：lines 策略（书线表）优先，text 策略补充（无线表常误报，故面积设限）。

    find_tables 在参考文献密集页上可达 1.5s/页，故按 (文档, 页码) 记忆化。
    """
    key = None
    if use_cache:
        try:
            key = (getattr(page, "parent", None) is not None and page.parent.name,
                   page.number, use_text_strategy)
        except Exception:
            key = None
        if key is not None and key in _TABLE_CACHE:
            return [fitz.Rect(r) for r in _TABLE_CACHE[key]]
    out = []
    page_area = max(page.rect.get_area(), 1.0)
    for strat in (("lines", "text") if use_text_strategy else ("lines",)):
        try:
            tf = page.find_tables(strategy=strat)
        except Exception:
            continue
        for t in getattr(tf, "tables", []):
            try:
                r = fitz.Rect(t.bbox) & page.rect
            except Exception:
                continue
            if r.is_empty:
                continue
            if _looks_like_table(t, r, page_area, strat):
                out.append(r)
    # 去重（互相覆盖 > 0.9 视为同一张表）
    ded = []
    for r in out:
        if not any(_cover(r, q) > 0.9 for q in ded):
            ded.append(r)
    if key is not None:
        _TABLE_CACHE[key] = list(ded)
    return ded
