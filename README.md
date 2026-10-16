# pi-gentle-quiet

A quiet, Pi-native look for [gentle-pi](https://github.com/Gentleman-Programming/gentle-shell) and
[gentle-engram](https://github.com/Gentleman-Programming/engram). The Gentle AI workflow stays the
same; only how it is drawn changes.

## What you get

- **Quiet tool rows.** Each call is one row plus a one-line result. `ctrl+o` shows the full output.
- **Flat Todos and Agents cards** in a simple outline, using your theme's colors.
- **Side column on wide terminals.** In a fullscreen Pi with 140+ columns, Todos and Agents move to
  the right and the status line moves to the top. The Todos card shows every task.
- **One status line** with your folder, branch, changed lines, model, context, cost and plan usage.
- **A `❯` prompt** and one-row user messages, like Claude Code.

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
- Turning off `gentle-shell.ts` also removes `/gentle:changes`, `/gentle:usage` and the `alt+k` palette.
- List `pi-gentle-quiet` before `npm:gentle-pi` in `packages` so subagent results use the quiet row.

## Configure

`/gentle-quiet` opens a tabbed menu: `Status`, `Footer`, `Tools`, `Blocks`, `Icons`, `Prompt` and `Reset`.
Use ←/→ to switch tabs, ↑/↓ to pick an option and enter to change it. Changes apply right away and are
saved to `~/.pi/agent/gentle-quiet.json`.

Common choices:

| Want to… | Go to |
|---|---|
| Hide the cost, tokens, changed lines or plan usage | **Status** |
| Show `sub` for a plan Pi cannot detect (claude-bridge) | **Status** → Subscription |
| Use your theme's colors instead of Claude Code's greys | **Tools** → Tool call tones |
| Turn off the side column | **Blocks** → Side column |
| Change the icons or the `❯` prompt | **Icons**, **Prompt** |

## Reading the status line

- `±2 +3 -1`: files and lines changed since the last commit. Updates every 2 seconds, including
  while a subagent works.
- `$1.75`: cost of the session, **including its subagents**, each priced by its own model.
  On subscriptions that report $0 (claude-bridge), it is an estimate at Anthropic API prices, not a charge.
- `sub`: the model runs on a subscription.
- `claude 5h 62% · week 31%`: your plan usage (Claude or Codex). It appears after the first response
  and follows subagents too.
- `MCP 3/3`: MCP servers online / installed.

## Limits

- If a future gentle-pi or gentle-engram changes what it draws, the affected part falls back to its
  original look. Pi keeps working.
- Quiet rows expand with `ctrl+o`, not with a click.
- Changing **Subagent results** applies after a restart.
- The default memory icon needs a local `GentleBrain.ttf` font. Without it, pick another icon in **Icons**.

## Development

```sh
npm test
```
