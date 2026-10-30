# Sidebar tabs (pi-cinlodev-cute style) for gentle-quiet's side column

Tabbed side column after pi-cinlodev-cute (https://github.com/CinloDev/pi-cinlodev-cute, studied at a1add72):
the tabs it has, filled with gentle-quiet's own cards where they exist and cute's original design where they do not.
Branch `feat/sidebar-tabs`, stacked on `feat/sidebar-cards` (7969775).

## Specs

- **S1 — scope: side column only.** User: "Mas essa implementação só vai valer para a barra lateral, né? Quando não tiver a pétala toda, ele fica como tá, né? Não modifica, é só para a barra lateral, sabe?" Below the side-column breakpoint nothing changes (status line, cards, editor byte-identical).
- **S2 — existing things unchanged.** User: "o que já existe de nossas coisas a gente não vai alterar certo? A gente só vai tipo aqui o status, o contexto, o jeito que aparece os cards de subagente, enfim os tudo, nada." The Status, Context, Jobs, Agents and Todos cards keep their look and behavior.
- **S3 — the tabs.** User: "A gente só vai implementar esses negócios aí do single dev, sabe? Aí que aparece tipo o main vai ser o que a gente já tem né? Aí tem a parte do git, prof que é de parte dos arquivos, main que é do engram etc. Tu vai implementar todos, mas com as coisas que a gente tem aqui já do nosso jeito, entendeu? E as coisas que não tem você bota do jeito que tá ali originalmente do single dev, né?" Tabs, as in the user's screenshot: `1:MAIN 2:GIT 3:AGENTS 4:PROF 5:MEM 6:TREE`, active tab drawn `[ 6:TREE ]`.
  - MAIN: today's column as it is (Status and Context fixed, then Jobs, Agents, Todos).
  - GIT: cute's Git tab (branches + commit graph card, working tree / branch diff card, editor and diff launchers).
  - AGENTS: gentle-quiet's Agents card on its own.
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
| T1 | S1, S2, S3 (MAIN, AGENTS), S4, S5 | worker: tab framework, registry, tab bar, MAIN and AGENTS tabs, stub modules for the others | |
| T2 | S3 GIT | worker (parallel): `extensions/sidebar/git.ts` | |
| T3 | S3 PROF | worker (parallel): `extensions/sidebar/prof.ts` | |
| T4 | S3 MEM | worker (parallel): `extensions/sidebar/mem.ts` | |
| T5 | S3 TREE | worker (parallel): `extensions/sidebar/tree.ts` | |
| T6 | all | parent: README, full suite, deploy, live check | |

## Log

- L1 (user, verbatim): "https://github.com/CinloDev/pi-cinlodev-cute [Image#1] [Image#2] Agora vamos meio que tipo o que já existe de nossas coisas a gente não vai alterar certo? A gente só vai tipo aqui o status, o contexto, o jeito que aparece os cards de subagente, enfim os tudo, nada. A gente só vai implementar esses negócios aí do single dev, sabe? Aí que aparece tipo o main vai ser o que a gente já tem né? Aí tem a parte do git, prof que é de parte dos arquivos, main que é do engram etc. Tu vai implementar todos, mas com as coisas que a gente tem aqui já do nosso jeito, entendeu? E as coisas que não tem você bota do jeito que tá ali originalmente do single dev, né? E o do youtube, que é o 6 do youtube, você não precisa colocar, entendeu???? Mas essa implementação só vai valer para a barra lateral, né? Quando não tiver a pétala toda, ele fica como tá, né? Não modifica, é só para a barra lateral, sabe? Entendeu??" Screenshots: cute's rail with header "✿ CINLODEV · GENTLE-SHELL ✿", tab bar "1:MAIN 2:GIT 3:AGENTS 4:PROF 5:MEM [ 6:TREE ]" and the TREE tab (project tree with git badges, "[ ↗ nvim ]").
- L2 (evidence): cute at a1add72 has tabs `1:MAIN 2:GIT 3:PROF 4:MEM 5:TREE 6:YT` (src/sidebar-tabs.ts:24-31); AGENTS was folded into PROF after the user's screenshot. The user's screenshot order is used. Exploration map: subagent task mvuiqm49-1-0f45.
