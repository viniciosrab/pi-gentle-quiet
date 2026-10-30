# Sidebar tabs (pi-cinlodev-cute style) for gentle-quiet's side column

Tabbed side column after pi-cinlodev-cute (https://github.com/CinloDev/pi-cinlodev-cute, studied at a1add72):
the tabs it has, filled with gentle-quiet's own cards where they exist and cute's original design where they do not.
Branch `feat/sidebar-tabs`, stacked on `feat/sidebar-cards` (7969775).

## Specs

- **S1 — scope: side column only.** User: "Mas essa implementação só vai valer para a barra lateral, né? Quando não tiver a pétala toda, ele fica como tá, né? Não modifica, é só para a barra lateral, sabe?" Below the side-column breakpoint nothing changes (status line, cards, editor byte-identical).
- **S2 — existing things unchanged.** User: "o que já existe de nossas coisas a gente não vai alterar certo? A gente só vai tipo aqui o status, o contexto, o jeito que aparece os cards de subagente, enfim os tudo, nada." The Status, Context, Jobs, Agents and Todos cards keep their look and behavior.
- **S3 — the tabs.** User: "A gente só vai implementar esses negócios aí do single dev, sabe? Aí que aparece tipo o main vai ser o que a gente já tem né? Aí tem a parte do git, prof que é de parte dos arquivos, main que é do engram etc. Tu vai implementar todos, mas com as coisas que a gente tem aqui já do nosso jeito, entendeu? E as coisas que não tem você bota do jeito que tá ali originalmente do single dev, né?" Tabs (revised by L5): `1:MAIN 2:GIT 3:PROF 4:MEM 5:TREE`, active tab drawn `[ 5:TREE ]`.
  - MAIN: Status and Context fixed, then Jobs and Todos. The Agents card is not in the side column: it stays inline above the editor, as without the side column (L5).
  - GIT: cute's Git tab (branches + commit graph card, working tree / branch diff card, editor and diff launchers).
  - PROF: cute's profiles tab, with gentle-pi's profiles and gentle-quiet's plan usage instead of pi-sdd-profiles and CLIProxyAPI.
  - MEM: cute's memory tab (Engram card, handoff, ecosystem, tools); cards whose package is not installed are left out.
  - TREE: cute's project explorer (git status badges, folder toggles, `[ ↗ nvim ]` launcher).
- **S4 — no YouTube tab.** User: "E o do youtube, que é o 6 do youtube, você não precisa colocar, entendeu????"
- **S5 — tab switching as in cute:** left click on a tab in the tab bar, mouse wheel over the tab bar cycles tabs. The tab bar stays fixed at the top of the column.
- **S6 — TREE file preview:** a left click on a file in TREE opens a read-only preview pop-up inside Pi (Esc closes, scroll keys, `e` opens it in the editor tab as before), instead of a new editor tab per click.
- **S7 — preview polish:** a Markdown file shows rendered Markdown in the preview (raw source on a key); the pop-up's outline sits flush with its edge, with no black half-cell sticking out past the border over the conversation.
- **S8 — PR tab:** a `6:PR` tab after TREE lists the repository's open pull requests, one per row: number, title and a checks summary (✓ passed, ✗ failed, ⧗ running). The current branch's PR, when open, comes first with its detail: state and mergeability, each check with its state, unresolved review comments and the latest. No branch rows and no ahead/behind counts. With no open PR: "No open pull requests". A click opens the PR or the check in the browser. Data from `gh`.
- **S9 — MEM tab, what is useful:** replace the Stack · Ecosystem and Tools cards with (1) "Saved this session": the memories the agent saved or updated in this session (mem_save / mem_update), title and type, a click opens the memory in the read-only pop-up; (2) "Recalled this session": the memories the agent searched or read into the conversation (mem_search / mem_get_observation / mem_context); (3) Engram pending items (observations due for review, relations waiting for judgment) as a count, shown only when there are some. The Active Handoff folds to one row (`#920 · 1h ago · <goal first line>`) that a click expands to the full text. Stack shows only when an update is available. The Engram status card stays.

## Decisions

- D1: no "✿ CINLODEV · GENTLE-SHELL ✿" banner (cute's brand); the tab bar opens the column.
- D2: helper modules live in `extensions/sidebar/` without an `index.ts`; Pi's `discoverExtensionsInDir` loads only files at the top level and subdirectories with `index.ts`/`index.js` or a `package.json` manifest, so they are not loaded as extensions. Deploy copies `extensions/gentle-quiet.ts` and `extensions/sidebar/` to `~/.pi/agent/extensions/`.
- D3: active tab kept in memory like cute (starts at MAIN), not persisted.

## Tasks

| ID | Specs | Route | Commit |
|---|---|---|---|
| T1 | S1, S2, S3 (MAIN, AGENTS), S4, S5 | worker: tab framework, registry, tab bar, MAIN and AGENTS tabs, stub modules for the others | 82d31b5 |
| T2 | S3 GIT | worker (parallel): `extensions/sidebar/git.ts` | d38a1a6 |
| T3 | S3 PROF | worker (parallel): `extensions/sidebar/prof.ts` | 80006e0 |
| T4 | S3 MEM | worker (parallel): `extensions/sidebar/mem.ts` | 030093c |
| T5 | S3 TREE | worker (parallel): `extensions/sidebar/tree.ts` | 3fb3edd |
| T6 | all | parent: README, full suite, deploy, live check | |
| T8 | S4 (L6, reverted by L8) | worker: YT tab after cute's src/youtube/*, reading pi-youtube-player's published state | 45ded34 |
| T9 | S2 (L7) | parent inline: model label in the Status card under Branch with the side column; not above the editor nor on the Working row | 84f2cb7 |
| T10 | S6 (L9) | worker: TREE file preview overlay (tree-preview.ts), `e` opens the editor | f33e3b5 |
| T11 | S7 (L10) | worker: rendered Markdown in the preview; flush pop-up outline | 6ec8f47 |
| T12 | S8 (L11) | worker: 6:PR tab (pr.ts, pr-data.ts); tab contract gains optional onHide() | f48d1a4 |
| T13 | S8 (L12) | worker: PR tab lists the open PRs, current branch's PR first; no branch/ahead-behind | f541c22 |
| T14 | S9 (L14) | worker: MEM tab — saved/recalled this session, pending count, folded handoff; drop Tools, Stack only with updates | pending |
| T7 | S3 (L5) | worker: drop the AGENTS tab; Agents card inline above the editor even with the side column | 495a501 |

## Log

- L1 (user, verbatim): "https://github.com/CinloDev/pi-cinlodev-cute [Image#1] [Image#2] Agora vamos meio que tipo o que já existe de nossas coisas a gente não vai alterar certo? A gente só vai tipo aqui o status, o contexto, o jeito que aparece os cards de subagente, enfim os tudo, nada. A gente só vai implementar esses negócios aí do single dev, sabe? Aí que aparece tipo o main vai ser o que a gente já tem né? Aí tem a parte do git, prof que é de parte dos arquivos, main que é do engram etc. Tu vai implementar todos, mas com as coisas que a gente tem aqui já do nosso jeito, entendeu? E as coisas que não tem você bota do jeito que tá ali originalmente do single dev, né? E o do youtube, que é o 6 do youtube, você não precisa colocar, entendeu???? Mas essa implementação só vai valer para a barra lateral, né? Quando não tiver a pétala toda, ele fica como tá, né? Não modifica, é só para a barra lateral, sabe? Entendeu??" Screenshots: cute's rail with header "✿ CINLODEV · GENTLE-SHELL ✿", tab bar "1:MAIN 2:GIT 3:AGENTS 4:PROF 5:MEM [ 6:TREE ]" and the TREE tab (project tree with git badges, "[ ↗ nvim ]").
- L2 (evidence): cute at a1add72 has tabs `1:MAIN 2:GIT 3:PROF 4:MEM 5:TREE 6:YT` (src/sidebar-tabs.ts:24-31); AGENTS was folded into PROF after the user's screenshot. The user's screenshot order is used. Exploration map: subagent task mvuiqm49-1-0f45.
- L3 (evidence): T1 done (worker mvuiv74b-2-f71c), 252/252 tests; tab contract `createTab(host): SidebarTab` documented in extensions/sidebar/tabs.ts. Slice boundary: T1 is its own commit; T2-T5 one commit each.
- L4 (evidence): T2-T5 done by parallel workers; full suite 342/342. PROF's quota bar switched from ▰▱ to ■□ to match the Context card the user chose. Deployed: extensions/gentle-quiet.ts and extensions/sidebar/ to ~/.pi/agent/extensions/.
- L5 (user, verbatim): "no original não tem aquela parte de agentes né, no original a parte do agentes é como original, ela fica inline ali né, não fica na tabela lateral. Pra melhor experiência [...] qual que seria o melhor, como no original, inline né [...] ou nessa aba de agentes??" Recommendation given: inline, drop the AGENTS tab. User: "sim".
- L6 (user, verbatim): "coloque do YT tbm agora". S4 is revised: the YouTube tab is wanted now, as `6:YT` after TREE, following cute's src/youtube/* (it reads the state pi-youtube-player publishes on globalThis[Symbol.for("pi-youtube-player")]; that package is not installed here, mpv and yt-dlp are).
- L7 (user, verbatim): "E o modelo que a gente colocou na inline, mas isso só quando a tela estiver inteira e o painel lateral. O nome do modelo vai ficar lá no status, no bloco do status abaixo da branch." Done in 84f2cb7; below the breakpoint the model stays above the editor.
- L8 (user, verbatim): "aaa remova essa aba ai de YT". YT tab reverted (ddf4a4e, 1d59ae1); S4 back to no YouTube tab. pi-youtube-player itself left installed pending the user.
- L9 (user, verbatim): "Você acha, para a experiência de programação e usuário, você acha melhor ali na questão dos Tui, quando abre um documento, ele abre uma nova aba separada ou abre em pop-up?" Recommendation: click opens a read-only pop-up, a key opens the editor tab. User: "sim". Added S6, T10.
- L10 (user, verbatim): "no modo pop up tipo arquivos markdow tem como invez de o preview vim e markdow ter o visulizado e markdow?? e alem disso o bloco do poup up da com uma rebarba do bloco pra fora vejaa [...] e tbm tem uma falha em baixo feja a linha borda nao veja ta com falhas e eu vi isso tbm [...] no bloco do tree essas falhjas na linha nao sei oque é tem haver com o pop up" then "para contexto agr que fichei os editor essas falhas sumiram". Evidence: the rebarba is the overlay's black half-cell outside the ┌│└ strokes, visible over the grey user-message rows; the TREE border gaps went away once the herdr editor tabs closed (a redraw after herdr resized the pane), not the pop-up. Added S7, T11.
- L11 (user, verbatim): "ótimo agora para a experiência de desenvolvimento de coisa você acha que essas cinco abas que tem ali é o suficiente no caso você colocaria mais alguma outra coisa para melhor produtividade enfim melhor saber o que tá acontecendo etc" Recommendation: one more tab, 6:PR (PR + CI checks + review comments via gh). User: "ok faca". Branch feat/sidebar-pr-tab from main 46efd83 (PRs #16, #17 merged).
- L12 (user, verbatim): "Não, mas aí é aba de PR, quando tem um PR aberto, não é pra ficar mostrando branch, entendeu?" Asked: list of open PRs vs only the branch PR. User chose: "Lista dos PRs abertos do repositório". S8 rewritten; T13.
- L13 (user, verbatim): "outra coisa ali no na aba do do iKing da aba do git quando tem alguma algum arquivo ali né quando eu clico ele abre o editor ele tem que abrir o visualizador sabe o pop-up e eu notei também aquele que eu tinha te falado antes quando eu tô com o editor aberto tem as bordas ali [...] ela fica cortada [...] Aí se eu fecho o editor, essas falhas somem, sabe? Investigue e arrume." GIT file click now opens the preview (414bf40). Border gaps: herdr 0.9.5 pane grid (herdr pane read) holds │ on every card row while the editor tab is open, so Pi draws them; the terminal is foot, inside herdr, and the cells go missing between herdr's composited view (tab bar shown with 2+ tabs) and foot. Pending a full-pane screenshot to match gap rows with the grid.
- L14 (user, verbatim): "Outra coisa, aqui na parte do Nen, que é do Engram Qual coisa aqui você acha útil pra mim? Ou que tá faltando, que seria realmente útil? E esse negócio de active end-off, o que que é e tal?" Recommendation: replace Stack and Tools with saved/recalled memories of this session, pending count, handoff folded to one row, Stack only with updates. User: "sim". S9, T14.
