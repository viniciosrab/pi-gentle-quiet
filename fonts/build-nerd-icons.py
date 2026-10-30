# Writes extensions/sidebar/nerd-icons.ts: Miguel Solorio's Symbols file icon theme for VS Code
# (https://github.com/miguelsolorio/vscode-symbols, MIT License, fonts/LICENSE-vscode-symbols) drawn with the Nerd
# Font glyphs the terminal font already has. Symbols' file name, extension and folder name maps pick the icon and
# its color; GLYPH below names the Nerd Font glyph that stands for each icon.
#
# Pinned sources:
#   vscode-symbols 2c95b15b0a8ef95ac62855e3784a6024ee6e5d2e (v0.0.25): the maps and the icons' SVGs (for the colors).
#   nerd-fonts v3.5.1 (b894ea7803af6aade63d60a4381e006098ec9c4d) glyphnames.json: glyph name -> codepoint.
#   nvim-web-devicons ec309a0eaff6ea967e58c275996155ab5c16938d (MIT): the reference for which glyph means which file
#   type; nothing is read from it.
#
# The glyphs: seti (and devicons where seti has none) for languages and tools, codicons (VS Code's own icon font) for
# generic things (a page, a folder, a lock, a book), all one cell wide and thin. Folders keep Symbols' color and draw
# codicons' closed or open folder; their badges have no Nerd Font counterpart. An icon with no fitting glyph (None
# below) draws the generic file glyph in its own color. The color is the one painting the largest area of the
# icon's SVG, a grey only when nothing else is painted (a folder's colored badge gives the folder its color).
# Every glyph is checked present in JetBrainsMono Nerd Font's cmap; the module lists the codepoints it checked.
#
# Run: uv run --no-project --with fonttools --with picosvg python fonts/build-nerd-icons.py \
#        [vscode-symbols checkout] [glyphnames.json] [JetBrainsMonoNerdFont-Regular.ttf]
# With no checkout or glyphnames.json, the pinned ones are fetched into a temporary directory.
import json
import re
import subprocess
import sys
import tempfile
import urllib.request
from copy import deepcopy
from pathlib import Path

import pathops
from fontTools.ttLib import TTFont
from lxml import etree
from picosvg.svg import SVG
from picosvg.svg_pathops import skia_path, svg_commands
from picosvg.svg_types import SVGPath

REPO = "https://github.com/miguelsolorio/vscode-symbols"
PIN = "2c95b15b0a8ef95ac62855e3784a6024ee6e5d2e"
NERD_TAG = "v3.5.1"
GLYPHNAMES = f"https://raw.githubusercontent.com/ryanoasis/nerd-fonts/{NERD_TAG}/glyphnames.json"
FONT = "/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Regular.ttf"
ROOT = Path(__file__).resolve().parent.parent
MODULE = ROOT / "extensions" / "sidebar" / "nerd-icons.ts"

FILE = "cod-file"
FOLDER = "cod-folder"
FOLDER_OPEN = "cod-folder_opened"

# Symbols icon id -> Nerd Font glyph name (nerd-fonts glyphnames.json), or None for the generic file glyph.
GLYPH = {
    "angular": "dev-angular", "angular-component": "dev-angular", "angular-directive": "dev-angular",
    "angular-guard": "dev-angular", "angular-module": "dev-angular", "angular-pipe": "dev-angular",
    "angular-service": "dev-angular", "animate": None, "astro": "custom-astro", "audio": "seti-audio",
    "babel": "seti-babel", "biome": "dev-biome", "brackets-blue": "seti-json", "brackets-orange": "seti-json",
    "brackets-purple": "seti-json", "brackets-sky": "seti-json", "brackets-yellow": "seti-json",
    "browserslist": None, "bruno": None, "bun": "dev-bun", "c": "seti-c", "caddy": None,
    "capacitor": "dev-capacitor", "clapper": "seti-godot", "claude": "cod-claude", "clojure": "seti-clojure",
    "cloudflare-workers": "dev-cloudflareworkers", "cmake": "dev-cmake", "code-blue": "seti-html",
    "code-green": "seti-html", "code-orange": "seti-html", "coldfusion": "seti-coldfusion",
    "compressed": "seti-zip", "contentlayer": None, "cplus": "seti-cpp", "crystal": "seti-crystal",
    "csharp": "seti-c_sharp", "csv": "seti-csv", "cucumber": "dev-cucumber", "cuda": "seti-cu", "cursor": None,
    "cypress": "dev-cypressio", "dart": "seti-dart", "database": "seti-db", "deno": "dev-denojs",
    "docker": "seti-docker", "docker-green": "seti-docker", "docker-pink": "seti-docker", "document": None,
    "docusaurus": None, "drawio": None, "drizzle": None, "dts": "seti-typescript", "dune": "seti-ocaml",
    "earthfile": None, "editorconfig": "seti-editorconfig", "elixir": "seti-elixir", "erlang": "dev-erlang",
    "eslint": "seti-eslint", "exe": "cod-window", "expressive-code": None, "firebase": "seti-firebase",
    "font": "seti-font", "fortran": "dev-fortran", "fresh": None, "fsharp": "seti-f_sharp", "func": None,
    "gatsby": "dev-gatsby", "gdextension": "seti-godot", "gdignore": "seti-godot", "gdproject": "seti-godot",
    "gdscript": "seti-godot", "gdshader": "seti-godot", "gear": "seti-config", "gif": "seti-image",
    "git": "seti-git", "gitlab": "seti-gitlab", "gleam": "dev-gleam", "globe": "cod-globe", "go": "seti-go", "go-mod": "seti-go",
    "gradle": "seti-gradle", "graphql": "seti-graphql", "gulp": "seti-gulp", "h": "seti-c", "haml": "seti-haml",
    "haskell": "seti-haskell", "http": "cod-globe", "hugo": "dev-hugo", "i18n": "md-translate",
    "ignore": "seti-ignored", "illustrator": "seti-illustrator", "image": "seti-image", "ionic": "seti-ionic",
    "java": "seti-java", "java-class": "seti-java", "jenkins": "seti-jenkins", "jest": "dev-jest",
    "js": "seti-javascript", "js-test": "seti-javascript", "julia": "seti-julia", "keystatic": None, "knip": None,
    "kotlin": "seti-kotlin", "kubb": None, "laravel": "dev-laravel", "license": "md-copyright", "link": "cod-link",
    "liquid": "seti-liquid", "lock": "cod-lock", "lua": "seti-lua", "luau": "seti-lua", "lunaria": None,
    "markdoc": "dev-markdown", "markdown": "dev-markdown", "maven": "seti-maven", "mdx": "dev-markdown",
    "minecraft": None, "mongo": "dev-mongodb", "moon": None, "nest": "dev-nestjs", "netlify": "dev-netlify",
    "next": "dev-nextjs", "nim": "seti-nim", "nix": "linux-nixos", "node": "md-nodejs",
    "nodemon": "dev-nodemon", "notebook": "seti-notebook", "npm": "seti-npm", "nunjucks": "seti-nunjucks",
    "nuxt": "dev-nuxtjs", "nx": None, "ocaml": "seti-ocaml", "orval": None, "oxc": None, "panda": None,
    "patch": "cod-diff", "pdf": "seti-pdf", "perl": "seti-perl", "photoshop": "seti-photoshop", "php": "seti-php",
    "pkl": None, "pnpm": "dev-pnpm", "postcss": "dev-postcss", "prettier": "custom-prettier", "prisma": "seti-prisma",
    "proto": None, "pug": "seti-pug", "pulumi": "dev-pulumi", "puppeteer": "dev-puppeteer",
    "puzzle": "cod-extensions", "python": "seti-python", "r": "seti-r", "razor": "dev-blazor", "react": "seti-react",
    "react-test": "seti-react", "react-ts": "seti-react", "readme": "cod-book", "redux-actions": "dev-redux",
    "redux-effects": "dev-redux", "redux-facade": "dev-redux", "redux-reducer": "dev-redux",
    "redux-selector": "dev-redux", "renovate": None, "rescript": "seti-rescript",
    "rescript-interface": "seti-rescript", "resource": "cod-package", "rolldown": None, "rome": None,
    "rsbuild": None, "rslib": None, "rspack": None, "ruby": "seti-ruby", "rust": "seti-rust", "sanity": "dev-sanity",
    "sass": "seti-sass", "sbt": "seti-sbt", "scala": "seti-scala", "severless": None, "shadcn": None,
    "shell": "cod-terminal", "slint": None, "solidity": "dev-solidity", "statamic-antlers": None,
    "storybook": "dev-storybook", "stylelint": "seti-stylelint", "stylus": "seti-stylus", "svelte": "seti-svelte",
    "svelte-service": "seti-svelte", "svelte-ts": "seti-svelte", "svg": "seti-svg", "svx": "seti-svelte",
    "swc": None, "swift": "seti-swift", "tailwind": "dev-tailwindcss", "taskfile": "cod-tasklist", "tauri": "dev-tauri",
    "terraform": "seti-terraform", "tex": "seti-tex", "text": "seti-text", "ts": "seti-typescript",
    "ts-test": "seti-typescript", "ts-types": "seti-typescript", "tsconfig": "seti-tsconfig",
    "turborepo": "dev-turbo", "twig": "seti-twig", "typst": None, "unity-asmdef": "dev-unity",
    "unity-asmref": "dev-unity", "unity-asset": "dev-unity", "unity-meta": "dev-unity",
    "unity-package": "dev-unity", "unity-prefab": "dev-unity", "unity-scene": "dev-unity",
    "unity-shader": "dev-unity", "unocss": None, "uv": None, "v": "custom-v_lang", "vanilla-extract": None,
    "vercel": "dev-vercel", "video": "seti-video", "visual-studio": "dev-visualstudio", "vite": "dev-vitejs",
    "vitest": "dev-vitest", "vue": "seti-vue", "webgpu": "dev-webgpu", "webpack": "seti-webpack", "xml": "seti-xml",
    "yaml": "dev-yaml", "yarn": "seti-yarn", "yummacss": None, "zig": "seti-zig",
}

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


def pinned_checkout(argument):
    if argument:
        repo = Path(argument)
        head = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        if head != PIN:
            sys.exit(f"{repo} is at {head or 'no commit'}, not the pinned {PIN}")
        return repo
    repo = Path(tempfile.mkdtemp()) / "vscode-symbols"
    subprocess.run(["git", "clone", "-q", REPO, repo], check=True)
    subprocess.run(["git", "-C", repo, "checkout", "-q", PIN], check=True)
    return repo


def glyph_names(argument):
    if argument:
        names = json.loads(Path(argument).read_text())
    else:
        with urllib.request.urlopen(GLYPHNAMES) as response:
            names = json.loads(response.read())
    version = names["METADATA"]["version"]
    if f"v{version}" != NERD_TAG:
        sys.exit(f"glyphnames.json is for nerd-fonts {version}, not the pinned {NERD_TAG}")
    return {name: int(entry["code"], 16) for name, entry in names.items() if name != "METADATA"}


def theme_json(repo):
    contribution = json.loads((repo / "package.json").read_text())["contributes"]["iconThemes"][0]["path"]
    path = repo / contribution
    # The extension writes symbol-icon-theme.modified.json from the user's settings at run time.
    return path if path.exists() else repo / contribution.replace(".modified", "")


# The icons' colors, from their SVGs: the color painting the largest area.

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


def combine(shape, path, operation):
    try:
        return pathops.op(shape, path, operation)
    except pathops.PathOpsError:
        pass
    if operation == pathops.PathOp.INTERSECTION:
        return pathops.Path()
    merged = pathops.simplify(shape, clockwise=True)
    merged.addPath(pathops.simplify(path, clockwise=operation == pathops.PathOp.UNION))
    return merged


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


def icon_color(file):
    areas = {}
    for _, color, area in painted(prepared(file).topicosvg()):
        areas[color] = areas.get(color, 0) + area
    if not areas:
        return None
    colored = {color: area for color, area in areas.items() if not grey(color)}
    return max(colored or areas, key=(colored or areas).get)


def grouped(entries):
    """{key: icon} as {icon: "key key ..."}, keys sorted."""
    groups = {}
    for key, icon in sorted(entries.items()):
        groups.setdefault(icon, []).append(key)
    return {icon: " ".join(keys) for icon, keys in groups.items()}


def main():
    arguments = sys.argv[1:] + [None] * 3
    repo, codepoints, font = pinned_checkout(arguments[0]), glyph_names(arguments[1]), arguments[2] or FONT
    cmap = TTFont(font).getBestCmap()
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
    defaults = {"file": theme["file"], "folder": theme["folder"], "folderOpen": theme.get("folderExpanded", theme["folder"])}

    referenced = sorted({*defaults.values(), *file_names.values(), *extensions.values(), *folders.values(), *folders_open.values()})
    colors, skipped = {}, []
    for icon in referenced:
        definition = definitions.get(icon)
        if not definition or "iconPath" not in definition:
            skipped.append(f"{icon} (no iconPath)")
            continue
        try:
            color = icon_color((theme_path.parent / definition["iconPath"]).resolve())
        except Exception as error:  # noqa: BLE001 - reported, the icon falls back to the default
            skipped.append(f"{icon} ({type(error).__name__}: {error})")
            continue
        if color is None:
            skipped.append(f"{icon} (nothing filled)")
            continue
        colors[icon] = color
    for name, icon in defaults.items():
        if icon not in colors:
            sys.exit(f"the default {name} icon {icon} has no color")

    file_icons = sorted(icon for icon in colors if not icon.startswith("folder"))
    unmapped = [icon for icon in file_icons if icon not in GLYPH]
    if unmapped:
        sys.exit(f"Symbols icons with no GLYPH entry (add one, None for the generic file glyph): {', '.join(unmapped)}")
    glyph = {icon: GLYPH[icon] or FILE for icon in file_icons}
    used = sorted({FILE, FOLDER, FOLDER_OPEN, *glyph.values()})
    for name in used:
        if name not in codepoints:
            sys.exit(f"{name} is not in nerd-fonts {NERD_TAG} glyphnames.json")
        if codepoints[name] not in cmap:
            sys.exit(f"{name} (U+{codepoints[name]:X}) is not in {font}")
    family = TTFont(font)["name"].getDebugName(4)
    version = TTFont(font)["name"].getDebugName(5)

    keep = lambda entries: {key: value for key, value in entries.items() if value in colors}
    file_names, extensions, folders, folders_open = map(keep, (file_names, extensions, folders, folders_open))
    by_name, by_extension = grouped(file_names), grouped(extensions)
    by_folder, by_folder_open = grouped(folders), grouped(folders_open)

    files = "".join(
        f"\t{json.dumps(icon)}: [{json.dumps(glyph[icon])}, {json.dumps(colors[icon])}, "
        f"{json.dumps(by_name.get(icon, ''))}, {json.dumps(by_extension.get(icon, ''))}],\n"
        for icon in file_icons
        if icon in by_name or icon in by_extension or icon == defaults["file"]
    )
    folder_icons = sorted({*by_folder, *by_folder_open, defaults["folder"], defaults["folderOpen"]})
    folder_rows = "".join(
        f"\t{json.dumps(icon)}: [{json.dumps(colors[icon])}, {json.dumps(by_folder.get(icon, ''))}, {json.dumps(by_folder_open.get(icon, ''))}],\n"
        for icon in folder_icons
    )
    glyph_rows = "".join(f"\t{json.dumps(name)}: 0x{codepoints[name]:X},\n" for name in used)
    MODULE.write_text(
        "// Generated by fonts/build-nerd-icons.py: do not edit. Regenerate with\n"
        "//   uv run --no-project --with fonttools --with picosvg python fonts/build-nerd-icons.py \\\n"
        "//     [vscode-symbols checkout] [glyphnames.json] [JetBrainsMonoNerdFont-Regular.ttf]\n"
        "//\n"
        f"// Miguel Solorio's Symbols icon theme for VS Code ({REPO} at {PIN[:7]}, MIT License, see\n"
        "// fonts/LICENSE-vscode-symbols) drawn with Nerd Font glyphs (nerd-fonts " + NERD_TAG + "): Symbols' maps pick\n"
        "// the icon and its color, the glyph is the Nerd Font icon standing for it (seti and devicons for languages and\n"
        "// tools, codicons for the rest), one cell wide. nerdIcon() picks a row's icon as VS Code does: the file name,\n"
        "// then its longest extension, then the default file icon; folders by name, closed or open.\n"
        "// @ts-nocheck\n\n"
        "export interface NerdIcon {\n\tchar: string;\n\tcolor: string;\n}\n\n"
        f"// Glyph name -> codepoint, each one checked present in {family} {version.split(';')[0]}'s cmap.\n"
        f"export const GLYPHS: Record<string, number> = {{\n{glyph_rows}}};\n\n"
        "// Symbols file icon -> [glyph, color, lowercase file names, lowercase extensions].\n"
        f"const FILES: Record<string, [string, string, string, string]> = {{\n{files}}};\n\n"
        "// Symbols folder icon -> [color, lowercase folder names, lowercase names when open].\n"
        f"const FOLDERS: Record<string, [string, string, string]> = {{\n{folder_rows}}};\n\n"
        "const icon = (glyph: string, color: string): NerdIcon => ({ char: String.fromCodePoint(GLYPHS[glyph]), color });\n"
        "const index = (rows, column: number, make) => {\n"
        "\tconst found: Record<string, NerdIcon> = {};\n"
        "\tfor (const [id, row] of Object.entries(rows)) for (const key of row[column].split(\" \").filter(Boolean)) found[key] = make(id, row);\n"
        "\treturn found;\n"
        "};\n"
        "const fileIcon = (_id: string, [glyph, color]) => icon(glyph, color);\n\n"
        f"export const file = fileIcon(\"\", FILES[{json.dumps(defaults['file'])}]);\n"
        f"export const folder = icon({json.dumps(FOLDER)}, FOLDERS[{json.dumps(defaults['folder'])}][0]);\n"
        f"export const folderOpen = icon({json.dumps(FOLDER_OPEN)}, FOLDERS[{json.dumps(defaults['folderOpen'])}][0]);\n"
        "export const byFileName = index(FILES, 2, fileIcon);\n"
        "export const byExtension = index(FILES, 3, fileIcon);\n"
        f"export const byFolderName = index(FOLDERS, 1, (_id, [color]) => icon({json.dumps(FOLDER)}, color));\n"
        f"export const byFolderNameOpen = {{\n"
        f"\t...index(FOLDERS, 1, (_id, [color]) => icon({json.dumps(FOLDER_OPEN)}, color)),\n"
        f"\t...index(FOLDERS, 2, (_id, [color]) => icon({json.dumps(FOLDER_OPEN)}, color)),\n"
        "};\n\n"
        "/** The icon of a file or folder named `name` (no path): exact name, longest extension, default. */\n"
        "export function nerdIcon(name: string, { isDirectory = false, open = false } = {}): NerdIcon {\n"
        "\tconst lower = String(name).toLowerCase();\n"
        "\tif (isDirectory) return (open ? byFolderNameOpen[lower] || folderOpen : byFolderName[lower] || folder);\n"
        "\tif (byFileName[lower]) return byFileName[lower];\n"
        "\t// \"a.test.ts\" tries \"test.ts\", then \"ts\"; \".eslintrc.json\" tries \"eslintrc.json\", then \"json\".\n"
        "\tfor (let dot = lower.indexOf(\".\"); dot >= 0; dot = lower.indexOf(\".\", dot + 1)) {\n"
        "\t\tconst found = byExtension[lower.slice(dot + 1)];\n"
        "\t\tif (found) return found;\n"
        "\t}\n"
        "\treturn file;\n"
        "}\n"
    )
    fallbacks = sorted(icon for icon in file_icons if GLYPH[icon] is None)
    print(f"vscode-symbols {PIN} ({theme_path.relative_to(repo)}), nerd-fonts {NERD_TAG}, {family} {version}")
    print(f"{len(file_icons)} file icons ({len(file_icons) - len(fallbacks)} mapped, {len(fallbacks)} on the generic file glyph), "
          f"{len(folder_icons)} folder colors, {len(used)} glyphs")
    print(f"maps: {len(file_names)} file names, {len(extensions)} extensions, {len(folders)} folder names, {len(folders_open)} open folder names")
    print(f"fallbacks: {' '.join(fallbacks)}")
    for line in skipped:
        print(f"skipped {line}")
    print(f"wrote {MODULE.relative_to(ROOT)}")


main()
