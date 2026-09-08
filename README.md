# dsh-pdf2zh

学术论文 PDF 英转中的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件。

把「脚本提取 + 会话内模型逐节翻译」的 pdf2zh 流程装进 dsh：插件在每次启动时自动安装/同步 **pdf2zh 技能**（`~/.dsh/skills/pdf2zh/`），提供一个小的本机 API（`/api/pdf2zh/*`，仅回环同源），并在 Web GUI 里加一个侧边栏入口 + 中列面板：**填 PDF 路径 → 提取预览 → 一键新建会话开始翻译**。

零外部服务、零额外 API key：提取用 PyMuPDF 脚本（自动处理双栏布局、公式原样保留），翻译由当前会话的模型按技能流程完成，术语表（glossary）保证跨论文译名一致。

## 功能

- **技能自动安装**：启动时把 `skill/SKILL.md`、`skill/extract.py` 同步到 `<DSH home>/skills/pdf2zh/`（内容有差异才覆盖）；`glossary.md` 仅在缺失时播种——你积累的术语表不会被升级覆盖。
- **提取预览**：面板里填服务器上的 PDF 路径，点「提取预览」即可看到页数/字符数与前 1200 字符抽查结果（提取产物为 PDF 同目录的 `<同名>.txt`，带 `[PAGE n]` 标记）。
- **一键翻译**：点「开始翻译（新建会话）」，插件通过 `sessionController` 新建一个真实 DSH 会话（工作区默认取 PDF 所在目录），自动重命名为 `[pdf2zh] <文件名>`，并把触发 pdf2zh 技能的提示词排进队列；成功后绿色卡片给出「查看会话」深链（惰性解析 `sessions` 服务，点击后自动收起面板、打开对应会话）。
- **选项**：页码范围（如 `1-8`、`1,3,5-9`）、中英对照（额外产出 `<同名>.en-zh.md`）、含附录（默认只翻正文）。
- **界面**：顶部为「填 PDF 路径 → 提取预览 → 开始翻译 → 查看会话」四步引导；路径输入下方保留最近使用过的路径（localStorage，点击即回填，回车直接提取）；提取成功以绿色卡片展示页数/字符统计与输出路径，可折叠抽查前 1200 字符；术语表卡片内联展示前 5 条、可展开全文；底部状态条以绿/红圆点区分 PyMuPDF 与技能同步的健康状态。
- **状态透明**：面板底部实时显示插件版本、Python/PyMuPDF 可用性与技能同步路径；`GET /health` 可供外部检查。

## 安装

前提：Node ≥ 22.19、dsh ≥ 0.1.2，Python 3 + PyMuPDF（`pip install pymupdf`，`python3 -c "import fitz"` 可运行）。

```sh
# 1. 拉取源码
git clone https://github.com/Zhang6177/dsh-pdf2zh.git
cd dsh-pdf2zh

# 2. 构建客户端包（需要时；仓库已附构建好的 lib/client.js）
pnpm install
pnpm build

# 3. 在 dsh profile 里挂载（以 web profile 为例）
#    ~/.dsh/profiles/web/package.json：
#      "dependencies": { "dsh-pdf2zh": "link:/path/to/dsh-pdf2zh" }
#      "dsh": { "profile": { "bundles": [ ..., "dsh-pdf2zh" ] } }
pnpm install --prefix ~/.dsh/profiles/web
systemctl --user restart dsh-web   # 或你托管 dsh web 的方式
```

插件行由包内 `cordis.patch.yml` 自动插入（`id: pdf2zh`）。启用/停用按行 id 匹配：在 profile 的 `cordis.patch.yml` 里加 `- id: pdf2zh` / `disabled: true` 即可停用。

## 配置

插件行 `config`（`cordis.patch.yml`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭后 API 返回 503 |
| `apiPath` | `/api/pdf2zh` | 同源 API 前缀 |
| `python` | `python3` | extract.py 使用的解释器 |
| `skillSync` | `true` | 启动时同步技能文件 |
| `skillDir` | `<DSH home>/skills/pdf2zh` | 技能安装目录（可覆盖） |

## API（仅本机回环、同源）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/pdf2zh/health` | GET | 插件/Python/PyMuPDF/技能状态 |
| `/api/pdf2zh/skill` | GET | 已安装技能文件清单 |
| `/api/pdf2zh/glossary` | GET | 当前术语表（条数 + 全文） |
| `/api/pdf2zh/extract` | POST | `{path, pages?}` → 运行 extract.py，返回 `{outPath, pages, chars, preview}` |
| `/api/pdf2zh/translate` | POST | `{path, pages?, bilingual?, appendix?, workspace?}` → 新建会话并排队技能提示词，返回 `{sessionId, cwd, title}` |

`path` 必须是服务器上的绝对路径且以 `.pdf` 结尾（≤100 MB）。

## 翻译纪律（由技能保证）

公式不翻译（LaTeX 原样保留）；参考文献不翻译；模型名/数据集名/指标/引用编号/数字单位原样保留；提取不到的图片内容只标注 `(图：…)` 不脑补；学术书面中文文体。详见 `skill/SKILL.md`。

## 目录结构

```
├── cordis.patch.yml          # 插件行插入（id: pdf2zh）
├── package.json              # 双端包：. → host，./client → 浏览器半
├── src/index.js              # host 入口（纯 ESM JS，无构建）
├── src/client/index.ts       # 浏览器半源码（React.createElement 风格）
├── lib/client.js             # 浏览器端构建产物（tsdown/rolldown，react 外部化）
├── skill/                    # pdf2zh 技能（SKILL.md / extract.py / glossary.md）
└── tsdown.client.config.mjs  # 客户端打包配置
```

## License

[MIT](./LICENSE)
