# pi-gentle-quiet

A quiet, Pi-native look for [gentle-pi](https://github.com/Gentleman-Programming/gentle-shell) and
[gentle-engram](https://github.com/Gentleman-Programming/engram). The Gentle AI workflow stays the
same; only how it is drawn changes.

## What you get

- **Quiet tool rows.** Each call is one row plus a one-line result. `ctrl+o` shows the full output.
  Calls and messages Pi still draws in a background box start at the same column as these rows, not at the user message's.
  In fullscreen, Pi's scrollbar gets a column of its own at the right edge instead of painting over the last column of the rows.
- **Web calls without the box.** pi-web-access's `fetch`, `search`, `get_content` and `source_check` keep their own
  call row, at the same column as the other tool rows, behind Claude Code's status dot: grey and blinking while the call
  runs, then a fixed green when it ends or red when it fails, whatever the theme. Under it, one line that changes while
  the call runs, like Claude Code (pi-web-access's progress, or "Fetching…"), then its status line, such as
  `2/2 queries, 6 sources`. `ctrl+o` shows pi-web-access's full output.
- **Flat Todos and Agents cards** in a simple outline, using your theme's colors.
- **Side column on wide terminals.** In a fullscreen Pi with 140+ columns, a column on the right
  holds the status line as two cards that always stay on top. **Status** has the project and branch
  under a label column, then a blank row and the statuses, one per row. **Context** has the tokens in
  use with the ctx gauge (`56k / 200k tokens   󰪢 28%`), a bar across the card in the gauge's color,
  the tokens spent with the cost, and the plan windows on one row. Jobs, Agents and Todos scroll under them. The Todos card shows every
  task. Click a card's title to collapse or expand it (Agents and Todos keep gentle-pi's own state
  and shortcuts).
- **Gentle Shell's Jobs card.** In the side column, running background jobs get a card on top, newest
  first with their elapsed time; finished jobs stay 60 seconds with ✓, ✗ or –. Click its title or press
  `ctrl+shift+j` to collapse it. Only running jobs spin; the title keeps a still icon (`⧗`, in
  **Icons**). Without the side column the status line keeps `⠋ N jobs`.
- **One status line** with your folder, branch, changed lines, context, cost and plan usage. The
  model and its effort stay at the bottom right above the editor at all times, dimmed: at the end
  of the `Working` row while Pi works, and on that same row when it is idle.
- **A `❯` prompt** and one-row user messages, like Claude Code.
- **Gentle Shell's `alt+k` command menu** (models, profiles, persona, review mode, doctor…), without
  turning Gentle Shell back on.
- **Gentle Shell's image paste.** `ctrl+v` with an image in the clipboard puts an `[Image#1]` chip in the
  draft instead of a temp-file path. The chip is listed above the prompt with its size, and its
  thumbnail when Pi is idle in a terminal that draws images. On submit, it goes to the model as an image.

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
  Image paste stays too, through gentle-pi's own files, so gentle-pi updates reach it. It needs the `❯` prompt
  (`Prompt icon in input` on); with it off, Pi pastes the file path.
  So does the Jobs card, drawn by gentle-pi's own card code. Set `GENTLE_PI_JOBS_KEY` to move its shortcut, or `off`.
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
| Hide the weekly plan usage (`week 31%`), the context tokens (`56k/200k`) or `Perm: Yolo` | **Status** → Status line weekly usage, Status line context tokens, Status line permission |
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
