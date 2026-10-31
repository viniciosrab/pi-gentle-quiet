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
- **A subagent's live thread in one click.** Each row of the Agents card whose subagent is still at work
  (running, queued or waiting) ends with `↗`; a click on that row opens a pop-up over Pi focused on it: agent,
  status, model and elapsed time, then what it does in this conversation's own look: its prompt folded to one dim
  line, thinking folded to one "Thinking..." row as in the main conversation, text as Markdown, and each tool call as the quiet rows above (`$ npm test`, then
  `└ ✓ 12 lines · 1.4s`, `└ ✗ exit 1` with its last lines, or `└ running…` until it ends); web calls keep
  pi-web-access's row behind the status dot (lit, without blinking), memory calls the memory row
  (`search “x”`, `└ ✓ 3 results`), codemode its calls and sources, as in the conversation. It reads the
  subagent's own Pi session (`~/.pi/agent/gentle-agents/sessions/*.jsonl`, found by one of its tool call ids)
  about twice a second, only what was appended, and follows the end while the subagent works; `↑↓` `PgUp/PgDn`
  `Home/End` or the wheel scroll, `End` or `f` follows again, `Esc`/`q` or a click outside closes it. Before its
  first tool call, or when its session cannot be read, the pop-up shows gentle-pi's thread from its presence file,
  drawn with gentle-pi's own renderer as the `alt+k` window draws it. A finished subagent's row (`✓`, `✗`, `–`)
  ends with `↗` too when its task record names its session, and opens the same pop-up, marked finished or failed.
  Without gentle-pi's files the click opens its `/gentle:agents` list instead.
- **Side column on wide terminals.** In a fullscreen Pi with 140+ columns, a column on the right
  holds the status line as two cards that always stay on top. **Status** has the project, branch and
  model under a label column, then an **MCP** row with the MCP servers online out of those installed
  (`MCP   3/3`, in the warning color while one is offline), then a blank row and the statuses, one per row. **Context** has the tokens in
  use with the ctx gauge (`56k / 200k tokens   󰪢 28%`), a bar across the card in the gauge's color,
  and the tokens spent with the cost (the plan usage is in the PROF tab). Jobs and Todos scroll under them. The Todos card shows every
  task. Click a card's title to collapse or expand it (Todos keeps gentle-pi's own state and shortcuts).
  The Agents card stays inline above the editor, as without the column.
- **Tabs in the side column**, after [pi-cinlodev-cute](https://github.com/CinloDev/pi-cinlodev-cute):
  `1:MAIN 2:GIT 3:PROF 4:MEM 5:TREE 6:PR` on top of the column. Click a tab, or turn the wheel over
  the bar, to switch. **MAIN** is the column above; **GIT** the commit graph or branches and the working
  tree, each file with TREE's icon for it (emoji or nerd, as Tree icons) and its path, then `+n −n` and its status letter
  (`M`, `A`, `D`, `R`, `U`, `!`) last on the right, as VS Code's (a click opens a file in the read-only preview, a branch lists its diff with HEAD); **PROF** gentle-pi's profiles with the selected profile's roster, and the plan
  usage, edited in place like gentle-pi's `/gentle:profiles` screen, through its own profile functions: a click on a profile
  selects it, a click on an agent's or the orchestrator's model picks one of Pi's models in a small pop-up by the row, a click
  on its effort steps to the next level that model allows; edits stay unsaved (•, ● N unsaved, in warning) until
  `[ Save ]`. `[ Use in this session ]` binds the profile to this session (◉), saving unsaved edits first; leaving a profile
  with unsaved edits asks Save and switch, Discard or Stay. `[ Make default ]` (the default for new sessions is marked ●) saves and opens `/gentle:profiles`, where
  gentle-pi keeps its Make default; the Profiles title opens that editor too, and so does every click with Gentle Shell on or
  a gentle-pi without these functions. PROF also takes the keyboard, with the keys of gentle-pi's screen: `alt+p` opens
  PROF with the keyboard on it, and so does a click on the Profiles card (the click still does its own). The selected row
  is drawn as gentle-pi's screen draws it: plain text on the theme's selection background across the whole row (name,
  model and effort, and its wrapped row), its text where it was (reverse video on a theme without one), and a dim hint closes the card; `←` `→` the previous or next profile (unsaved edits ask as a
  click does: `s` save and switch, `d` discard, `esc` stay), `↑` `↓` the orchestrator and the agents, `enter` its model
  (the picker's own keys then; `esc` closes it first), `e` its effort, `s` or `ctrl+s` Save, `u` Use in this session,
  `d` Make default, `esc` gives the keyboard back to the editor (so do another tab and a narrower terminal). While PROF
  has the keyboard no key reaches the editor; without the side column `alt+p` reaches Pi as before; **MEM** Engram's local essentials (server status and version, this project's memories, sessions and prompts, the shared database's size; "⚑ N to review · N conflicts" when
  some are pending), the last session handoff folded to one row (its title unfolds it, a click on it opens the whole summary in the pop-up), and the memories
  the agent saved and recalled in this session (a click opens one read-only in the preview pop-up); **TREE** the project tree (`⌂ PROJECT · <name>`) with git badges and `[ ↗ nvim ]` (a click
  on a file opens a read-only preview over Pi: `Esc`/`q` or a click outside it closes it, `↑↓` `PgUp/PgDn` `Home/End` or the
  wheel scroll, `e` opens the file in your editor; a Markdown file shows rendered, `m` toggles its
  source); **PR** the repository's open pull requests from one `gh api graphql` call, drawn as their stack (a PR
  based on another sits under it), each with the one thing it waits on (✗ conflicts, ✗ CI, ✗ changes,
  ⚠ N threads, ⧗ CI, ◌ draft, ⧗ review, ✓ ready), after a CI chip counting the passed checks (✓ CI 10/10,
  ⧗ CI 5/10, ✗ CI 9/10; skipped ones left out) that stands for a ✗ CI or ⧗ CI verdict; a click on a PR
  expands its detail under its bold title (mergeability, review, then `Checks 2/3` and `Threads 4` over each check and
  each unresolved thread, and a blank row closing the block) or closes it, several open at once, the current branch's PR (◉) to begin with,
  the stack's line running on through the detail of a PR with PRs under it, and a check or a thread
  opens in the browser. On the current branch's PR, [ Fix N threads with agent ] and [ Fix CI ] put the
  threads or the failed checks in Pi's editor for you to send. Files open in your editor (`e` in the preview) in a herdr tab
  inside herdr, else in a new terminal. Narrower terminals keep everything as it is. **Blocks** → Tab order
  in `/gentle-quiet` reorders the tabs: pick one, Move up / Move down (PR second gives
  `1:MAIN 2:PR 3:GIT 4:PROF 5:MEM 6:TREE`, numbered by position), or Reset to default order. You can also
  drag a tab sideways in the bar and drop it at a new place; the order is saved the same way.
- **Nerd Font icons in TREE.** With **Blocks** → Tree icons: nerd in `/gentle-quiet` (emoji by default),
  the TREE tab draws its file and folder icons as Neo-tree draws them in LazyVim (what `omarchy-launch-editor`
  opens): the glyph [mini.icons](https://github.com/nvim-mini/mini.icons) picks for the file
  ([MIT](fonts/LICENSE-mini-icons)), by file name then extension, and Neo-tree's own folders, in your terminal's
  Nerd Font at its own size, painted with your Pi theme's colors. No extra font to install.
  `fonts/build-nerd-icons.py` regenerates the mapping from mini.icons in a headless Neovim.
- **Hidden items in TREE, as Neo-tree.** Dotfiles, git-ignored files and build folders (`node_modules`,
  `dist`, `.git`…) are hidden, and each folder level that hid some ends with a dim "(n hidden items)" row.
  Click that row, or set **Blocks** → Tree hidden items: show in `/gentle-quiet`, to list them (dim); the
  setting is saved.
- **Gentle Shell's Jobs card.** In the side column, running background jobs get a card on top, newest
  first with their elapsed time; finished jobs stay 60 seconds with ✓, ✗ or –. Click its title or press
  `ctrl+shift+j` to collapse it. Only running jobs spin; the title keeps a still icon (`⧗`, in
  **Icons**). Without the side column the status line keeps `⠋ N jobs`. A running job's row ends with `↗`:
  a click on it opens the same live pop-up as a subagent's, with the job's label and id, running or finished with
  its exit code, the elapsed time, and the tail of its output as it is written (like `tail -f`; the log gentle-pi
  keeps for the job, found among the files Pi holds open on Linux). Elsewhere, or when that log cannot be found,
  the click opens gentle-pi's `/gentle:jobs` list.
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
