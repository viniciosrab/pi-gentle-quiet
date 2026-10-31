# Writes extensions/sidebar/nerd-icons.ts: the file icons Neo-tree draws in LazyVim, which is what
# omarchy-launch-editor opens. LazyVim does not install nvim-web-devicons: it mocks it with mini.icons
# (https://github.com/nvim-mini/mini.icons, MIT License, fonts/LICENSE-mini-icons), so Neo-tree's file icons are
# mini.icons' glyphs and highlight groups. This script asks mini.icons itself, in a headless Neovim, for the icon of
# every file name and extension it or Neovim's filetype detection knows, and keeps the ones the module needs.
#
# Pinned sources:
#   mini.icons 98faae31e9be1cc054ae63485e58ceb185efcad0, set up with LazyVim c10948c's options (LAZYVIM_OPTS below).
#   Neovim's runtime lua/vim/filetype.lua (the file names and extensions its filetype detection knows), from the
#   nvim on PATH (0.12.6 when generated).
#
# The module resolves a name as mini.icons' 'file' category does: the exact file name (case-sensitive), then the
# extension after the first dot that is not the leading one (lowercased; "a.test.ts" tries "test.ts", then "ts"),
# then the default file icon. Names Neovim matches only by a filetype pattern are kept only when listed below.
# A file name is listed only when its icon differs from what its extension gives. Colors are mini.icons' nine
# highlight groups (MiniIconsAzure, ...), named by hue; the module paints them with Pi theme roles.
# Every glyph is checked present in JetBrainsMono Nerd Font's cmap; the module lists the codepoints it checked.
#
# Run: uv run --no-project --with fonttools==4.68.0 python fonts/build-nerd-icons.py \
#        [mini.icons checkout] [JetBrainsMonoNerdFont-Regular.ttf]
# The checkout defaults to the user's LazyVim one, ~/.local/share/nvim/lazy/mini.icons; it must be at the pin.
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from fontTools.ttLib import TTFont

PIN = "98faae31e9be1cc054ae63485e58ceb185efcad0"
CHECKOUT = Path.home() / ".local/share/nvim/lazy/mini.icons"
FONT = "/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Regular.ttf"
ROOT = Path(__file__).resolve().parent.parent
MODULE = ROOT / "extensions" / "sidebar" / "nerd-icons.ts"
# LazyVim's opts for mini.icons (lua/lazyvim/plugins/ui.lua at c10948c50b18fae7f256433afdef09e432410480).
LAZYVIM_OPTS = """{
  file = {
    ['.keep'] = { glyph = '\\u{F02A2}', hl = 'MiniIconsGrey' },
    ['devcontainer.json'] = { glyph = '\\u{F4B7}', hl = 'MiniIconsAzure' },
  },
  filetype = { dotenv = { glyph = '\\u{EB52}', hl = 'MiniIconsYellow' } },
}"""
HUES = ["azure", "blue", "cyan", "green", "grey", "orange", "purple", "red", "yellow"]
# Names the build checks resolve here as mini.icons resolves them; they are also asked for, with names Neovim matches
# only by a pattern, so a name such as Makefile keeps its icon.
SAMPLES = ["package.json", "README.md", "readme.md", "Dockerfile", "Makefile", "LICENSE", ".gitignore", ".bashrc", ".env",
           "tsconfig.json", "index.ts", "tree.test.ts", "env.d.ts", "app.tsx", "main.go", "Cargo.toml", "lib.rs", "a.py",
           "notes.md", "data.json", "style.css", "backup.tar.gz", "photo.PNG", "notes.zzzunknown", "x", ".keep",
           "devcontainer.json", "init.lua", "flake.nix", "go.mod", "yarn.lock", "package-lock.json", ".editorconfig"]
PATTERN_NAMES = ["makefile", "GNUmakefile", ".env.local", ".env.example", ".env.development", ".env.production", ".env.test"]

DUMP = r"""
local args = vim.json.decode(table.concat(vim.fn.readfile(_G.gq_input), '\n'))
vim.opt.rtp:prepend(args.checkout)
require('mini.icons').setup(_G.gq_opts)
local function get(category, name)
  local glyph, hl, is_default = MiniIcons.get(category, name)
  return { glyph, hl, is_default }
end
local out = { default = get('default', 'file'), files = {}, extensions = {}, samples = {}, mini_extensions = MiniIcons.list('extension') }
for _, name in ipairs(vim.list_extend(MiniIcons.list('file'), args.names)) do out.files[name] = get('file', name) end
for _, ext in ipairs(vim.list_extend(MiniIcons.list('extension'), args.extensions)) do out.extensions[ext:lower()] = get('extension', ext) end
for _, name in ipairs(args.samples) do out.samples[name] = get('file', name) end
vim.fn.writefile({ vim.json.encode(out) }, args.output)
"""


def vim_runtime():
    script = "lua io.stdout:write(vim.env.VIMRUNTIME)"
    return Path(subprocess.run(["nvim", "--clean", "--headless", "-c", script, "-c", "qa!"], capture_output=True, text=True, check=True).stdout.strip())


def filetype_keys(source, table):
    """The keys of `local <table> = { ... }` in Neovim's lua/vim/filetype.lua."""
    body = re.search(rf"^local {table} = \{{\n(.*?)^\}}", source, re.S | re.M)
    if not body:
        sys.exit(f"no `local {table}` table in filetype.lua")
    keys = []
    for line in body.group(1).splitlines():
        found = re.match(r"\s+(?:\[(['\"])(.+?)\1\]|([A-Za-z_][\w]*))\s*=", line)
        if found:
            keys.append(found.group(2) or found.group(3))
    return keys


def ask_mini_icons(checkout, names, extensions):
    with tempfile.TemporaryDirectory() as scratch:
        scratch = Path(scratch)
        output = scratch / "out.json"
        (scratch / "in.json").write_text(json.dumps({"checkout": str(checkout), "names": names, "extensions": extensions, "samples": SAMPLES, "output": str(output)}))
        (scratch / "dump.lua").write_text(f"_G.gq_input = {json.dumps(str(scratch / 'in.json'))}\n_G.gq_opts = {LAZYVIM_OPTS}\n{DUMP}")
        subprocess.run(["nvim", "--clean", "--headless", "-c", f"luafile {scratch / 'dump.lua'}", "-c", "qa!"], check=True,
                       env={"PATH": "/usr/bin:/bin", "HOME": str(scratch), "XDG_STATE_HOME": str(scratch), "XDG_DATA_HOME": str(scratch)})
        return json.loads(output.read_text())


def hue(hl):
    name = hl.removeprefix("MiniIcons").lower()
    if name not in HUES:
        sys.exit(f"unexpected highlight group {hl}")
    return name


def resolve(name, files, extensions, default):
    """mini.icons' 'file' lookup as the module does it."""
    if name in files:
        return files[name]
    dot = name.find(".", 1)
    if dot >= 0 and dot + 1 < len(name):
        ext = name[dot + 1 :].lower()
        while True:
            if ext in extensions:
                return extensions[ext]
            nxt = ext.find(".")
            if nxt < 0:
                break
            ext = ext[nxt + 1 :]
    return default


def grouped(entries):
    """(glyph, hue) -> the keys drawn with it, in a stable order."""
    groups = {}
    for key, icon in sorted(entries.items()):
        groups.setdefault(icon, []).append(key)
    return sorted(groups.items(), key=lambda item: (ord(item[0][0]), item[0][1]))


def ts_rows(groups):
    rows = []
    for (glyph, color), keys in groups:
        for key in keys:
            if " " in key or '"' in key or "\\" in key:
                sys.exit(f"cannot list {key!r}")
        rows.append(f'\t[0x{ord(glyph):X}, "{color}", "{" ".join(keys)}"],')
    return "\n".join(rows)


def main():
    arguments = sys.argv[1:] + [None] * 2
    checkout = Path(arguments[0] or CHECKOUT)
    font = arguments[1] or FONT
    head = subprocess.run(["git", "-C", str(checkout), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    if head != PIN:
        sys.exit(f"{checkout} is at {head}, not at the pin {PIN}")
    source = (vim_runtime() / "lua" / "vim" / "filetype.lua").read_text()
    dump = ask_mini_icons(checkout, filetype_keys(source, "filename") + SAMPLES + PATTERN_NAMES, filetype_keys(source, "extension"))

    icon = lambda entry: (entry[0], hue(entry[1]))
    default = icon(dump["default"])
    extensions = {ext: icon(entry) for ext, entry in dump["extensions"].items() if not entry[2]}
    # A compound extension mini.icons lists is kept when its own icon differs from its last part's.
    extensions = {ext: found for ext, found in extensions.items() if "." not in ext or resolve("a." + ext.split(".", 1)[1], {}, extensions, default) != found}
    files = {}
    for name, entry in dump["files"].items():
        if entry[2]:
            continue
        found = icon(entry)
        if resolve(name, {}, extensions, default) != found:
            files[name] = found

    mismatches = [name for name, entry in dump["samples"].items() if resolve(name, files, extensions, default) != icon(entry)]
    if mismatches:
        sys.exit(f"resolved differently from mini.icons: {mismatches}")

    cmap = TTFont(font).getBestCmap()
    used = {default[0], *(glyph for glyph, _ in files.values()), *(glyph for glyph, _ in extensions.values())}
    for glyph in used:
        if len(glyph) != 1:
            sys.exit(f"{glyph!r} is not one codepoint")
    missing = sorted(f"U+{ord(glyph):X}" for glyph in used if ord(glyph) not in cmap)
    if missing:
        sys.exit(f"not in {font}: {missing}")
    names = TTFont(font)["name"]
    family, version = names.getDebugName(4), names.getDebugName(5)
    # Neo-tree's own folder icons (defaults.lua at 47a8e3e): closed, open, empty, empty and open.
    folders = [0xE5FF, 0xE5FE, 0xF0256, 0xF0DCF]
    for code in folders:
        if code not in cmap:
            sys.exit(f"folder glyph U+{code:X} not in {font}")
    codes = sorted({ord(glyph) for glyph in used} | set(folders))

    MODULE.write_text(
        "// Generated by fonts/build-nerd-icons.py: do not edit. Regenerate with\n"
        "//   uv run --no-project --with fonttools==4.68.0 python fonts/build-nerd-icons.py [mini.icons checkout] [font]\n"
        "//\n"
        f"// The file icons Neo-tree draws in LazyVim: mini.icons (https://github.com/nvim-mini/mini.icons at {PIN[:7]}, MIT\n"
        "// License, see fonts/LICENSE-mini-icons; LazyVim mocks nvim-web-devicons with it) with LazyVim's options, read from\n"
        "// mini.icons itself in a headless Neovim. nerdIcon() resolves a name as mini.icons does: the exact file name\n"
        "// (case-sensitive), then the extension after the first dot that is not the leading one, longest first\n"
        "// (\"a.test.ts\" tries \"test.ts\", then \"ts\"; lowercased), then the default file icon. Folders draw Neo-tree's own\n"
        "// folder icons (closed, open, empty). Glyphs are one cell of the terminal's Nerd Font, at its own size.\n"
        "// The color is a Pi theme role: mini.icons' highlight groups link to the colorscheme's (MiniIconsAzure to\n"
        "// Function, MiniIconsRed to DiagnosticError, ...), so they are painted with the closest roles of Pi's theme\n"
        "// (HUE_ROLES); folders with Neo-tree's Directory color, Pi's accent.\n"
        "// @ts-nocheck\n"
        "\n"
        "export interface NerdIcon {\n"
        "\tchar: string;\n"
        "\t/** A Pi theme role, for host.fg. */\n"
        "\tcolor: string;\n"
        "}\n"
        "\n"
        "export type Hue = " + " | ".join(f'"{name}"' for name in HUES) + ";\n"
        "\n"
        "// mini.icons' highlight groups (what each links to in mini.icons) as Pi theme roles.\n"
        "export const HUE_ROLES: Record<Hue, string> = {\n"
        '\tazure: "syntaxFunction", // Function\n'
        '\tblue: "mdLink", // DiagnosticInfo\n'
        '\tcyan: "mdCode", // DiagnosticHint\n'
        '\tgreen: "success", // DiagnosticOk\n'
        '\tgrey: "text", // no color: Normal\n'
        '\torange: "warning", // DiagnosticWarn\n'
        '\tpurple: "syntaxNumber", // Constant\n'
        '\tred: "error", // DiagnosticError\n'
        '\tyellow: "warning", // DiagnosticWarn\n'
        "};\n"
        "// Neo-tree's NeoTreeDirectoryIcon links to Directory, the colorscheme's blue: Pi's accent.\n"
        'export const FOLDER_ROLE = "accent";\n'
        "\n"
        f"// Every codepoint drawn, each one checked present in {family} {version.split(';')[0]}'s cmap.\n"
        "export const GLYPHS: number[] = [\n" + "".join(f"\t{', '.join(f'0x{code:X}' for code in codes[at:at + 12])},\n" for at in range(0, len(codes), 12)) + "];\n"
        "\n"
        "// [codepoint, hue, file names drawn with it] for names whose icon differs from their extension's.\n"
        "const FILE_NAMES: [number, Hue, string][] = [\n" + ts_rows(grouped(files)) + "\n];\n"
        "\n"
        "// [codepoint, hue, extensions drawn with it], lowercase, without the leading dot.\n"
        "const EXTENSIONS: [number, Hue, string][] = [\n" + ts_rows(grouped(extensions)) + "\n];\n"
        "\n"
        "const icon = (code: number, color: string): NerdIcon => ({ char: String.fromCodePoint(code), color });\n"
        "const index = (rows: [number, Hue, string][]) => {\n"
        "\tconst found: Record<string, NerdIcon> = {};\n"
        "\tfor (const [code, hue, keys] of rows) {\n"
        "\t\tconst made = icon(code, HUE_ROLES[hue]);\n"
        "\t\tfor (const key of keys.split(\" \")) found[key] = made;\n"
        "\t}\n"
        "\treturn found;\n"
        "};\n"
        "\n"
        f'export const file = icon(0x{ord(default[0]):X}, HUE_ROLES["{default[1]}"]);\n'
        "export const folder = icon(0xE5FF, FOLDER_ROLE);\n"
        "export const folderOpen = icon(0xE5FE, FOLDER_ROLE);\n"
        "export const folderEmpty = icon(0xF0256, FOLDER_ROLE);\n"
        "export const folderEmptyOpen = icon(0xF0DCF, FOLDER_ROLE);\n"
        "export const byFileName = index(FILE_NAMES);\n"
        "export const byExtension = index(EXTENSIONS);\n"
        "\n"
        "/** The icon of a file or folder named `name` (no path), as Neo-tree draws it in LazyVim. */\n"
        "export function nerdIcon(name: string, { isDirectory = false, open = false, empty = false } = {}): NerdIcon {\n"
        "\tif (isDirectory) return empty ? (open ? folderEmptyOpen : folderEmpty) : open ? folderOpen : folder;\n"
        "\tname = String(name);\n"
        "\tif (Object.hasOwn(byFileName, name)) return byFileName[name];\n"
        "\t// The extension starts after the first dot that is not the name's first character.\n"
        "\tconst dot = name.indexOf(\".\", 1);\n"
        "\tif (dot < 0) return file;\n"
        "\tfor (let ext = name.slice(dot + 1).toLowerCase(); ext; ext = ext.includes(\".\") ? ext.slice(ext.indexOf(\".\") + 1) : \"\") {\n"
        "\t\tif (Object.hasOwn(byExtension, ext)) return byExtension[ext];\n"
        "\t}\n"
        "\treturn file;\n"
        "}\n"
    )
    print(f"{len(files)} file names, {len(extensions)} extensions, {len(codes)} glyphs checked in {family} {version.split(';')[0]}")


if __name__ == "__main__":
    main()
