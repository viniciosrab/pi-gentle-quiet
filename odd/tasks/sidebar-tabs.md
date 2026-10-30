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
| T8 | S4 (L6) | worker: YT tab after cute's src/youtube/*, reading pi-youtube-player's published state | 45ded34 |
| T9 | S2 (L7) | parent inline: model label in the Status card under Branch with the side column; not above the editor nor on the Working row | 84f2cb7 |
| T7 | S3 (L5) | worker: drop the AGENTS tab; Agents card inline above the editor even with the side column | 495a501 |

## Log

- L1 (user, verbatim): "https://github.com/CinloDev/pi-cinlodev-cute [Image#1] [Image#2] Agora vamos meio que tipo o que já existe de nossas coisas a gente não vai alterar certo? A gente só vai tipo aqui o status, o contexto, o jeito que aparece os cards de subagente, enfim os tudo, nada. A gente só vai implementar esses negócios aí do single dev, sabe? Aí que aparece tipo o main vai ser o que a gente já tem né? Aí tem a parte do git, prof que é de parte dos arquivos, main que é do engram etc. Tu vai implementar todos, mas com as coisas que a gente tem aqui já do nosso jeito, entendeu? E as coisas que não tem você bota do jeito que tá ali originalmente do single dev, né? E o do youtube, que é o 6 do youtube, você não precisa colocar, entendeu???? Mas essa implementação só vai valer para a barra lateral, né? Quando não tiver a pétala toda, ele fica como tá, né? Não modifica, é só para a barra lateral, sabe? Entendeu??" Screenshots: cute's rail with header "✿ CINLODEV · GENTLE-SHELL ✿", tab bar "1:MAIN 2:GIT 3:AGENTS 4:PROF 5:MEM [ 6:TREE ]" and the TREE tab (project tree with git badges, "[ ↗ nvim ]").
- L2 (evidence): cute at a1add72 has tabs `1:MAIN 2:GIT 3:PROF 4:MEM 5:TREE 6:YT` (src/sidebar-tabs.ts:24-31); AGENTS was folded into PROF after the user's screenshot. The user's screenshot order is used. Exploration map: subagent task mvuiqm49-1-0f45.
- L3 (evidence): T1 done (worker mvuiv74b-2-f71c), 252/252 tests; tab contract `createTab(host): SidebarTab` documented in extensions/sidebar/tabs.ts. Slice boundary: T1 is its own commit; T2-T5 one commit each.
- L4 (evidence): T2-T5 done by parallel workers; full suite 342/342. PROF's quota bar switched from ▰▱ to ■□ to match the Context card the user chose. Deployed: extensions/gentle-quiet.ts and extensions/sidebar/ to ~/.pi/agent/extensions/.
- L5 (user, verbatim): "no original não tem aquela parte de agentes né, no original a parte do agentes é como original, ela fica inline ali né, não fica na tabela lateral. Pra melhor experiência [...] qual que seria o melhor, como no original, inline né [...] ou nessa aba de agentes??" Recommendation given: inline, drop the AGENTS tab. User: "sim".
- L6 (user, verbatim): "coloque do YT tbm agora". S4 is revised: the YouTube tab is wanted now, as `6:YT` after TREE, following cute's src/youtube/* (it reads the state pi-youtube-player publishes on globalThis[Symbol.for("pi-youtube-player")]; that package is not installed here, mpv and yt-dlp are).
- L7 (user, verbatim): "E o modelo que a gente colocou na inline, mas isso só quando a tela estiver inteira e o painel lateral. O nome do modelo vai ficar lá no status, no bloco do status abaixo da branch." Done in 84f2cb7; below the breakpoint the model stays above the editor.
