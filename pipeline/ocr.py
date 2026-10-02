"""Optional local OCR for pages without text. Source files are never modified."""
import os
import tempfile
from pathlib import Path
import pymupdf as fitz


def tessdata_dir():
    roots = [os.getenv("PDF2ZH_TESSDATA"), os.getenv("TESSDATA_PREFIX"),
             str(Path(os.getenv("DSH_HOME", str(Path.home() / ".dsh"))) / "ocr" / "tessdata"),
             "C:/Program Files/Tesseract-OCR/tessdata",
             "/usr/share/tesseract-ocr/5/tessdata", "/usr/share/tesseract-ocr/4.00/tessdata",
             "/opt/homebrew/share/tessdata", "/usr/local/share/tessdata"]
    return next((p for p in roots if p and (Path(p) / "eng.traineddata").is_file()), None)


def prepare_pdf(path, progress=None):
    with fitz.open(path) as source:
        pages = {i for i, page in enumerate(source)
                 if not page.get_text().strip() and page.get_images()}
        if not pages:
            return path, set()
        data = tessdata_dir()
        if not data:
            raise RuntimeError("扫描页需要 OCR：请运行 npm run setup:ocr 安装英文识别数据，或设置 PDF2ZH_TESSDATA 指向 tessdata 目录；直接重试或更换 API 无效")
        output = fitz.open()
        try:
            for i, page in enumerate(source):
                if i not in pages:
                    output.insert_pdf(source, from_page=i, to_page=i)
                    continue
                if progress:
                    progress(i + 1, len(source))
                pix = page.get_pixmap(dpi=150, colorspace=fitz.csRGB, alpha=False)
                with fitz.open("pdf", pix.pdfocr_tobytes(language=("eng+chi_sim" if (Path(data) / "chi_sim.traineddata").is_file() else "eng"), tessdata=data)) as recognized:
                    if not recognized[0].get_text().strip():
                        raise RuntimeError("第 %d 页 OCR 未识别到文字，请检查扫描清晰度或排除空白页" % (i + 1))
                    output.insert_pdf(recognized)
            fd, dest = tempfile.mkstemp(suffix=".pdf", prefix="pdf2zh-ocr-")
            os.close(fd)
            try:
                output.save(dest)
            except Exception:
                os.unlink(dest)
                raise
            return dest, pages
        finally:
            output.close()
