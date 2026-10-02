# dsh-pdf2zh

[DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的学术论文 PDF 英译中插件。
上传 PDF、配置自己的 API，即可生成中文 PDF 和 Markdown，查看进度、下载结果并重试失败任务。
无需修改源码、本机 GPU 或模型权重。公开版本不附带任何可用 API、密钥或个人服务器配置。
插件面板需要 DSH；Python 管线也可以单独运行。

## 功能

- 拖拽上传或填写文件绝对路径，支持中文与空格路径；提取预览与页码选择。
- OpenAI Chat Completions / Anthropic Messages 兼容 API，设置面板配置地址、密钥、模型。
- 顺序段落翻译、术语表编辑、进度看板、下载、失败重试、超时终止。
- 保留页面尺寸，尽量保护图像、表格和独立公式，中文正文按列排版。
- 行内公式使用 Unicode 文本与上下标；空间不足的段落保留英文并记录警告。
- 可选附录和中英对照 Markdown；后台管线可在 DSH 重启后继续被跟踪。

默认生成 `论文.zh.pdf`、`论文.zh.md`，勾选对照另生成 `论文.en-zh.md`。
复杂版式仍需人工检查。扫描版需先自行 OCR；项目不包含 OCR 或 LaTeX 编译器。

## 环境要求

| 组件 | 要求 |
| --- | --- |
| DSH | 推荐 0.2.0-rc.2，或兼容其插件、settings、credentials、modelCatalog 接口的版本 |
| Node.js | >=22.19.0，终端可找到 node、npm；CLI 用户还需 dsh |
| Python | 64 位 >=3.10，推荐 3.11/3.12 |
| 必需依赖 | pymupdf==1.28.2、requests>=2.31,<3 |
| 可选依赖 | pymupdf-layout==1.28.2（CPU 版面分析），未装时使用几何规则 |
| 中文字体 | Windows 尝试微软雅黑/黑体，macOS 尝试苹方，Linux 建议 Noto Sans CJK |
| 模型服务 | 用户自己的兼容 API、模型 ID，及服务需要的密钥 |

本机提取与排版使用 CPU。React 与宿主服务由 DSH 提供，安装时包管理器处理声明的依赖。
依赖和字体许可见 [THIRD_PARTY.md](THIRD_PARTY.md)。

## 安装

### 1. 下载

下载仓库 ZIP 并解压，或执行：

```sh
git clone https://github.com/Zhang6177/dsh-pdf2zh.git
cd dsh-pdf2zh
```

下列命令在项目目录运行。项目附带已构建的 lib/client.js，使用时无需构建前端。

### 2. 安装 Python 依赖

Windows、Linux、macOS 均可执行：

```sh
node scripts/setup-python.mjs
```

脚本创建独立虚拟环境并打印解释器路径。环境默认在 `<DSH_HOME>/python-envs/pdf2zh`，
未设置 DSH_HOME 时使用用户目录的 `.dsh/python-envs/pdf2zh`。
若 Desktop 使用不同数据目录，稍后在插件设置中粘贴打印的 Python 路径即可。

```sh
# 可选：指定解释器和环境目录，路径有空格时加引号
node scripts/setup-python.mjs --python "/path/to/python" --venv "/path/to/venv"
# 可选：同时安装版面分析模型
node scripts/setup-python.mjs --layout
```

也可自行建 venv，然后用该环境的 Python 运行 `python -X utf8 -m pip install -r pipeline/requirements.txt`。
Debian/Ubuntu 可用 `sudo apt-get install fonts-noto-cjk` 安装中文字体。
自定义字体可在启动 DSH 前设置 `PDF2ZH_CJK_FONT` 为字体绝对路径；粗体、数学字体可用
`PDF2ZH_CJK_FONT_BOLD`、`PDF2ZH_MATH_FONT` 指定。项目不分发第三方字体。

### 3. 安装到 DSH

```sh
npm pack
```

得到 dsh-pdf2zh-0.13.1.tgz。

**Desktop：**进入插件/组合包管理界面，安装本地包，填写 tgz 完整路径并启用。
如提示需要重启，退出后重新打开。安装到实际使用的 profile；每个 profile 独立。

**Web CLI：**在已装好 DSH 的终端执行：

```sh
dsh plugin --profile web add ./dsh-pdf2zh-0.13.1.tgz
dsh --profile web
```

已运行 Web 服务时按原有方式重启，无需启动第二个 Host。安装后应出现「PDF 英转中」。

## API 配置

1. 打开「PDF 英转中 → 设置 → 模型 API」。可选择 DSH 已有模型，或点「手动添加 API」。
2. 填显示名和唯一标识，如 my-translation；选择协议，填地址与密钥。
3. 点击「获取模型」，或手动填正确的模型 ID；保存并设为默认。

| 字段 | 含义 |
| --- | --- |
| 地址 | 如 https://api.example.com/v1，请换成服务方提供的实际 API 根地址 |
| 协议 | OpenAI Chat Completions 或 Anthropic Messages；不支持 Responses |
| 密钥 | 服务方提供的 Key；无鉴权服务可留空；只保存到 DSH 凭据库，不回显 |
| 模型 ID | /models 返回的 ID 或服务方文档提供的 ID，不能使用自定义显示名替代 |

OpenAI 使用 `/chat/completions`，地址不含 `/v1` 时补为 `/v1/chat/completions`；
Anthropic 使用 `/v1/messages`。特殊网关请按服务文档配置完整根路径。
无法获取模型列表时可以手填 ID。「已注册」仅表示存在于模型目录，不代表当前可达。
固定默认 API 不可用时会明确报错，不悄悄换成另一家服务。
自动模式优先本地部署项；为避免意外调用服务，建议明确设置默认模型。
修改地址或密钥可删除自己添加的 API 后重建，或使用 DSH 自身的模型设置。

## 使用与启动

1. 底部 Python 状态失败时，在「设置 → 输出与性能 → Python 环境」粘贴解释器路径并保存，立即检查与生效。
2. 拖入 PDF 或填运行 DSH 的电脑上的文件绝对路径；可先提取预览。
3. 按需填页码，如 1-3、1,3,5-8，勾选中英对照或附录，点击开始翻译。
4. 在看板查看进度和下载结果；失败后修正配置再重试。

设置中可调输出目录、字号收缩（0–3pt）和超时。
翻译按顺序调用配置的 API，无需设置并发。源文件目录不可写时请设置可写输出目录。
同一 PDF 进行中不能重复启动。默认翻译到参考文献前；附录选项识别常见 Appendix/Supplementary 标题，参考文献不翻译。

## 数据与配置

私有运行数据默认在已安装插件的 data/：settings.json、jobs.json、jobs/、uploads/、skills/pdf2zh/。
升级前建议备份。可在 DSH 插件配置设置 dataDir，或在启动前设置 PDF2ZH_DATA_DIR。
更改目录不自动迁移旧任务；不同 Host/profile 应使用不同 dataDir。
API 设置与密钥由 DSH 管理，禁止将这些私有部署文件提交到仓库。

## 单独运行 Python 管线（可选）

安装依赖与字体后，设置环境变量再运行 pipeline/run_pipeline.py；.env.example 是模板，不会自动读取。
密钥提前通过受保护环境注入 PDF2ZH_API_KEY，避免写进脚本或命令历史。

PowerShell：

```powershell
$env:PDF2ZH_PDF = 'C:\papers\paper.pdf'
$env:PDF2ZH_OUT_DIR = 'C:\papers\translated'
$env:PDF2ZH_PROGRESS_PATH = 'C:\papers\translated\progress.json'
$env:PDF2ZH_VLLM_URL = 'https://api.example.com/v1'
$env:PDF2ZH_MODEL = 'your-model-id'
& 'C:\path\to\venv\Scripts\python.exe' -X utf8 pipeline/run_pipeline.py
```

Linux/macOS：

```sh
export PDF2ZH_PDF='/path/to/paper.pdf'
export PDF2ZH_OUT_DIR='/path/to/output'
export PDF2ZH_PROGRESS_PATH='/path/to/output/progress.json'
export PDF2ZH_VLLM_URL='https://api.example.com/v1'
export PDF2ZH_MODEL='your-model-id'
/path/to/venv/bin/python -X utf8 pipeline/run_pipeline.py
```

可选变量：PDF2ZH_API=openai|anthropic、PDF2ZH_PAGES、PDF2ZH_BILINGUAL=1、
PDF2ZH_APPENDIX=1、PDF2ZH_GLOSSARY、PDF2ZH_FONT_SHRINK、PDF2ZH_REQ_TIMEOUT。
模型仅接收正文段落，提取和排版由本地脚本完成；未配置 API 时明确报错。

## 可选：扫描版 PDF 的 OCR

普通文本 PDF 只需配置翻译 API。扫描版 PDF 可额外运行：

```sh
npm run setup:ocr
```

此命令下载 Tesseract 官方英文和简体中文识别数据（共约 7 MB），保存到 `DSH_HOME/ocr/tessdata`，未设置 DSH_HOME 时使用 `~/.dsh/ocr/tessdata`。识别复用 PyMuPDF 的集成 OCR，不添加新的 Python 包。识别在本机进行，翻译阶段才向配置的 API 发送文字。

安装后扫描页自动先 OCR 再翻译；有文本层的页保持原流程。也可安装系统 Tesseract，或通过 `PDF2ZH_TESSDATA` 指向含 `eng.traineddata`、`chi_sim.traineddata` 的目录。网络不可用时可手动下载 [英文数据](https://github.com/tesseract-ocr/tessdata_fast/blob/main/eng.traineddata) 及 [中文数据](https://github.com/tesseract-ocr/tessdata_fast/blob/main/chi_sim.traineddata) 到该目录。环境变量需在启动 DSH 前设置。

默认支持英文与简体中文 OCR；中文为主的材料会提示无需英转中。仅安装英文数据时只能可靠识别英文。模糊扫描、复杂公式和图表可能识别不准，必须核对输出；扫描页采用识别文字区域的白底覆盖，原文件不改动，未翻译区域保留扫描图像。图表边界保护取决于版式识别，不能保证所有扫描论文的图表都完整识别。没有图片的空白页跳过 OCR。

## 常见问题

| 问题 | 处理 |
| --- | --- |
| Python 不可用 | 运行安装脚本；填解释器完整路径，而不是 venv 目录；保存时立即检查 |
| API 不可达 | 核对地址、网络、防火墙、服务状态；本地 DSH 的 127.0.0.1 指本机，不能代表远程服务器 |
| 401/403 | 修正密钥与权限后重试；不会持续重试鉴权错误 |
| 400/404/422 | 核对协议、根路径和模型 ID；服务若不接受 chat_template_kwargs，可使用兼容网关 |
| 429/5xx/超时 | 检查 API 限流；临时错误有限重试，超过任务超时会终止 |
| 缺字体 | 安装 Noto Sans CJK 或设置 PDF2ZH_CJK_FONT |
| 扫描版/中文 PDF | 扫描版先 OCR，中文为主的文档无需英译中 |
| 残留英文/排版警告 | 检查图表、公式、参考文献或空间不足区域；适当增大字号收缩量，并复核可读性 |
| 新模型未出现 | 等待目录更新；需要时按宿主提示重启 |
| 升级后旧卡片仍在 | 卡片是私有任务数据，可单独删除或清空结束任务，不删除原 PDF 与译文 |

隐私、日志和部署安全见 [SECURITY.md](SECURITY.md)。

## 开发与验证

```sh
npm ci
npm run typecheck
npm run build
# 先设置 PDF2ZH_PYTHON 为已装依赖的解释器路径
npm test
node scripts/scan-public.mjs
npm pack --dry-run
```

测试现场生成合成 PDF，使用本地模拟 API，不带真实论文/密钥，不调用收费 API。
覆盖提取、路径、上传、翻译、版式、下载限制、鉴权失败、重试和账本。
`pipeline/verify.py 原文.pdf 译文.pdf --strict` 检查新增压字、缺图和越界；复杂版式仍需人工检查。
CI 配置覆盖 Windows、Linux、macOS；实际通过情况见仓库 Actions。
