---
name: workflow
description: Runs the codex-team Workflow - an automatic pipeline where Claude plans, OpenAI Codex workers (the user's ChatGPT subscription) implement in parallel waves, Claude reviews each change, fixes go back to the same Codex thread, and Claude checks the integrated result. Use when the user asks for a Codex workflow / "workflow с Codex" / "запусти команду Codex" on a multi-part coding task.
argument-hint: Задача - ... | Папка - ... | Проверка - ... | Codex - effort=medium, параллельно=3, правок=2 | Ревью - opus
disable-model-invocation: true
---

# codex-team Workflow

The user invoked this skill, which is their opt-in to run the Workflow below.

Request: $ARGUMENTS

## Launch card (the one format for every run)

Users write the request as this card; any field but `Задача` may be left out. Free text without the card is read as `Задача`.

```
Задача:       what to build or change, with all requirements
Папка:        absolute project path              -> default: the current project root
Проверка:     command that checks the result     -> default: the planner finds one
Исполнители:  codex | claude | mixed             -> default: codex
Codex:        модель=<slug>, effort=<level>      -> default: the user's routing by task tier (simple/standard/complex)
Claude:       модель=opus|sonnet|haiku|fable, effort=low|medium|high|xhigh|max
Параллельно:  N (default 3)     Правок: N (default 2)
Ревью:        opus|sonnet|haiku|fable            -> default: this session's model
```

Codex models and levels are never hard-coded: check them with `bash "${CLAUDE_PLUGIN_ROOT}/scripts/codex-job.sh" models` (live catalog; new OpenAI models appear there as soon as Codex sees them). A card that names a model or level not in the catalog fails with the list of valid choices.

It maps one-to-one onto the Workflow `args` (a JSON object, not a string):

| Card | args | |
|---|---|---|
| Задача | `task` | required; add constraints from this conversation |
| Папка | `cwd` | required, absolute |
| — | `pluginRoot` | required, always `${CLAUDE_PLUGIN_ROOT}` |
| — | `routing` | required for Codex: the JSON from `codex-job.sh routing --json` |
| Проверка | `check` | optional |
| Исполнители | `executors` | optional: `codex`, `claude` or `mixed` (planner picks per task) |
| Codex модель / effort | `codexModel` / `codexEffort` | optional |
| Claude модель / effort | `claudeModel` / `claudeEffort` | optional |
| Параллельно / Правок | `maxParallel` / `maxFixRounds` | optional |
| Ревью | `reviewModel` | optional |

## Steps

0. **Routing first.** Run `bash "${CLAUDE_PLUGIN_ROOT}/scripts/codex-job.sh" routing` (and `routing --json` for the args). If it says NOT CONFIGURED, routing is not set up: run `codex-job.sh models`, then ask the user with AskUserQuestion which Codex model and reasoning level to use for simple, standard and complex tasks and which models to avoid (offer only models and levels from that live list, and quote their descriptions; do not guess prices), save the answer with `codex-job.sh routing --set` (JSON on stdin), and show the saved routing. Do not start Codex before routing exists, unless the card fixes both model and effort. If `codex-job.sh routing` lists NEW MODEL or ROUTED MODEL GONE lines: look up those models' prices and benchmarks (WebSearch: OpenAI announcements and pricing page), compare them with the routed models, and tell the user what you found with sources. If a new model is cheaper and stronger than a routed one, you may use it for that tier in this run, say so, and ask the user (AskUserQuestion) whether to save it in the routing (`routing --set`). Then run `codex-job.sh routing --ack`. Routing tiers are defaults: raise the model or level for a task that needs it, and say why.
1. **Fill the card.** Resolve `Папка` to the absolute project root. Run `git status --short` there. If the folder is not a git repository, run `git init` and commit the current state so reviewers can see Codex's diffs; if it has uncommitted changes, tell the user in one line that reviewers will see them mixed with Codex's, and continue.
2. **Show the card** you are about to run, filled in, in one short block, including which Codex model/level each tier maps to.
3. **Run the Workflow** with `scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/codex-team.js"` and the `args` above.
4. **Verify the result yourself** when it returns: read `git diff`, run the check command, and for UI open it in a browser and look. The workflow's reviews are evidence, not the last word.
5. **Report**: per task - executor, model and level, status, fix rounds, what was verified; Codex tokens per model (from the result's `codexTokens`); the integration verdict; anything failed, skipped or unverified, with the Codex THREAD_ID so it can be continued (`codex-team:codex-worker` with `THREAD_ID:`).
