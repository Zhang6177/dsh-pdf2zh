"""Generate a synthetic paper; no private or copyrighted input is distributed."""
import sys
import pymupdf as fitz

doc = fitz.open()
for n in range(2):
    page = doc.new_page(width=595, height=842)
    page.insert_text((48, 48), "Example Paper: Layout and Translation", fontsize=16)
    for col, x in enumerate((48, 312)):
        for i in range(7):
            y = 90 + i * 62
            text = ("This paragraph describes a simple scientific experiment. "
                    "The method preserves document geometry and evaluates accuracy.")
            page.insert_textbox(fitz.Rect(x, y, x + 230, y + 50), text, fontsize=10)
    page.insert_text((48, 575), "x = y + z     (1)", fontsize=12)
    page.draw_rect(fitz.Rect(315, 560, 530, 655), color=(0, 0, 1))
    page.insert_text((335, 605), "Figure label - unchanged", fontsize=10)
    # A raster figure checks image preservation.
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 60, 30), False)
    pix.clear_with(150)
    page.insert_image(fitz.Rect(48, 620, 220, 706), pixmap=pix)
doc.save(sys.argv[1])
