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
| Status line | Pi's footer (tokens, context, model) | Gentle Shell's bar: `~/app main ±2 +3 -1 · model · effort` … `· Perm: Normal` on the left, `R50k W2.0k CH98.0% · ctx ▰▰▱▱▱▱▱▱ 28% · $1.75 sub` on the right; counters give way first, and statuses move to a second row only when they still do not fit |
| Footer statuses | `🧠 project · ✓ 4 results`, `Permissions: YOLO`, `🚀 YOLO ON 🔥 …` | `mem 4 results`, `Perm: Yolo` (theme colors), banner hidden |
| Memory calls | `🧠 search "x" …` | `􀀀 search "x"` drawn like Pi's own tool rows |
| gentle-pi tool rows | `✿todo · write` flush against the edge | ` ≡ todo · write` on Pi's one-column margin |
| Stale subagent results | Rounded `❀ Stale agent result` card | ` ◈ agent · stale` + ` └ completed 2m ago while the orchestrator was busy` |
| Subagent results | Rounded `❀ Agent result` card | ` ◈ gentle-ai-explore · done` + ` └ first line of the answer`; `ctrl+o` shows it all |
| Todos / Agents blocks | Background panel with an accent bar and padding rows | Flat rows in a square outline using the theme's `border` color |
| Pi tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `codemode`) | Boxed output preview | Call row plus a one-line summary; `ctrl+o` shows Pi's full output |
| Tool call tones | Bold `toolTitle` name, `accent` path | Claude Code's tones, fixed truecolor: tool name and `$ command` in light grey `#bcbcbc`, paths and arguments in `#999999` (`/gentle-quiet` → **Tool rows** → **Tool call tones: theme** goes back to the theme's colors, e.g. for light themes) |
| `edit` | Diff preview while editing | `+N -M` and the first two changed lines in the theme's diff colors |
| `codemode` | Script and output | Number of calls and their servers; failed calls listed; the first lines of the script's output |
| Prompt | Pi's editor | Pi's editor with a `❯` flush with the margin in front of the input and of sent messages |
| Sent user messages | Three-row bar: blank padded rows above and below the text | One-row bar like Claude Code |

## Install

```sh
pi install git:github.com/viniciosrab/pi-gentle-quiet@v0.9.1
```

Pin a tag (as above) to keep your look stable; drop `@v0.9.1` to follow `main`. Restart Pi, then run `/gentle-quiet` to configure it.

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

`/gentle-quiet` opens a menu of sections; pick one to see its options, and **← Back** (or escape)
to return. Every change applies immediately and is saved to `<Pi agent dir>/gentle-quiet.json`
(normally `~/.pi/agent/gentle-quiet.json`). **Reset to defaults** sits on the first screen.

| Section | Option | Default |
|---|---|---|
| Status line | Status line / changes / cost | `gentle` (`pi` gives the footer back to Pi) / on / on |
| | Status line usage | on: Gentle Shell's usage bar after the cost, `claude 5h ▰▰▰▰▰▱▱▱ 62% · week 31%` (meter like `ctx`; warning from 80%, error from 95%) |
| | Status line MCP | on: `MCP 3/3` (online / installed) among the statuses; warning color when a server is offline |
| | Status line tokens | `cache` (`R W CH%`); `all` adds `↑ ↓`; `off` |
| | Estimated cost (unpriced providers) | on: zero-priced responses (claude-bridge) are priced at the same model's Anthropic API rates |
| | Subscription (current provider) | off; on shows `sub` for a plan Pi cannot detect, such as claude-bridge |
| Footer statuses | Memory in footer / label / project name | on / `mem` / off |
| | Permission in footer / label / hidden when normal | on / `Perm` / shown |
| | YOLO banner | hidden |
| Tool rows | Tool rows (gentle-pi and memory) / margin | `quiet` (`original` leaves them as their packages draw them) / on |
| | Tool call tones | `claude`: Claude Code's fixed greys; `theme`: the theme's `toolTitle` and `accent` colors |
| | Quiet tools / preview lines | on / 0 |
| | Expand hint (`ctrl+o to expand`) | `last`: only the most recent call (`all`, `never`) |
| | Codemode output lines / detail | `3` (`5`, `10`, `0` to hide) / `failures` |
| Blocks and agents | Todos/Agents blocks / border | minimal / on |
| | Subagent results | minimal (restart to apply) |
| Icons | Memory / todo / agents / other gentle tools | `􀀀` (U+100000) / `≡` / `◈` / `›` |
| Prompt | Prompt icon in input / in sent messages / icon | on / on / `❯` |

The default memory icon U+100000 is an outlined brain from a local `GentleBrain.ttf` font in `~/.local/share/fonts`; without that font, pick `󰧑` (needs a [Nerd Font](https://www.nerdfonts.com/)) or `⟲` in the menu.

## Limits

- It rewrites what gentle-pi and gentle-engram draw. If a future version changes that output, the
  affected item falls back to its original look; Pi keeps working.
- Mouse clicks on the Todos/Agents header can land one row off; use the keyboard shortcuts.
- Quiet rows expand with `ctrl+o`, not with a click. Toggling quiet tools applies to new calls.
- Pi's live diff preview while an `edit` is being applied is not shown; the summary appears when it ends.
- Pi draws a message type with the first extension that registered it. Local extensions load
  before packages; as a package, list `git:github.com/viniciosrab/pi-gentle-quiet` before
  `npm:gentle-pi` in `packages` so subagent results use the quiet row.
- Providers that report every call at $0 (claude-bridge) get the API-equivalent cost of the same model
  from Pi's `anthropic` prices, the same notional figure Pi shows for other subscriptions. It is an
  estimate of what the tokens would cost on the API, not a charge.
- `claude 5h ▰▰▰▰▰▱▱▱ 62% · week 31%` (`codex …` for Codex) reads the rate-limit headers of each provider response (Claude, also through
  claude-bridge, and Codex), so it needs no credentials or extra requests. It appears after the first
  response of a session, belongs to the provider that reported it, and a window that already reset is
  not shown. API-key providers without plan limits show nothing.
- `MCP online/installed` counts the enabled servers of `~/.pi/agent/mcp.json`, the trusted project's
  `.pi/mcp.json` and servers registered by extensions. A server is online while Pi shows tools for it
  (Pi hides them when it disconnects), so a server configured with `exposure: hidden` reads as offline.
- A zero cost is hidden unless the provider is a known subscription, like Pi's own footer. Providers that
  bill through a plan without telling Pi (claude-bridge reports every call at $0) can be marked in
  `/gentle-quiet` → **Status line** → **Subscription (<provider>)** to show `sub`.
- The status line reads changes with `git` (against `HEAD`, untracked files included) after each turn and
  tool call. It does not show subscription usage or the active Gentle profile.
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
