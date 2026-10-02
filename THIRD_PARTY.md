# 第三方组件

本仓库自行编写的插件代码使用 MIT 许可证（见 LICENSE）。这不替代依赖或字体自身的许可证。

| 组件 | 用途 | 许可信息 |
| --- | --- | --- |
| PyMuPDF / MuPDF | PDF 提取与渲染 | [官方 AGPL / 商业许可说明](https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright) |
| requests | HTTP API 请求 | Apache-2.0；以所安装发行包的 LICENSE 为准 |
| pymupdf-layout（可选） | CPU 版面分析 | [发行页及许可元数据](https://pypi.org/project/pymupdf-layout/)；安装前请确认其适用条件 |
| React / schemastery | DSH 界面和配置 | MIT；由宿主或包管理器提供 |
| 系统中文字体 | 中文 PDF 排版 | 不随项目分发；遵循操作系统或字体供应方条款 |

项目不分发模型权重、第三方字体或论文。自建模型服务的模型许可及 API 服务条款由部署者确认。
# 可选 OCR 数据

`setup:ocr` 按需从 [Tesseract tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) 下载中英文识别数据（Apache-2.0）；数据不随源码或插件包分发。识别由 PyMuPDF 集成的 Tesseract 逻辑执行。
