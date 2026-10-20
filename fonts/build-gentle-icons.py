# Builds GentleIcons.ttf: the icon font for the RDD row icon (U+100030, private use).
# The glyph is Octicons' thin wrench ("oct-tools" in the Nerd Fonts) scaled to 75%,
# so it stands about as tall as a digit and sits centred on the lowercase letters.
#
# Wrench outline from GitHub Octicons (MIT License), via Nerd Fonts.
#
# Run: uv run --no-project --with fonttools python fonts/build-gentle-icons.py [nerd-font.ttf]
import sys
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

SOURCE = sys.argv[1] if len(sys.argv) > 1 else "/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Regular.ttf"
OUTPUT = Path(__file__).with_name("GentleIcons.ttf")
SCALE = 0.75
ADVANCE = 600

src = TTFont(SOURCE)
box = src["glyf"]["oct-tools"]
cx, cy = (box.xMin + box.xMax) / 2, (box.yMin + box.yMax) / 2
tx, ty = 300 - cx * SCALE, 280 - cy * SCALE

pen = TTGlyphPen(None)
src.getGlyphSet()["oct-tools"].draw(TransformPen(pen, (SCALE, 0, 0, SCALE, tx, ty)))
wrench = pen.glyph()

fb = FontBuilder(1000, isTTF=True)
fb.setupGlyphOrder([".notdef", "wrench"])
fb.setupCharacterMap({0x100030: "wrench"})
fb.setupGlyf({".notdef": TTGlyphPen(None).glyph(), "wrench": wrench})
fb.setupHorizontalMetrics({".notdef": (ADVANCE, 0), "wrench": (ADVANCE, wrench.xMin)})
fb.setupHorizontalHeader(ascent=1020, descent=-300)
fb.setupOS2(sTypoAscender=1020, sTypoDescender=-300, usWinAscent=1020, usWinDescent=300, xAvgCharWidth=ADVANCE)
fb.setupPost(isFixedPitch=1)
fb.setupNameTable({
    "familyName": "Gentle Icons",
    "styleName": "Regular",
    "copyright": "Wrench outline from GitHub Octicons (MIT License), via Nerd Fonts",
})
fb.save(OUTPUT)
print(f"wrote {OUTPUT}")
