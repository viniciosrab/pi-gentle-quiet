# pi-gentle-quiet

A quiet, Pi-native look for [gentle-pi](https://github.com/Gentleman-Programming/gentle-shell) and
[gentle-engram](https://github.com/Gentleman-Programming/engram). The Gentle AI workflow stays the
same; only how it is drawn changes.

## What you get

- **Quiet tool calls.** Each call is one row with a one-line result. Press `ctrl+o` to see the full output.
- **One status line** with your folder, branch, changed lines, context, cost and plan usage.
- **A side column on wide terminals** (fullscreen, 140 columns or more by default) with tabs:

  | Tab | Shows |
  |---|---|
  | **MAIN** | Status, context and plan usage, background jobs, todos, and a music player for [cliamp](https://github.com/bjarneo/cliamp) |
  | **GIT** | Branches and changed files; click a file to see its diff |
  | **PROF** | gentle-pi profiles: pick models and effort per agent |
  | **MEM** | Engram memories saved and recalled in this session |
  | **TREE** | The project tree; click a file for a read-only preview |
  | **PR** | Open pull requests with their CI, reviews and threads |

- **Live subagents and jobs.** Click a row marked `↗` in the Agents or Jobs card to follow its work as it happens.
- **A `❯` prompt**, image paste with `ctrl+v`, and Gentle Shell's `alt+k` command menu.

Narrower terminals keep the status line and quiet rows, without the side column.

## Install

```sh
pi install git:github.com/viniciosrab/pi-gentle-quiet
```

Then turn off gentle-pi's own visual extensions in `~/.pi/agent/settings.json`, so the two looks do not
overlap:

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

Restart Pi. Two things to keep in mind:

- Keep Pi's built-in `codemode` enabled, or MCP tools become unreachable.
- List `pi-gentle-quiet` before `npm:gentle-pi` in `packages`, so subagent results use the quiet row.

## Configure

Run `/gentle-quiet`. Use `←` `→` or `Tab` to switch tabs, `↑` `↓` to pick an option and `Enter` to change it.
Changes apply right away.

| Want to… | Go to |
|---|---|
| Hide the cost, tokens, changed lines or plan usage | **Status** |
| Use your theme's colors instead of grey tool rows | **Tools** → Tool call tones |
| Turn off the side column | **Blocks** → Side column |
| Show the side column on narrower or only wider terminals | **Blocks** → Side column from |
| Reorder the tabs | **Blocks** → Tab order, or drag a tab in the bar |
| Use Nerd Font icons in TREE | **Blocks** → Tree icons |
| Change the icons or the `❯` prompt | **Icons**, **Prompt** |

## Shortcuts

| Key | Does |
|---|---|
| `ctrl+o` | Expand the full output of tool calls |
| `alt+k` | Gentle Shell's command menu (models, profiles, persona, review mode, doctor…) |
| `alt+p` | Open the PROF tab with the keyboard |
| `ctrl+shift+j` | Collapse or expand the Jobs card |
| `ctrl+v` | Paste an image from the clipboard |

Set `GENTLE_PI_COMMANDS_KEY` or `GENTLE_PI_JOBS_KEY` (or gentle-pi's `keymaps.json`) to move
the `alt+k` or `ctrl+shift+j` shortcut, or to `off` to disable it.

## Good to know

- Turning off `gentle-shell.ts` also removes `/gentle:changes`, `/gentle:usage` and `/gentle:customize`.
- Some icons need extra fonts. If you see a blank box, pick another icon in `/gentle-quiet` → **Icons**,
  or install the bundled font: `cp fonts/GentleIcons.ttf ~/.local/share/fonts/ && fc-cache -f`, then
  reopen the terminal.
- If a future gentle-pi or gentle-engram changes what it draws, the affected part falls back to its
  original look. Pi keeps working.

Every detail, including every setting and how to read each part of the status line, is in the
[feature reference](docs/features.md).

## Development

```sh
npm test
```
