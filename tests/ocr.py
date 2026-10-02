import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import pymupdf as fitz

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pipeline'))
import ocr
from extract import extract_paper


class OCRTests(unittest.TestCase):
    def test_short_document_and_scan(self):
        with tempfile.TemporaryDirectory() as directory:
            short = Path(directory) / 'short.pdf'
            scan = Path(directory) / 'scan.pdf'
            doc = fitz.open()
            page = doc.new_page()
            page.insert_textbox(fitz.Rect(60, 90, 500, 180),
                                'A short document contains one paragraph. The method preserves geometry and evaluates translation accuracy.', fontsize=14)
            doc.save(short)
            pix = page.get_pixmap(dpi=150)
            image = fitz.open()
            image.new_page(width=page.rect.width, height=page.rect.height).insert_image(page.rect, pixmap=pix)
            image.save(scan)
            doc.close()
            image.close()
            self.assertEqual(ocr.prepare_pdf(str(short)), (str(short), set()))
            self.assertGreater(extract_paper(str(short)).stats()['to_translate'], 0)
            with patch.object(ocr, 'tessdata_dir', return_value=None):
                with self.assertRaisesRegex(RuntimeError, 'setup:ocr'):
                    ocr.prepare_pdf(str(scan))
            if ocr.tessdata_dir():
                prepared, pages = ocr.prepare_pdf(str(scan))
                try:
                    self.assertEqual(pages, {0})
                    with fitz.open(prepared) as result:
                        self.assertIn('short document', result[0].get_text())
                    self.assertGreater(extract_paper(prepared, pages).stats()['to_translate'], 0)
                    self.assertTrue(scan.exists())
                finally:
                    os.unlink(prepared)

    def test_chinese_scan_is_recognized_as_chinese(self):
        data = ocr.tessdata_dir()
        if not data or not (Path(data) / 'chi_sim.traineddata').is_file():
            self.skipTest('optional Chinese OCR data not installed')
        with tempfile.TemporaryDirectory() as directory:
            doc = fitz.open()
            page = doc.new_page()
            page.insert_text((60, 100), '中文扫描文档应该识别为中文，不需要重复翻译。', fontname='china-s', fontsize=20)
            scan = fitz.open()
            scan.new_page().insert_image(page.rect, pixmap=page.get_pixmap(dpi=150))
            path = str(Path(directory) / 'chinese.pdf')
            scan.save(path)
            doc.close()
            scan.close()
            prepared, _ = ocr.prepare_pdf(path)
            try:
                with fitz.open(prepared) as result:
                    text = result[0].get_text()
                    self.assertGreater(sum('\u4e00' <= c <= '\u9fff' for c in text) / max(len(text), 1), 0.2)
            finally:
                os.unlink(prepared)


if __name__ == '__main__':
    unittest.main()
