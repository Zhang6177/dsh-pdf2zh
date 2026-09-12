# dsh-pdf2zh

学术论文 PDF 英转中的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件。

**v0.8 起为结构化快速管线**：填 PDF 路径 → 一键翻译 → 看板实时看进度 → **产出排版保真的中文 PDF（`<原名>.zh.pdf`，图/公式/表格保持原文与原位）+ 中文 Markdown**。提取、分段、渲染全部由确定性脚本完成，模型只负责「段落级文本翻译」——并且**显式关闭思考模式、按批并发请求**，实测一篇 35 页 / 10 万字符的论文全程约 **2.5–3 分钟**（本地 vLLM，Qwen3.8-27B-FP8，8 路并发）。

不再经由 DSH 会话/Agent 翻译（旧架构整篇串行 + 思考模式 + 逐轮重放上下文，实测 60+ 分钟）。

## 工作原理（pipeline/）

1. **`extract.py` 结构化提取**（PyMuPDF）：双栏阅读序、drop-cap/续段合并、章节标题识别、页眉页脚与站点封面剔除、参考文献区检测（不翻译）、公式块检测——独立公式整块裁剪为 3× 图片、行内公式以 `⟨n⟩` 占位；位图图片带原位 bbox 提取。
2. **`translate.py` 并发翻译**：可翻译段落按 ~3600 字符分批（标题单独成批），线程池并发（默认 8 路，可在设置中调节）打 OpenAI 兼容 `/chat/completions`（也支持 Anthropic messages 协议）。请求带 `chat_template_kwargs:{enable_thinking:false}` 关闭思考；system 提示词内嵌术语表；`序号. 译文` 编号协议 + 缺号校验 + 3 次退避重试；绝大多数段落失败（如鉴权错误）时快速终止并报错。
3. **`render.py` 排版保真渲染**：每页与原文同尺寸的三层合成——图片按原 bbox 嵌回、公式整块/行内以裁剪小图回插（占位符定位，丢失时兜底排段尾）、中文译文按原段落 bbox 流式排版（CJK 逐字断行、字号自适应收缩）。
4. **`run_pipeline.py` 编排**：以上串成一条命令，全程向宿主的进度文件（`<DSH home>/pdf2zh/jobs/<id>.json`）原子写入 `stage/done/total/phase` 与最终 `result`（产出清单、统计、失败段数、渲染警告），看板据此显示**真实**的「翻译 x/y 段」进度；同时产出 `<原名>.zh.md`（伴生 Markdown，公式/插图注明见 PDF）与可选 `<原名>.en-zh.md`。

## 功能

- **技能自动安装**：启动时把 `skill/SKILL.md`、`skill/extract.py` 同步到 `<DSH home>/skills/pdf2zh/`（内容有差异才覆盖）；`glossary.md` 仅在缺失时播种——你积累的术语表不会被升级覆盖（管线翻译时也读取同一份术语表）。
- **提取预览**：面板里填服务器上的 PDF 路径（或**拖拽/选择本地 PDF 上传**到 `<DSH home>/pdf2zh/uploads/`），点「提取预览」查看页数/字符数与前 1200 字符抽查。
- **一键翻译**：点「开始翻译」，插件解析选定的模型 API（含可达性探测），以 `detached` 子进程启动翻译管线（独立进程组，**dsh-web 重启不影响在途任务**，看板自动续跟），任务登记进看板。
- **翻译看板**：顶部实时汇总**进行中 / 已完成 / 已失败**数量与总体进度条；每张卡片显示真实进度（阶段 + 「翻译 x/y 段」）、所用 API、完成后的页数/段数/公式/图片统计；已完成卡片直接给出**可点击的产出下载链接**（`GET /file`，白名单限定任务产出）；失败卡片带「重试」按钮与可操作提示（不可达 / 鉴权失败分别提示）。账本持久化在 `<DSH home>/pdf2zh/jobs.json`；超时（默认 240 分钟）终止翻译进程并记失败；删除卡片会一并终止其运行中的进程。
- **设置弹窗**（右上角「⚙ 设置」）：
  - **模型 API** 页：顶部「自动选择」卡片（优先本地部署 API、探活跳过不可达端点），其下按 provider 卡片列出 dsh 注册表中的全部 API（点选即存默认）；「＋ 手动添加 API」表单（显示名/标识/协议/URL/Key，支持「获取模型」探测与手动填写，写入 dsh `llm-pi-ai` 设置与凭据库、热生效，自添加项可两步确认删除）。
  - **输出与性能** 页：保存路径（常用目录快捷回填、留空 = 源 PDF 同目录）、**翻译并发**（1–16，默认 8；对本地 vLLM 即篇内并发请求数）、任务超时（30 分–12 小时 + 自定义）。
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
| `skillSync` | `true` | 启动时同步技能文件 |
| `skillDir` | `<DSH home>/skills/pdf2zh` | 技能安装目录（可覆盖） |
| `uploadDir` | `<DSH home>/pdf2zh/uploads` | 拖拽上传的存放目录（可覆盖） |
| `outputDir` | `""` | 翻译结果保存目录初始值；运行期以面板「设置」（`settings.json`）为准 |
| `timeoutMinutes` | `240` | 单任务超时（分钟，10–1440）初始值；`settings.json` 优先 |

面板运行期设置（`<DSH home>/pdf2zh/settings.json`）：`outputDir`、`timeoutMinutes`、`model{provider,model}`、`concurrency`（1–16，默认 8）。

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
├── pipeline/                 # 结构化翻译管线（vendored python）
│   ├── extract.py            #   版式感知提取
│   ├── translate.py          #   并发段落翻译（关思考；OpenAI/Anthropic 双协议）
│   ├── render.py             #   排版保真中文 PDF 渲染
│   └── run_pipeline.py       #   编排 + 进度文件 + Markdown 伴生产物
├── skill/                    # pdf2zh 交互技能（供聊天会话使用；含术语表种子）
└── tsdown.client.config.mjs  # 客户端打包配置
```

## 性能参考

| 论文 | 旧架构（会话整篇+思考max） | v0.8 管线（关思考、8 路并发） |
|---|---|---|
| manuscript（35 页 / 102k 字符 / 152 段 / 50 公式 / 18 图） | ≈66 分钟 | 提取 1.2s + 翻译 116s + 渲染 39s ≈ **2.6 分钟** |

吞吐随端点并发扩展（实测同一 vLLM：单流 42 tok/s → 5 并发聚合 147 tok/s），并发数与端点 `max-num-seqs` 相关，可在「输出与性能」中调节。

## License

[MIT](./LICENSE)
