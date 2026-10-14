# pi-gentle-quiet

A quiet, Pi-native look for [gentle-pi](https://github.com/Gentleman-Programming/gentle-shell) and
[gentle-engram](https://github.com/Gentleman-Programming/engram).

Keep the Gentle AI workflow (ODD, subagents, todo, review, memory) and Pi's own interface. This
extension only changes how things are drawn: execution, tools, and data stay untouched.

```
 ❯ run the tests

 $ npm test
 └ ✓ 42 lines · 3.1s                                 ctrl+o to expand

 󰧑 search "config"
 └ ✓ 3 results

┌──────────────────────────────────────────────────────────────────┐
│ ≡ Todos  1 of 3                                    ctrl+shift+t  │
│ ✓ Write the parser                                               │
│ ◐ Add tests · in progress                                        │
└──────────────────────────────────────────────────────────────────┘
────────────────────────────────────────────────────────────────────
 ❯
 Perm: Normal
```

## What it changes

| Area | Before | After |
|---|---|---|
| Footer | `🧠 project · ✓ 4 results`, `Permissions: YOLO`, `🚀 YOLO ON 🔥 …` | `mem 4 results`, `Perm: Yolo` (theme colors), banner hidden |
| Memory calls | `🧠 search "x" …` | `󰧑 search "x"` drawn like Pi's own tool rows |
| gentle-pi tool rows | `✿todo · write` flush against the edge | ` ≡ todo · write` on Pi's one-column margin |
| Subagent results | Rounded `❀ Agent result` card | ` ◈ gentle-ai-explore · done` + ` └ first line of the answer`; `ctrl+o` shows it all |
| Todos / Agents blocks | Background panel with an accent bar and padding rows | Flat rows in a square outline using the theme's `border` color |
| Pi tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `codemode`) | Boxed output preview | Call row plus a one-line summary; `ctrl+o` shows Pi's full output |
| `codemode` | Script and output | Number of calls and their servers; failed calls listed |
| Prompt | Pi's editor | Pi's editor with a `❯` in front of the input and of sent messages |

## Install

```sh
pi install git:github.com/viniciosrab/pi-gentle-quiet
```

Restart Pi, then run `/gentle-quiet` to configure it.

### Recommended settings

For the full effect, turn off gentle-pi's visual extensions in `pi config` (or in
`~/.pi/agent/settings.json`), keeping the workflow ones:

```json
{
  "source": "npm:gentle-pi",
  "extensions": [
    "-extensions/gentle-shell.ts",
    "-extensions/quiet-tools.ts",
    "-extensions/pi-pretty.ts",
    "-extensions/startup-banner.ts"
  ]
}
```

- Without `quiet-tools.ts`, Pi's built-in `codemode` is the only one: keep it enabled (no
  `"-builtin:codemode"` in the top-level `extensions`), or MCP tools become unreachable.
- Disabling `gentle-shell.ts` also removes `/gentle:changes`, `/gentle:usage`, `/gentle:customize`
  and the `alt+k` palette. The workflow itself is unaffected.
- If you keep `pi-pretty.ts` enabled, turn off **Prompt icon in sent messages** to avoid a double `❯`.

## Configure

`/gentle-quiet` opens a menu; every change applies immediately and is saved to
`<Pi agent dir>/gentle-quiet.json` (normally `~/.pi/agent/gentle-quiet.json`).

| Option | Default |
|---|---|
| Memory in footer / label / project name | on / `mem` / off |
| Permission in footer / label / hidden when normal | on / `Perm` / shown |
| YOLO banner | hidden |
| Icons: memory / todo / agents / other gentle tools | `󰧑` / `≡` / `◈` / `›` |
| Tool row margin | on |
| Quiet tools / preview lines / codemode detail | on / 0 / `failures` |
| Todos/Agents blocks / border | minimal / on |
| Subagent results | minimal (restart to apply) |
| Prompt icon in input / in sent messages / icon | on / on / `❯` |

The memory icon `󰧑` needs a [Nerd Font](https://www.nerdfonts.com/). Without one, pick `⟲` in the menu.

## Limits

- It rewrites what gentle-pi and gentle-engram draw. If a future version changes that output, the
  affected item falls back to its original look; Pi keeps working.
- Mouse clicks on the Todos/Agents header can land one row off; use the keyboard shortcuts.
- Quiet rows expand with `ctrl+o`, not with a click. Toggling quiet tools applies to new calls.
- Pi draws a message type with the first extension that registered it. Local extensions load
  before packages; as a package, list `git:github.com/viniciosrab/pi-gentle-quiet` before
  `npm:gentle-pi` in `packages` so subagent results use the quiet row.
- Switching **Subagent results** back to the original card applies after a restart.

## Development

```sh
npm test
```

Tests run with Node's test runner (Node 22.18+) against stand-ins for Pi's host packages
(`test/stubs/`), so Pi does not need to be installed. They drive the extension through what it
registers with Pi: statuses, widgets, tool renderers, the editor and `/gentle-quiet`.
`test/fixtures/` copies the shapes gentle-pi and gentle-engram draw; when either changes its output,
update the fixture and the affected test together.

## Credits

The prompt icon editor is adapted from [pi-pretty](https://www.npmjs.com/package/@heyhuynhgiabuu/pi-pretty) (MIT).
Built for gentle-pi and gentle-engram by Gentleman Programming (MIT).

## License

MIT
