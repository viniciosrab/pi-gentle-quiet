# pi-gentle-quiet

A quiet, Pi-native look for [gentle-pi](https://github.com/Gentleman-Programming/gentle-shell) and
[gentle-engram](https://github.com/Gentleman-Programming/engram). The Gentle AI workflow stays the
same; only how it is drawn changes.

## What you get

- **Quiet tool rows.** Each call is one row plus a one-line result. `ctrl+o` shows the full output.
- **Flat Todos and Agents cards** in a simple outline, using your theme's colors.
- **Side column on wide terminals.** In a fullscreen Pi with 140+ columns, Todos and Agents move to
  the right and the status line moves to the top. The Todos card shows every task.
- **One status line** with your folder, branch, changed lines, context, cost and plan usage. The
  model and its effort stay at the bottom right above the editor at all times, dimmed: at the end
  of the `Working` row while Pi works, and on that same row when it is idle.
- **A `❯` prompt** and one-row user messages, like Claude Code.
- **Gentle Shell's `alt+k` command menu** (models, profiles, persona, review mode, doctor…), without
  turning Gentle Shell back on.

## Install

```sh
pi install git:github.com/viniciosrab/pi-gentle-quiet
```

Restart Pi, then run `/gentle-quiet` to configure it.

For the full effect, turn off gentle-pi's visual extensions in `~/.pi/agent/settings.json`:

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

- Keep Pi's built-in `codemode` enabled, or MCP tools become unreachable.
- Turning off `gentle-shell.ts` also removes `/gentle:changes`, `/gentle:usage` and `/gentle:customize`.
  The `alt+k` menu stays: pi-gentle-quiet opens it instead. Set `GENTLE_PI_COMMANDS_KEY` to move it, or `off`.
- List `pi-gentle-quiet` before `npm:gentle-pi` in `packages` so subagent results use the quiet row.

## Configure

`/gentle-quiet` opens a tabbed menu: `Status`, `Footer`, `Tools`, `Blocks`, `Icons`, `Prompt` and `Reset`.
Use ←/→ to switch tabs, ↑/↓ to pick an option and enter to change it. Like Pi's own settings, a dim
description under the list says what the selected option controls. Changes apply right away and are
saved to `~/.pi/agent/gentle-quiet.json`.

Common choices:

| Want to… | Go to |
|---|---|
| Hide the cost, tokens, changed lines or plan usage | **Status** |
| Hide the weekly plan usage (`week 31%`), the context tokens (`56k/200k`), the cache timer (`⧗ warm 4m`) or `Perm: Yolo` | **Status** → Status line weekly usage, Status line context tokens, Status line cache timer, Status line permission |
| Show `sub` for a plan Pi cannot detect (claude-bridge) | **Status** → Subscription |
| Use your theme's colors instead of Claude Code's greys | **Tools** → Tool call tones |
| Turn off the side column | **Blocks** → Side column |
| Change the icons or the `❯` prompt | **Icons**, **Prompt** |

## Reading the status line

- ` main`: the git branch. **Icons** → Branch icon picks another glyph or none.
- `±2 +3 -1`: files and lines changed since the last commit. Updates every 2 seconds, including
  while a subagent works.
- `$1.75`: cost of the session, **including its subagents**, each priced by its own model.
  On subscriptions that report $0 (claude-bridge), it is an estimate at Anthropic API prices, not a charge.
- `ctx 󰪟 28% 56k/200k`: how full the context window is, then the tokens in use out of the window
  (`?` right after a compaction). The ring fills in eighths and turns yellow at 80%, red at 95%.
  **Status** → Status line context tokens off keeps only the percent.
- `⧗ warm 4m` / `⧗ expiring 1m` / `⧗ cold`: the prompt cache, like Collie's chip. Warm (green hourglass)
  counts down the minutes left from the last response that read the cache; expiring (red) is the last
  quarter of the TTL, at least a minute; cold (accent) is past the TTL, or right after a response that
  wrote the cache without reading it (a miss). Inferred: providers do not report it. **Status** → Status
  line cache timer cycles the TTL: 5m (default, the shortest any provider documents, so it goes cold
  early rather than late), 1h, off.
- `sub`: the model runs on a subscription.
- `claude 5h 󰪢 62% · week 󰪟 31%`: your plan usage (Claude or Codex), each window with its own ring. It appears after the first response
  and follows subagents too. **Status** → Status line weekly usage off keeps only the 5h window.
- `MCP 3/3`: MCP servers online / installed.
- `⠋ 1 job`: background jobs (bash_background, monitor) still running; the spinner turns while they run.
- `claude-opus-5-5 · high` (bottom right, above the editor): the model in use and its effort. It is
  always there: at the end of the `Working` row while Pi works, on that same row when it is idle.

## Limits

- If a future gentle-pi or gentle-engram changes what it draws, the affected part falls back to its
  original look. Pi keeps working.
- Quiet rows expand with `ctrl+o`, not with a click.
- Changing **Subagent results** applies after a restart.
- The default memory icon needs a local `GentleBrain.ttf` font. Without it, pick another icon in **Icons**.
- The default RDD icon needs the `GentleIcons.ttf` font from `fonts/` (`cp fonts/GentleIcons.ttf ~/.local/share/fonts/ && fc-cache -f`, then reopen the terminal). Without it, pick another icon in **Icons**.
- The `ctx` and plan usage meters are one ring that fills in eighths, drawn with Nerd Font glyphs.

## Development

```sh
npm test
```
