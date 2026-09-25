# dsh-pdf2zh

学术论文 PDF 英转中的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件。

**结构化快速管线**：填 PDF 路径 → 一键翻译 → 看板实时看进度 → **产出排版保真的中文 PDF（`<原名>.zh.pdf`）+ 中文 Markdown**。提取、分段、渲染全部由确定性脚本完成，模型只负责「正文段落翻译」——**显式关闭思考模式、按批并发请求**。实测一篇 35 页 / 10 万字符的论文全程约 **2–3 分钟**（本地 vLLM，Qwen3.8-27B-FP8，8 路并发）。

**v0.12 版式重构（重新梳理翻译逻辑）**：把「把中文塞回原英文行位」改成「**按列几何重新排版 + 图/表零改动**」——

- **图、表内容一律不翻译、不改动**：位图区域、矢量图形区域（流程图标注/图例/坐标轴文字）、
  表格整区都划为**保护区**。保护区内的文字不提取、不擦除、不回填，图形笔画也不删；
  回填另有一道几何硬下界，即使区域识别有漏检，译文也不会画进图/表里。
- **不再压字**：行距与字号强绑定（`pitch ≥ 1.0em`，正文取 1.38em），汉字字身不再互相叠印 ——
  旧版写死 1.28 倍英文行高、且不改原行距，是「文字重叠」的主因。
- **不再越界**：同页段落共用一个字号比例，在「本段列宽 × 本段可用纵窗（已被图/表/公式切好）」内求解；
  实在放不下时**保留英文原文**（一字不动 + 落 warning），也绝不叠印。
- **不再把图内文字搬进正文**：源 PDF 里以矢量文字绘制的图内标注（如
  `Prompt Encoder`、`Refined Masks`）过去被当正文翻译后回填到图上；现在整块跳过。
- **跨栏段落先切开**：源文本层把左右栏塞进同一 block 时，先按栏切分再合并 ——
  否则一段译文会横跨两栏压住另一栏正文（实测主要叠印来源之一）。

**v0.13 三项硬承诺（行内公式文本化 · 段落可拆 · 绝不放弃原文）**：

- **行内公式不再贴图**：行内符号一律提取为 Unicode 文本、由 LLM 修复后**按真实上下标排回正文**。
  `t k ∈Rc` → `t_k ∈ R^c`、`RK×c` → `R^{K×c}`、`[ t 1, . . . , t K]⊤` → `[t_1, …, t_K]ᵀ`；
  渲染器把 `_{}`/`^{}` 画成真正的下标/上标，CJK 字体缺的 `⟨⟩⋅⊤⁄ℝ` 回退到 DejaVu Sans。
  Symbol/CMSymbol 私有区字形按 Adobe Symbol 编码表解码成真 Unicode，不再因「怕豆腐块」退回贴图。
  **实测 6 篇语料 `inline_math_crop = 0`、`新增图片 = 0`**（旧版输出里有 5 张公式贴图）。
- **独立公式原位不动**：整行纯公式识别为独立公式段（含公式编号），不提取、不翻译、不擦除、
  不回填，并被登记为保护区。旧版会把紧贴上文的公式（如 SPECIAL 的公式 (4)、manuscript-3 的 (1)(2)）
  误判成「行内」并吞进正文翻译掉 —— 现在按「是否与末行同处一线」判定，误判基本消除。
- **段落可拆，绝不整段放弃**：页面被图/表/公式/未译文本切成若干「可用纵窗」，同栏段落按阅读序
  依次灌入，窗内放满即跳到下一个窗 —— 段落被公式切开时，自然拆成「公式上方 + 公式下方」两段
  分别回填。实测 SPECIAL 从「整段放弃 6 段、残留英文 112 行」变为「放弃 1 段（仅因该段无译文）、
  残留英文 141 行且全部是公式与参考文献」。
- **原文必须保留**：放不下的段落不再擦成留白，而是**一字不动地留在页面上**，并作为障碍带
  挡住后续中文；擦除一律带白色填充（MuPDF 的文本删除对部分 Word 导出页会静默失效，
  白底填充保证「绝不叠印」这条视觉底线，失效时渲染警告会写明）。
- **正文默认再缩 0.5–1 号**：`PDF2ZH_FONT_SHRINK` 默认由 1.0 提到 **1.5pt**（设置面板预设
  0.5/1/1.5/2/2.5 可调），配合列内统一字号比例，显著减少「段落空间紧张降到 4.5 号」的情况。

**v0.12.1 公式与符号策略（分层，不再一律裁图）**：

- **行内小符号 → 还原为文本交给 LLM**：单个变量、上下标、`∈ R^c` 这类零星符号过去被逐个裁成
  小图片，必然错位，还会在原位留下孤立残字（实测 146 个行内矩形 → 47 个）。现在它们回到
  文本流里（`嵌入向量 t_k ∈ R^c`），由模型直接处理符号。
- **相邻数学 run 合并**：同一表达式被切成多段时会合成一个矩形，译文里不再出现
  `text embedding t ⟨1⟩ ⟨2⟩ , forming T ⟨3⟩` 这种碎片占位符；夹在公式间的纯标点也并回公式块。
- **独立公式登记为保护区**：整段公式既不被擦除、也不被正文叠印 —— 它在页面上原样不动
  （实测输出中公式与编号 `(6)` 保持矢量原貌），正文改为绕开它排布。
- **翻译提示词新增「公式与符号排版铁律」**：行内符号原样嵌入中文、括号/上下标/分数必须成对完整、
  禁止 Markdown/LaTeX 环境、`⟨n⟩` 占位符数量与位置必须与原文一致、不得不认识就删符号。
- 仍走裁剪贴图的只有「大公式」与「含私有区字形（SymbolMT/CMSymbol 的 ≦∑= ）的片段」。
  `PDF2ZH_INLINE_MATH=crop` 可回退到旧的「一律裁图」口径做 A/B 对比。

> GNN 版面模型（pymupdf-layout）在本机通常不可用，旧版因此整条图形保护链退化为字体启发式。
> v0.12 的保护区识别**不依赖任何模型**（位图矩形 + 矢量图形连通块指纹 + 表格双策略 +
> 数值块兜底），无 GNN 也能工作，有 GNN 时叠加使用。

## 工作原理（pipeline/）

1. **`extract.py` 结构化提取**（PyMuPDF）：双栏阅读序、**按栏切分跨栏块**、drop-cap/续段合并、
   章节标题识别、页眉页脚与站点封面剔除、参考文献区检测（不翻译）；表格区域（find_tables
   双策略 + 数值块兜底）与**图内文字块**（`protect.py` 判定）标记为保护区并**完全不提取**。
   **公式分两级**（v0.13）：
   * **行内公式 → Unicode 文本**：`t_k ∈ R^c`、`x^{(L)}`、`∑_{i=1}^{n}` 这类行内符号一律还原成
     文本交给 LLM 修复后随正文重排，**不再裁剪贴图**（贴图会错位、会在原位留下孤立残字）。
     Symbol/CMSymbol 映射到私有区的字形按 Adobe Symbol 编码表解码成真 Unicode 符号；
     实测语料 `inline_math_crop = 0`，即没有一条行内公式被贴成图片。
   * **独立公式 → 原位矢量保留**：整行且足够宽的公式（含公式编号行）识别为独立公式段，
     不提取、不翻译、不擦除、不回填，原矢量字形留在原位置，并被登记为**保护区**，
     正文排版会绕开它。
   排版引擎泄漏的 LaTeX 碎片在 token 级剔除，不污染译文。
2. **`translate.py` 并发翻译**：可翻译段落按 ~3600 字符分批（标题单独成批），线程池并发
   （默认 8 路，可在设置中调节）打 OpenAI 兼容 `/chat/completions`（也支持 Anthropic messages
   协议）。请求带 `chat_template_kwargs:{enable_thinking:false}` 关闭思考；system 提示词内嵌术语表；
   `序号. 译文` 编号协议 + 缺号校验 + 3 次退避重试；绝大多数段落失败（如鉴权错误）时快速终止并报错。
   提示词内含**公式排版铁律 + 行内公式修复**两段硬约束：禁一切 LaTeX 标记（`$`、`\in`、`\mathbb{R}`…），
   要求把提取时丢失的上下标层级补回来（`t k ∈Rc` → `t_k ∈ R^c`、`RK×c` → `R^{K×c}`），
   并禁止添加原文没有的 `⟨n⟩` 占位符。
3. **`fit.py` 版式自适配引擎**：给定「宽 × 可用纵窗 × 译文 token 流」，求解最大可读字号。
   测量即排版（`wrap()` 的行断点就是 `draw()` 的绘制顺序），行距恒 `= fs × ratio` 且
   `ratio ≥ 1.02`，从几何上排除压字。v0.13 起公式以**文本**进入排版：
   `_{}` / `^{}` 按真实字号与基线上下移绘制（`R^{K×c}` 排成 R 带右上标），
   CJK 字体缺的数学符号（`⟨⟩⋅⊤⁄ℝ⌈⌉`）按字符回退到 DejaVu Sans，测量与绘制共用同一套
   字体选择表，因此「测多少 = 画多少」仍然成立。
4. **`render.py` 列内纵窗流式排版**：在原 PDF 副本上「擦除 → 回填」，图/表位图与矢量图形原样保留。
   页面被**图 / 表 / 独立公式 / 未译文本**切成若干「可用纵窗」，同栏段落按阅读序依次灌入，
   窗内放满即跳到下一个窗（跨过图形）—— 这就是「段落被公式切开时，拆成公式上方 + 下方两段
   分别回填」的实现。同栏段落**首尾相接**（`PDF2ZH_FLOW=compact`，默认）：中文比英文短时不留空洞，
   否则整栏会被锚点撑出上百 pt 的缝隙，而这些缝隙又用不上，反过来把全页字号比例压到 0.55
   （实测 HZSCM p4 因此掉到 4.7pt；改成紧凑流式后同页比例回到 0.92，字号恢复 7~8pt）。
   全页共享一个字号比例（二分求解），逐段确认装得下；实在装不下的段落**原样保留英文**
   （不擦、不回填，且作为障碍带挡住后续中文），绝不擦成留白、绝不叠印。
   擦除一律带白色填充：MuPDF 的文本删除对某些 Word 导出页会静默失效，白底填充保证
   「原文不会与中文叠印」这条视觉底线，此时渲染警告里会明确写出「文本层擦除失效」
   （`verify.py` 会把这类「文本层幽灵压字」单独计数，不混入真实压字）。
5. **`run_pipeline.py` 编排**：以上串成一条命令，全程向宿主进度文件（`<dataDir>/jobs/<id>.json`）
   原子写入 `stage/done/total/phase` 与最终 `result`（产出清单、统计、失败段数、渲染警告）；
   同时产出 `<原名>.zh.md`（伴生 Markdown）、`<原名>.zh.translations.json`（译文转储，含源文与
   几何信息，供 `replay.py --translations` 离线回放排版层做回归）与可选 `<原名>.en-zh.md`。

### 可调环境变量（渲染层）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PDF2ZH_FONT_SHRINK` | `1.5` | 正文基准字号收缩量（pt，0–3）。设置面板「正文字号收缩」覆盖 |
| `PDF2ZH_FLOW` | `compact` | `compact`=同栏首尾相接；`anchor`=每段钉回原文 y0（旧口径，会留空洞并压低全页字号） |
| `PDF2ZH_BODY_MARGIN` | `10` | 距页底硬留白（pt）。页脚本身已是障碍带，此值不宜过大 |
| `PDF2ZH_PITCH` / `PDF2ZH_MIN_PITCH` | `1.38` / `1.00` | 行距与字号的比值；低于 1.0em 必压字，故有硬下限 |
| `PDF2ZH_PARA_GAP` / `PDF2ZH_WINDOW_MIN` | `2.0` / `3.0` | 段间距、可用纵窗的最小高度（pt） |
| `PDF2ZH_MIN_FONT` | `4.5` | 允许的最小字号；低于 4.5pt 的正文已不可读 |
| `PDF2ZH_INLINE_MATH` | `text` | `crop` 可回退到「行内公式一律裁图」的旧行为做 A/B |
| `PDF2ZH_LAYOUT` / `PDF2ZH_TABLES` | `gnn` / `on` | 版面模型与表格识别开关（GNN 不可用时自动降级） |

### 回归与体检工具（pipeline/）

| 脚本 | 用途 |
| --- | --- |
| `verify.py <源> <译文>` | 五项硬指标：**压字**（基线间距 < 字号，并区分「源文档固有」与「本次新增」）、**图保真**（位图未丢失）、**新增图片**（本插件贴的图，正常应为 0）、**图内中文**、**越界**（文本落出页面，同样区分新增） |
| `replay.py <源>` | 不依赖模型端点的离线回放：合成译文（按英文字符数 ×0.6）走完整渲染链，用于版式回归 |
| `rerender.py <源> <译文转储.json> <出.pdf>` | 拿已存档的**真实译文**用当前渲染层重新产出（不调模型），改排版逻辑时的秒级 A/B |
| `diag4.py <译文>` | 基线真值压字检测（单文件，逐行定位） |
| `trace_fit.py <源> <页范围>` | 打印每段「落点 / 纵窗 / 字号 / 行数」的排版决策，定位残留英文来源 |
| `PDF2ZH_DEBUG_LAYOUT=1` | 环境变量：渲染时打印每页统一字号比例、每段落点/纵窗/擦除矩形数、保留原文的段落及原因 |
| `PDF2ZH_DEBUG_SIM=1` | 环境变量：打印二分求解过程中「哪个段落、在什么字号下装不下」 |

## 功能

- **技能自动安装（不落 home）**：技能实体文件保存在 `<dataDir>/skills/pdf2zh/`，启动时同步内容有差异才覆盖；`~/.dsh/skills/pdf2zh` 只是一个指向它的符号链接（供 dsh 聊天技能发现用，home 内不存实际数据）。`glossary.md` 仅在缺失时播种——你积累的术语表不会被升级覆盖（管线翻译时也读取同一份术语表）。
- **提取预览**：面板里填服务器上的 PDF 路径（或**拖拽/选择本地 PDF 上传**到 `<dataDir>/uploads/`），点「提取预览」查看页数/字符数与前 1200 字符抽查。
- **一键翻译**：点「开始翻译」，插件解析选定的模型 API（含可达性探测），以 `detached` 子进程启动翻译管线（独立进程组，**dsh-web 重启不影响在途任务**，看板自动续跟），任务登记进看板。
- **翻译看板**：顶部实时汇总**进行中 / 已完成 / 已失败**数量与总体进度条；每张卡片显示真实进度（阶段 + 「翻译 x/y 段」）、所用 API、完成后的页数/段数/公式/图片统计；已完成卡片直接给出**可点击的产出下载链接**（`GET /file`，白名单限定任务产出）；失败卡片带「重试」按钮与可操作提示（不可达 / 鉴权失败分别提示）。账本持久化在 `<dataDir>/jobs.json`；超时（默认 240 分钟）终止翻译进程并记失败；删除卡片会一并终止其运行中的进程。
- **设置弹窗**（右上角「⚙ 设置」）：
  - **模型 API** 页：顶部「自动选择」卡片（优先本地部署 API、探活跳过不可达端点），其下按 provider 卡片列出 dsh 注册表中的全部 API（点选即存默认）；「＋ 手动添加 API」表单（显示名/标识/协议/URL/Key，支持「获取模型」探测与手动填写，写入 dsh `llm-pi-ai` 设置与凭据库、热生效，自添加项可两步确认删除）。
  - **输出与性能** 页：保存路径（常用目录快捷回填、留空 = 源 PDF 同目录）、**翻译并发**（1–16，默认 8；对本地 vLLM 即篇内并发请求数）、**正文字号收缩**（0–3pt，默认 1.5pt，用于缓解中文比英文占位更多导致的版面紧张）、任务超时（30 分–12 小时 + 自定义）。
- **端点解析**：开始翻译按「本次指定 > 已保存默认 > 自动（本地优先 + 探活）」选定 provider；从 dsh 设置取 `baseURL`/`apiKeyEnv`，密钥经宿主 env → `~/.dsh/.credentials.yaml` 解析后仅通过子进程环境变量传入（不进命令行参数、不落日志，错误信息里的 `sk-` 自动打码）。端点不可达或未显式配置 `baseURL` 时快速失败（不启动管线），看板给出可操作提示。
- **失败重试**：按原参数（路径/页码/对照）重新发起并替换旧卡片。
- **选项**：页码范围（如 `1-8`、`1,3,5-9`，**默认全文**）、中英对照（额外产出 `<同名>.en-zh.md`）。「含附录」选项保留（管线始终翻到参考文献前）。
- **术语表在线编辑**：面板内编辑保存（写回 `glossary.md`），每行 `英文: 中文`。
- **界面**：四步引导 + 看板每 5 秒自动刷新；统计三张色条卡片、进行中任务流光进度条与呼吸状态点；底部状态条绿/红圆点显示 Python/PyMuPDF 健康状态与当前默认 API；全中文界面、北京时间。
- **状态透明**：面板底部显示插件版本与技能同步路径；`GET /health` 可供外部检查。

## 安装

前提：Node ≥ 22.19、dsh ≥ 0.1.2、Python 3 + PyMuPDF（`import fitz` 可用；`requests` 用于翻译请求）、系统中文字体（默认找 `~/.local/share/fonts/NotoSansCJKsc-Regular.otf`，可用 `PDF2ZH_CJK_FONT` 覆盖）。

```sh
git clone https://github.com/Zhang6177/dsh-pdf2zh.git
cd dsh-pdf2zh
pnpm install && pnpm build           # 仓库已附构建好的 lib/client.js
# ~/.dsh/profiles/web/package.json：
#   "dependencies": { "dsh-pdf2zh": "link:/path/to/dsh-pdf2zh" }
#   "dsh": { "profile": { "bundles": [ ..., "dsh-pdf2zh" ] } }
pnpm install --prefix ~/.dsh/profiles/web
systemctl --user restart dsh-web
```

插件行由包内 `cordis.patch.yml` 自动插入（`id: pdf2zh`）。启用/停用按行 id 匹配。

## 配置

插件行 `config`（`cordis.patch.yml`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭后 API 返回 503 |
| `apiPath` | `/api/pdf2zh` | 同源 API 前缀 |
| `python` | `python3` | 翻译管线使用的解释器（需有 PyMuPDF + requests） |
| `dataDir` | `<插件目录>/data` | **插件数据根目录**：settings/jobs 账本、进度与日志、上传、技能实体、术语表全在这里；默认位于 `/data02/.../dsh/plugin/dsh-pdf2zh/data`，**不再写 `~/.dsh`**。也可用环境变量 `PDF2ZH_DATA_DIR` 覆盖 |
| `migrateFromHome` | `true` | 首次启动自动把旧版存放在 `~/.dsh` 的数据复制进 `dataDir` 并重写账本路径（旧目录保留，可手动删除） |
| `skillSync` | `true` | 启动时同步技能文件 |
| `skillDir` | `<dataDir>/skills/pdf2zh` | 技能实体目录（可覆盖；`~/.dsh/skills/pdf2zh` 为指向它的符号链接） |
| `uploadDir` | `<dataDir>/uploads` | 拖拽上传的存放目录（可覆盖） |
| `outputDir` | `""` | 翻译结果保存目录初始值；运行期以面板「设置」（`settings.json`）为准 |
| `timeoutMinutes` | `240` | 单任务超时（分钟，10–1440）初始值；`settings.json` 优先 |

面板运行期设置（`<dataDir>/settings.json`）：`outputDir`、`timeoutMinutes`、`model{provider,model}`、`concurrency`（1–16，默认 8）、`fontShrink`（0–3pt，默认 1）。

管线依赖见 `pipeline/requirements.txt`（python ≥ 3.10 的 venv：pymupdf 1.28.2 + pymupdf-layout + requests）。插件启动时自动探测带 `pymupdf-layout` 的解释器（候选：`PDF2ZH_PYTHON` 环境变量 → config.python → `~/.venvs/pdf2zh/bin/python` → 常见路径 → python3），找到即用 GNN 版面分析，否则降级启发式；`/health` 的 `runtime` 字段与面板底部状态点显示实际选用结果。

## API（仅本机回环、同源，无鉴权——插件 API 惯例）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/pdf2zh/health` | GET | 插件/Python/PyMuPDF/技能/并发/管线目录状态 |
| `/api/pdf2zh/skill` | GET | 已安装技能文件清单 |
| `/api/pdf2zh/glossary` | GET/POST | 术语表读取 / 保存 `{text}` |
| `/api/pdf2zh/extract` | POST | `{path, pages?}` → 运行 extract.py 预览 |
| `/api/pdf2zh/translate` | POST | `{path, pages?, bilingual?, appendix?, sourceChars?, model?}` → 探活并启动翻译管线子进程，返回 `{jobId, provider, model, modelNote, outputDir, pipeline:true}` |
| `/api/pdf2zh/upload` | POST | 原始 PDF 二进制（文件名在 `x-pdf2zh-filename` 头） |
| `/api/pdf2zh/settings` | GET/POST | UI 设置读取 / 保存（`outputDir?/timeoutMinutes?/model?/concurrency?`） |
| `/api/pdf2zh/models` | GET | dsh 模型目录（含 `userAdded/base/hasKey`、默认、自动解析、`canManage`） |
| `/api/pdf2zh/models/discover` | POST | `{baseURL, api?, apiKey?}` → 探测端点模型列表 |
| `/api/pdf2zh/models/add` | POST | 注册新 provider（写 dsh 设置 + 凭据库，热生效，失败回滚） |
| `/api/pdf2zh/models/remove` | POST | 删除用户层 provider（派生密钥一并清理） |
| `/api/pdf2zh/jobs` | GET | 看板数据：全部任务（`progress`/`phase`/`elapsedMs`/`stats`）+ `summary` |
| `/api/pdf2zh/file` | GET | `?job=<id>&path=<产出>` → 下载/预览任务产出（仅限该任务登记的文件） |
| `/api/pdf2zh/jobs/delete` | POST | `{id}` → 移除任务（进行中会终止其管线进程） |
| `/api/pdf2zh/jobs/retry` | POST | `{id}` → 按原参数重试并替换旧卡片 |
| `/api/pdf2zh/jobs/clear` | POST | `{}` → 清空已完成/已失败（保留进行中） |

`path` 必须是服务器上的绝对路径且以 `.pdf` 结尾（≤100 MB）。

## 翻译纪律（由管线 system 提示词保证）

公式不翻译（整块裁剪原图 / 行内 `⟨n⟩` 占位回插原图）；参考文献区不翻译；模型名/数据集名/指标/引用编号/URL/代码符号/数字单位原样保留；学术书面中文；术语表强制一致。

## 目录结构

```
├── cordis.patch.yml          # 插件行插入（id: pdf2zh）
├── package.json              # 双端包：. → host，./client → 浏览器半
├── src/index.js              # host 入口（纯 ESM JS，无构建）：路由 + 管线调度 + 看板账本
├── src/client/index.ts       # 浏览器半源码（React.createElement 风格）
├── lib/client.js             # 客户端构建产物（tsdown，react 外部化）
├── data/                     # 插件数据根目录（gitignore：设置/账本/上传/技能实体/术语表）
├── pipeline/                 # 结构化翻译管线（vendored python）
│   ├── requirements.txt      #   管线依赖（venv：pymupdf-layout GNN 版面分析）
│   ├── extract.py            #   版式感知提取（GNN 表格/公式/页眉区域 + span 级数学切分）
│   ├── translate.py          #   并发段落翻译（关思考；OpenAI/Anthropic 双协议）
│   ├── render.py             #   排版保真中文 PDF 渲染
│   └── run_pipeline.py       #   编排 + 进度文件 + Markdown 伴生产物
├── skill/                    # pdf2zh 交互技能（供聊天会话使用；含术语表种子）
└── tsdown.client.config.mjs  # 客户端打包配置
```

## 性能参考

| 论文 | 旧架构（会话整篇+思考max） | v0.8 管线（关思考、8 路并发） |
|---|---|---|
| manuscript（35 页 / 102k 字符 / 152 段 / 11 表 / 196 公式块 / 18 图） | ≈66 分钟 | GNN 提取 12s + 翻译 80s + 渲染 41s ≈ **2.2 分钟** |
| GAST（14 页 IEEE 双栏 / 126 段 / 9 表 / 342 公式块） | — | ≈ **3.0 分钟** |

吞吐随端点并发扩展（实测同一 vLLM：单流 42 tok/s → 5 并发聚合 147 tok/s），并发数与端点 `max-num-seqs` 相关，可在「输出与性能」中调节。

## License

[MIT](./LICENSE)
