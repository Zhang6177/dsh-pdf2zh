import sys
import pymupdf as fitz

src,out=map(fitz.open,sys.argv[1:3])
assert len(src)==len(out)
for a,b in zip(src,out):
    assert a.rect==b.rect
    assert 'Figure label - unchanged' in b.get_text(clip=fitz.Rect(315,560,530,655))
    assert 'x = y + z' in b.get_text(clip=fitz.Rect(40,550,225,590))
    for region in [fitz.Rect(315,560,530,655),fitz.Rect(48,620,220,706)]:
        assert a.get_pixmap(clip=region).samples==b.get_pixmap(clip=region).samples, 'figure pixels changed'
print('Vector/raster regions and independent equation preserved')
