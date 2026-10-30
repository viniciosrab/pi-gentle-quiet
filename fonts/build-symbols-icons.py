# Builds GentleSymbols.ttf ("Gentle Symbols"): Miguel Solorio's Symbols file icon theme for VS Code
# (https://github.com/miguelsolorio/vscode-symbols, MIT License, fonts/LICENSE-vscode-symbols) as a private-use
# icon font, one monochrome glyph per icon from U+100100, and writes extensions/sidebar/symbols-icons.ts, the
# theme's file name, extension and folder name maps pointing at those glyphs and each icon's color.
#
# Pinned at vscode-symbols 2c95b15b0a8ef95ac62855e3784a6024ee6e5d2e (v0.0.25, 2026-10-18).
#
# Each SVG goes through picosvg (strokes, circles, rects, lines, transforms and clip paths become filled paths),
# then its shapes are merged in paint order: a shape lying inside what is already drawn, in a color other than
# the one under it, cuts a hole (the white letters on a colored badge); any other shape adds to the glyph.
# The glyph is sized by its ink, not its view box (the SVGs pad their drawings differently): the ink is scaled to
# HEIGHT units tall, or WIDTH wide when that is the tighter fit, so a page, a folder and a circle read the same
# size; it is centred on the cap height like the Nerd Font icons. Its advance is one cell (600 of a 1000 em), so it
# overflows into the space TREE draws after it, about as wide as the two-cell emoji it stands in for. FreeType
# does not hint these glyphs across (foot's slight hinting), so the outline is fitted to the pixel grid of the
# terminal's size here: straight edges, curve extremes and the ink's own edges go to whole pixels, strokes keep a
# whole-pixel width and the gaps between parts a pixel at least, the rest of the outline follows them; slivers
# left by the merges are dropped. The color is the one painting the largest area, a grey only when nothing else is painted
# (a folder's colored badge gives the folder its color).
#
# Run: uv run --no-project --with fonttools --with picosvg python fonts/build-symbols-icons.py [vscode-symbols checkout]
# With no checkout, the pinned commit is cloned into a temporary directory.
import json
import re
import subprocess
import sys
import tempfile
from copy import deepcopy
from pathlib import Path

import pathops
from fontTools.fontBuilder import FontBuilder
from fontTools.misc.timeTools import timestampFromString
from fontTools.pens.areaPen import AreaPen
from fontTools.pens.basePen import BasePen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.reverseContourPen import ReverseContourPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from lxml import etree
from picosvg.svg import SVG
from picosvg.svg_pathops import skia_path, svg_commands
from picosvg.svg_types import SVGPath

REPO = "https://github.com/miguelsolorio/vscode-symbols"
PIN = "2c95b15b0a8ef95ac62855e3784a6024ee6e5d2e"
FIRST = 0x100100
ADVANCE = 600
# The pixel grid the outlines are fitted to: one pixel in font units at foot's size=10.3 on a 96 dpi screen
# (13.73 px per em, 8 px cells), which renders the Symbols icons' 1.5-unit strokes one pixel wide.
PX = 1000 / (round(10.3 * 64 * 96 / 72) / 64)
CENTRE_Y = 5 * PX  # about half the cap height (730), where the Nerd Font icons are centred, on a pixel line
HEIGHT = 12 * PX  # the ink's height: about the cap height and a pixel over and under it
WIDTH = 13 * PX  # the widest ink (folders): its own cell and most of the space after it, 3 px clear of the name
CENTRE_X = 8 * PX  # from the cell's left edge
STEM_MAX = 3 * PX  # the widest stroke kept a whole number of pixels wide
EDGE_MIN = PX  # the shortest straight run or curve put on the grid
ROOT = Path(__file__).resolve().parent.parent
FONT = ROOT / "fonts" / "GentleSymbols.ttf"
MODULE = ROOT / "extensions" / "sidebar" / "symbols-icons.ts"

# Extensions and file names VS Code gives a language the theme has an icon for (languageIds), where the theme
# has no fileExtensions or fileNames entry of its own: VS Code's built-in language associations.
LANGUAGE_EXTENSIONS = {
    "php": "php", "phtml": "php", "pl": "perl", "pm": "perl", "clj": "clojure", "cljs": "clojure", "cljc": "clojure",
    "edn": "clojure", "vue": "vue", "hpp": "cpp", "hxx": "cpp", "cxx": "cpp", "ini": "properties",
    "properties": "properties", "cfg": "properties", "conf": "properties", "mk": "makefile", "psm1": "powershell",
    "cmd": "bat", "mts": "typescript", "cts": "typescript", "jsonc": "json", "markdown": "markdown",
    "mkd": "markdown", "rst": "plaintext", "log": "plaintext", "tsv": "tsv",
}
LANGUAGE_FILENAMES = {"makefile": "makefile", "gnumakefile": "makefile", "dockerfile": "dockerfile", ".gitignore": "ignore"}


def checkout():
    if len(sys.argv) > 1:
        repo = Path(sys.argv[1])
        head = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        if head != PIN:
            sys.exit(f"{repo} is at {head or 'no commit'}, not the pinned {PIN}")
        return repo
    repo = Path(tempfile.mkdtemp()) / "vscode-symbols"
    subprocess.run(["git", "clone", "-q", REPO, repo], check=True)
    subprocess.run(["git", "-C", repo, "checkout", "-q", PIN], check=True)
    return repo


def theme_json(repo):
    contribution = json.loads((repo / "package.json").read_text())["contributes"]["iconThemes"][0]["path"]
    path = repo / contribution
    # The extension writes symbol-icon-theme.modified.json from the user's settings at run time.
    return path if path.exists() else repo / contribution.replace(".modified", "")


NAMED = {"white": "#ffffff", "black": "#000000"}
SVG_NS = "http://www.w3.org/2000/svg"


def hex_color(value):
    value = NAMED.get(value.strip().lower(), value.strip().lower())
    if value.startswith("rgb("):
        parts = [part.strip() for part in value[4:-1].split(",")[:3]]
        r, g, b = (round(float(part[:-1]) * 2.55) if part.endswith("%") else int(float(part)) for part in parts)
        return f"#{r:02x}{g:02x}{b:02x}"
    if not value.startswith("#"):
        return None
    if len(value) == 4:
        value = "#" + "".join(c * 2 for c in value[1:])
    return value[:7]


def shape_color(svg, shape):
    fill = shape.fill
    if fill.startswith("url("):
        # A gradient: its first stop's color (a pattern has none and paints nothing here).
        ref = fill[fill.index("#") + 1 : fill.rindex(")")]
        stops = svg.xpath(f"//svg:*[@id='{ref}']/svg:stop")
        if not stops:
            return None
        style = dict(p.split(":", 1) for p in stops[0].get("style", "").replace(" ", "").split(";") if ":" in p)
        return hex_color(stops[0].get("stop-color") or style.get("stop-color") or "#000")
    if fill in ("none", "transparent"):
        return None
    return hex_color(fill)


def luminance(color):
    r, g, b = (int(color[i : i + 2], 16) for i in (1, 3, 5))
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255


def grey(color):
    """A mid grey, like the slate of Symbols' folders: a colored badge on it names the icon's color."""
    r, g, b = (int(color[i : i + 2], 16) for i in (1, 3, 5))
    return (max(r, g, b) - min(r, g, b)) / max(r, g, b, 1) < 0.3 and 0.15 < luminance(color) < 0.85


def main_color(areas):
    colored = {color: area for color, area in areas.items() if not grey(color)}
    return max(colored or areas, key=(colored or areas).get)


def distinct(one, other):
    return sum((int(one[i : i + 2], 16) - int(other[i : i + 2], 16)) ** 2 for i in (1, 3, 5)) ** 0.5 > 40


def combine(shape, path, operation):
    try:
        return pathops.op(shape, path, operation)
    except pathops.PathOpsError:
        pass
    if operation == pathops.PathOp.INTERSECTION:
        return pathops.Path()
    # Skia cannot merge some pairs: both are kept as contours of their own, wound so that the nonzero rule adds
    # the path (same direction) or cuts it out (opposite direction).
    merged = pathops.simplify(shape, clockwise=True)
    merged.addPath(pathops.simplify(path, clockwise=operation == pathops.PathOp.UNION))
    return merged


def overlap(path, other, operation, failed):
    """The area of `operation` on the two paths, or `failed` when Skia cannot work it out."""
    try:
        return abs(pathops.op(path, other, operation).area)
    except pathops.PathOpsError:
        return failed


def painted(svg):
    """The SVG's filled shapes in paint order, as (Skia path, color, area)."""
    for item in svg.shapes():
        color = shape_color(svg, item)
        if not color or item.opacity * item.fill_opacity <= 0:
            continue
        path = skia_path(item.as_cmd_seq(), item.fill_rule)
        if abs(path.area):
            yield path, color, abs(path.area)


def mask_region(root, mask, view_box):
    """A mask as the area it lets through: white shapes (any shape for an alpha mask) add, darker ones cut."""
    alpha = "alpha" in (mask.get("style") or "") or mask.get("mask-type") == "alpha"
    group = etree.Element(f"{{{SVG_NS}}}g", fill=mask.get("fill", "black"))
    group.extend(deepcopy(child) for child in mask)
    mini = etree.Element(f"{{{SVG_NS}}}svg", viewBox=view_box, nsmap={None: SVG_NS})
    for defs in root.iter(f"{{{SVG_NS}}}defs"):
        mini.append(deepcopy(defs))
    mini.append(group)
    region = pathops.Path()
    for path, color, _ in painted(SVG.fromstring(etree.tostring(mini).decode()).topicosvg()):
        region = combine(region, path, pathops.PathOp.UNION if alpha or luminance(color) >= 0.5 else pathops.PathOp.DIFFERENCE)
    if all(mask.get(key) for key in ("x", "y", "width", "height")):
        x, y, w, h = (float(mask.get(key)) for key in ("x", "y", "width", "height"))
        bounds = pathops.Path()
        bounds.moveTo(x, y), bounds.lineTo(x + w, y), bounds.lineTo(x + w, y + h), bounds.lineTo(x, y + h), bounds.close()
        region = combine(region, bounds, pathops.PathOp.INTERSECTION)
    return region


def prepared(file):
    """The SVG with what picosvg does not take turned into what it does: <style> classes inlined, masks as clip paths."""
    root = etree.parse(str(file)).getroot()
    for style in list(root.iter(f"{{{SVG_NS}}}style")):
        for selector, body in re.findall(r"\.([\w-]+)\s*\{([^}]*)\}", style.text or ""):
            for element in root.xpath(f"//*[contains(concat(' ', @class, ' '), ' {selector} ')]"):
                for declaration in body.split(";"):
                    if ":" in declaration:
                        key, value = (part.strip() for part in declaration.split(":", 1))
                        if element.get(key) is None:
                            element.set(key, value)
        style.getparent().remove(style)
    for element in root.xpath("//*[@class]"):
        del element.attrib["class"]
    view_box = root.get("viewBox") or f"0 0 {root.get('width', 24)} {root.get('height', 24)}"
    for mask in list(root.iter(f"{{{SVG_NS}}}mask")):
        region = mask_region(root, mask, view_box)
        users = root.xpath(f"//*[@mask='url(#{mask.get('id')})']")
        mask.getparent().remove(mask)
        for element in users:
            del element.attrib["mask"]
            if region.area == 0:
                element.getparent().remove(element)
                continue
            clip = etree.SubElement(root, f"{{{SVG_NS}}}clipPath", id=f"{mask.get('id')}-clip")
            etree.SubElement(clip, f"{{{SVG_NS}}}path", d=SVGPath.from_commands(svg_commands(region)).d)
            if element.get("clip-path"):
                wrapper = etree.Element(f"{{{SVG_NS}}}g", {"clip-path": f"url(#{clip.get('id')})"})
                element.addprevious(wrapper)
                wrapper.append(element)
            else:
                element.set("clip-path", f"url(#{clip.get('id')})")
    return SVG.fromstring(etree.tostring(root).decode())


class CubicPen(BasePen):
    """Draws into a Skia path with quadratic curves turned into the same cubic ones, so only lines and cubic
    curves have to be grid-fitted."""

    def __init__(self, path):
        super().__init__()
        self.path = path

    def _moveTo(self, point):
        self.path.moveTo(*point)

    def _lineTo(self, point):
        self.path.lineTo(*point)

    def _curveToOne(self, one, two, three):
        self.path.cubicTo(*one, *two, *three)

    def _closePath(self):
        self.path.close()


def without_specks(path):
    """The path without contours too small to show (slivers left by the merges)."""
    kept = pathops.Path()
    for contour in path.contours:
        (x0, y0, x1, y1), area = contour.bounds, abs(contour.area)
        if area >= (PX / 4) ** 2 and min(x1 - x0, y1 - y0) >= PX / 8:
            kept.addPath(contour)
    try:
        kept = pathops.simplify(kept)
    except pathops.PathOpsError:
        pass
    cubic = pathops.Path()
    kept.draw(CubicPen(cubic))  # simplify() can bring quadratic curves back
    return cubic


def edges(path, axis):
    """The outline's edges across `axis` (0: x, 1: y): straight runs along the other axis and curve extremes, as
    (coordinate, low, high, side) with `side` +1 where the ink lies on the coordinate's higher side, -1 lower."""
    found = []

    def edge(point, low, high):
        probe = list(point)
        probe[axis] += PX / 4
        side = 1 if path.contains(tuple(probe)) else -1
        probe[axis] -= PX / 2
        if path.contains(tuple(probe)) == (side == 1):
            return  # ink on both sides or neither: not an edge of a stem
        found.append((point[axis], low, high, side))

    for contour in path.contours:
        start = None
        current = None
        for verb, points in contour.segments:
            if verb == "moveTo":
                start = current = points[0]
                continue
            if verb == "closePath":
                points = (start,)
                verb = "lineTo"
            end = points[-1]
            other = 1 - axis
            if verb == "lineTo":
                if abs(end[axis] - current[axis]) < PX / 16 and abs(end[other] - current[other]) >= EDGE_MIN:
                    middle = tuple((a + b) / 2 for a, b in zip(current, end))
                    edge(middle, min(current[other], end[other]), max(current[other], end[other]))
            else:
                # A curve's ends where it runs along the other axis are its extremes on this one (small curves
                # follow the edges around them instead).
                if max(abs(p[other] - current[other]) for p in points) < EDGE_MIN:
                    current = end
                    continue
                for at, near in ((current, points[0]), (end, points[-2])):
                    if abs(near[axis] - at[axis]) < PX / 16 and abs(near[other] - at[other]) > 0:
                        edge(at, at[other] - PX / 2, at[other] + PX / 2)
            current = end
    return found


def fitted_axis(path, axis):
    """Where each edge across `axis` goes on the pixel grid: (original, fitted) pairs sorted by original. Stems (an
    edge where ink starts and the nearest one after it where ink ends, facing each other) keep a whole-pixel
    width of at least one pixel; other edges go to the nearest pixel line. None when that would move an edge
    more than a pixel."""
    found = edges(path, axis)
    starts = [e for e in found if e[3] == 1]
    ends = [e for e in found if e[3] == -1]
    stems = []
    for a, lo, hi, _ in starts:
        facing = [(b, min(hi, h) - max(lo, l)) for b, l, h, _ in ends if 0 < b - a <= STEM_MAX and min(hi, h) > max(lo, l)]
        if facing:
            b, shared = min(facing)
            stems.append((-shared, a, b))
    fixed = {}
    key = lambda value: round(value, 1)
    for _, a, b in sorted(stems):
        width = max(1, round((b - a) / PX)) * PX
        if key(a) in fixed and key(b) in fixed:
            continue
        if key(a) in fixed:
            fixed[key(b)] = fixed[key(a)] + width
        elif key(b) in fixed:
            fixed[key(a)] = fixed[key(b)] - width
        else:
            low = round(((a + b) / 2 - width / 2) / PX) * PX
            fixed[key(a)], fixed[key(b)] = low, low + width
    sides = {}
    for value, _, _, side in found:
        fixed.setdefault(key(value), round(value / PX) * PX)
        sides.setdefault(key(value), set()).add(side)
    pairs = sorted(fixed.items())
    for i in range(1, len(pairs)):
        (before, placed), (value, target) = pairs[i - 1], pairs[i]
        # Never fold the outline over itself, and keep a pixel of ink or of space between facing edges a third
        # of a pixel apart or more (the gaps between the parts of an icon), moving an edge a pixel at most.
        least = placed
        if value - before >= PX / 3 and sides[before] != sides[value] and placed + PX - round(value / PX) * PX <= PX:
            least = placed + PX
        if target < least:
            pairs[i] = (value, least)
    if any(abs(fitted - value) > PX for value, fitted in pairs):
        return []  # details too fine for the grid (stripes under a pixel apart): left as drawn
    return pairs


def moved(value, pairs):
    """`value` moved with its fitted edges: shifted like the nearest edge outside them, interpolated between two."""
    if not pairs:
        return value
    if value <= pairs[0][0]:
        return value + pairs[0][1] - pairs[0][0]
    if value >= pairs[-1][0]:
        return value + pairs[-1][1] - pairs[-1][0]
    for (a, fa), (b, fb) in zip(pairs, pairs[1:]):
        if a <= value <= b:
            return fa + (value - a) * (fb - fa) / (b - a) if b > a else fa
    return value


def with_extremes(pairs, low, high):
    """The fitted edges with the ink's own extremes on the axis put on pixel lines too, so that a rounded corner
    or a curve's tip is not dragged off the size the icon was scaled to by the nearest fitted edge."""
    snap = lambda value: round(value / PX) * PX
    if not pairs or low < pairs[0][0] - PX / 16:
        pairs = [(low, min(snap(low), pairs[0][1]) if pairs else snap(low)), *pairs]
    if high > pairs[-1][0] + PX / 16:
        pairs = [*pairs, (high, max(snap(high), pairs[-1][1]))]
    return pairs


def grid_fitted(path):
    """The path with its stems on whole pixels at the terminal's size (see PX), so they render as solid lines."""
    ink = BoundsPen(None)
    path.draw(ink)
    left, bottom, right, top = ink.bounds
    xs, ys = with_extremes(fitted_axis(path, 0), left, right), with_extremes(fitted_axis(path, 1), bottom, top)
    if moved(right, xs) > CENTRE_X + WIDTH / 2 + PX / 2 + PX / 16 and moved(left, xs) >= PX:
        # Edges pushed apart made it wider than WIDTH: a pixel to the left, off the file name after it.
        xs = [(value, fitted - PX) for value, fitted in xs]
    fitted = pathops.Path()
    draw = {"moveTo": fitted.moveTo, "lineTo": fitted.lineTo, "curveTo": fitted.cubicTo}
    for verb, points in path.segments:
        if verb == "closePath":
            fitted.close()
        else:
            draw[verb](*(round(c) for x, y in points for c in (moved(x, xs), moved(y, ys))))
    return fitted


def icon_glyph(file):
    svg = prepared(file).topicosvg()
    shape = None
    areas = {}
    below = []  # the shapes painted so far, as (path, color)
    for path, color, area in painted(svg):
        if shape is None:
            shape = path
        else:
            # A detail of another color drawn inside what is already there becomes a hole in it.
            outside = overlap(path, shape, pathops.PathOp.DIFFERENCE, area)
            under = next((c for p, c in reversed(below) if overlap(path, p, pathops.PathOp.INTERSECTION, 0) > area / 2), None)
            if outside < area * 0.02 and under and distinct(color, under):
                shape = combine(shape, path, pathops.PathOp.DIFFERENCE)
                below.append((path, under))
                continue
            shape = combine(shape, path, pathops.PathOp.UNION)
        below.append((path, color))
        areas[color] = areas.get(color, 0) + area
    if shape is None:
        return None, None
    try:
        shape = pathops.simplify(shape)  # closes open contours too
    except pathops.PathOpsError:
        pass
    if shape.area == 0:
        return None, None
    # SVG y grows downwards: flip it, at about the final size so that the slivers dropped are the ones too small
    # to show, then measure the ink that is left.
    _, top, _, bottom = shape.bounds
    rough = HEIGHT / (bottom - top)
    flipped = pathops.Path()
    shape.draw(TransformPen(CubicPen(flipped), (rough, 0, 0, -rough, 0, 0)))
    flipped = without_specks(flipped)
    ink = BoundsPen(None)  # the curves' own extremes, not their control points (Path.bounds)
    flipped.draw(ink)
    left, bottom, right, top = ink.bounds
    scale = min(HEIGHT / (top - bottom), WIDTH / (right - left))
    # Centred on (CENTRE_X, CENTRE_Y), its left and bottom edges on pixel lines so that icons of one size meet the
    # grid the same way.
    x = round((CENTRE_X - (right - left) * scale / 2) / PX) * PX
    y = round((CENTRE_Y - (top - bottom) * scale / 2) / PX) * PX
    placed = pathops.Path()
    flipped.draw(TransformPen(CubicPen(placed), (scale, 0, 0, scale, x - left * scale, y - bottom * scale)))
    placed = grid_fitted(without_specks(placed))
    area = AreaPen()
    placed.draw(area)
    pen = TTGlyphPen(None)
    target = Cu2QuPen(pen, 1.0, reverse_direction=False)
    # TrueType outer contours run clockwise (negative area here).
    placed.draw(ReverseContourPen(target) if area.value > 0 else target)
    return pen.glyph(), main_color(areas)


def ts_map(name, entries):
    rows = "".join(f"\t{json.dumps(key)}: {json.dumps(value)},\n" for key, value in entries.items())
    return f"const {name}: Record<string, string> = {{\n{rows}}};\n"


def main():
    repo = checkout()
    theme_path = theme_json(repo)
    theme = json.loads(theme_path.read_text())
    definitions = theme["iconDefinitions"]
    languages = theme.get("languageIds", {})

    def lowered(entries):
        return {key.lower(): value for key, value in entries.items()}

    file_names = lowered(theme.get("fileNames", {}))
    extensions = lowered(theme.get("fileExtensions", {}))
    for ext, language in LANGUAGE_EXTENSIONS.items():
        if ext not in extensions and language in languages:
            extensions[ext] = languages[language]
    for name, language in LANGUAGE_FILENAMES.items():
        if name not in file_names and language in languages:
            file_names[name] = languages[language]
    folders = lowered(theme.get("folderNames", {}))
    folders_open = lowered(theme.get("folderNamesExpanded", {}))
    defaults = {
        "file": theme["file"],
        "folder": theme["folder"],
        "folderOpen": theme.get("folderExpanded", theme["folder"]),
    }

    referenced = sorted({*defaults.values(), *file_names.values(), *extensions.values(), *folders.values(), *folders_open.values()})
    glyphs, colors, skipped = {}, {}, []
    for icon in referenced:
        definition = definitions.get(icon)
        if not definition or "iconPath" not in definition:
            skipped.append(f"{icon} (no iconPath)")
            continue
        file = (theme_path.parent / definition["iconPath"]).resolve()
        try:
            glyph, color = icon_glyph(file)
        except Exception as error:  # noqa: BLE001 - reported, the icon falls back to the default
            skipped.append(f"{icon} ({type(error).__name__}: {error})")
            continue
        if glyph is None:
            skipped.append(f"{icon} (nothing filled)")
            continue
        glyphs[icon], colors[icon] = glyph, color

    for name in defaults:
        if defaults[name] not in glyphs:
            sys.exit(f"the default {name} icon {defaults[name]} could not be drawn")
    keep = lambda entries: {key: value for key, value in sorted(entries.items()) if value in glyphs}
    file_names, extensions, folders, folders_open = map(keep, (file_names, extensions, folders, folders_open))

    order = sorted(glyphs)
    codepoints = {icon: FIRST + index for index, icon in enumerate(order)}
    names = {icon: f"u{codepoints[icon]:X}" for icon in order}
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder([".notdef", *names.values()])
    fb.setupCharacterMap({codepoints[icon]: names[icon] for icon in order})
    fb.setupGlyf({".notdef": TTGlyphPen(None).glyph(), **{names[icon]: glyphs[icon] for icon in order}})
    fb.setupHorizontalMetrics({".notdef": (ADVANCE, 0), **{names[icon]: (ADVANCE, getattr(glyphs[icon], "xMin", 0)) for icon in order}})
    fb.setupHorizontalHeader(ascent=1020, descent=-300)
    fb.setupOS2(sTypoAscender=1020, sTypoDescender=-300, usWinAscent=1020, usWinDescent=300, xAvgCharWidth=ADVANCE)
    fb.setupPost(isFixedPitch=1)
    fb.setupNameTable({
        "familyName": "Gentle Symbols",
        "styleName": "Regular",
        "copyright": "Icons from Symbols by Miguel Solorio (MIT License), github.com/miguelsolorio/vscode-symbols",
    })
    # The pinned commit's date instead of now, so a rebuild gives the same file.
    fb.font["head"].created = fb.font["head"].modified = timestampFromString("Sun Oct 18 20:45:55 2026")
    fb.save(FONT)

    icons = "".join(f"\t{json.dumps(icon)}: [0x{codepoints[icon]:X}, {json.dumps(colors[icon])}],\n" for icon in order)
    MODULE.write_text(
        "// Generated by fonts/build-symbols-icons.py: do not edit. Regenerate with\n"
        "//   uv run --no-project --with fonttools --with picosvg python fonts/build-symbols-icons.py [vscode-symbols checkout]\n"
        "//\n"
        f"// Miguel Solorio's Symbols icon theme for VS Code ({REPO} at {PIN[:7]}, MIT License, see\n"
        "// fonts/LICENSE-vscode-symbols): each icon is one glyph of fonts/GentleSymbols.ttf (\"Gentle Symbols\", private\n"
        f"// use from U+{FIRST:X}, one cell wide), to paint in the icon's color. symbolIcon() picks a row's icon as VS Code\n"
        "// does: the file name, then its longest extension, then the default file icon; folders by name.\n"
        "// @ts-nocheck\n\n"
        "export interface SymbolIcon {\n\tchar: string;\n\tcolor: string;\n}\n\n"
        f"// Icon id -> [codepoint, color].\nconst ICONS: Record<string, [number, string]> = {{\n{icons}}};\n\n"
        "// Lowercase name or extension -> icon id.\n"
        + ts_map("FILE_NAMES", file_names) + "\n"
        + ts_map("EXTENSIONS", extensions) + "\n"
        + ts_map("FOLDER_NAMES", folders) + "\n"
        + ts_map("FOLDER_NAMES_OPEN", folders_open) + "\n"
        + "const icon = (id: string): SymbolIcon => ({ char: String.fromCodePoint(ICONS[id][0]), color: ICONS[id][1] });\n"
        "const icons = (ids: Record<string, string>): Record<string, SymbolIcon> => Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, icon(id)]));\n\n"
        f"export const file = icon({json.dumps(defaults['file'])});\n"
        f"export const folder = icon({json.dumps(defaults['folder'])});\n"
        f"export const folderOpen = icon({json.dumps(defaults['folderOpen'])});\n"
        "export const byFileName = icons(FILE_NAMES);\n"
        "export const byExtension = icons(EXTENSIONS);\n"
        "export const byFolderName = icons(FOLDER_NAMES);\n"
        "export const byFolderNameOpen = icons(FOLDER_NAMES_OPEN);\n\n"
        "/** The Symbols icon of a file or folder named `name` (no path): exact name, longest extension, default. */\n"
        "export function symbolIcon(name: string, { isDirectory = false, open = false } = {}): SymbolIcon {\n"
        "\tconst lower = String(name).toLowerCase();\n"
        "\tif (isDirectory) return (open && byFolderNameOpen[lower]) || byFolderName[lower] || (open ? folderOpen : folder);\n"
        "\tif (byFileName[lower]) return byFileName[lower];\n"
        "\t// \"a.test.ts\" tries \"test.ts\", then \"ts\"; \".eslintrc.json\" tries \"eslintrc.json\", then \"json\".\n"
        "\tfor (let dot = lower.indexOf(\".\"); dot >= 0; dot = lower.indexOf(\".\", dot + 1)) {\n"
        "\t\tconst found = byExtension[lower.slice(dot + 1)];\n"
        "\t\tif (found) return found;\n"
        "\t}\n"
        "\treturn file;\n"
        "}\n"
    )
    print(f"vscode-symbols {PIN} ({theme_path.relative_to(repo)})")
    print(f"{len(referenced)} icons referenced, {len(glyphs)} glyphs (U+{FIRST:X}..U+{FIRST + len(glyphs) - 1:X})")
    print(f"maps: {len(file_names)} file names, {len(extensions)} extensions, {len(folders)} folder names, {len(folders_open)} open folder names")
    for line in skipped:
        print(f"skipped {line}")
    print(f"wrote {FONT.relative_to(ROOT)} and {MODULE.relative_to(ROOT)}")


main()
