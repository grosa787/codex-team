# codex-team

**English** · [Русский](README.ru.md)

A Claude Code plugin that turns OpenAI Codex into worker agents under Claude. Claude is the architect and reviewer: it reads the project, splits the task, writes briefs, dispatches agents, checks every result itself and sends fixes back. Codex (or Claude subagents, or both mixed) does the implementation. Codex runs through your locally installed Codex CLI and your ChatGPT subscription, so no OpenAI API key is needed.

## Features

- **Codex as a Claude agent.** `codex-team:codex-worker` takes a brief, runs `codex exec`, and returns Codex's report with a `THREAD_ID`. A follow-up with `THREAD_ID:` continues the same Codex session, so fixes keep their context.
- **One Workflow, any mix of agents.** Plan (Claude) → Build in parallel waves (Codex or Claude executor → Claude review → fix round) → Integrate (Claude). Executors can be `codex`, `claude` or `mixed`; each agent shows up in the Workflow panel (Claude Code CLI and Claude Desktop) labelled with its model and reasoning level.
- **Live model catalog.** Models and reasoning levels come from `codex debug models`, never from a hard-coded list. A new OpenAI model is usable as soon as your Codex CLI sees it. A session-start hook gives Claude the current list.
- **Per-task routing.** You choose which Codex model and level serve simple, standard and complex tasks, and which models to avoid. Claude asks you on first use. The planner may override a default for a task that needs it and must say why; avoided models are rejected.
- **New-model awareness.** When the catalog gains a model, Claude looks up prices and benchmarks, tells you, and asks whether to update the routing.
- **Token accounting for Codex.** Every report has a `TOKENS` line; the Workflow logs tokens per agent and returns totals per model; `codex-job.sh usage` sums all runs.

## Requirements

- [Claude Code](https://claude.com/claude-code) 2.1.275 or later (CLI or Claude Desktop).
- [Codex CLI](https://github.com/openai/codex) in `PATH`, signed in with ChatGPT: `codex login status` → "Logged in using ChatGPT".
- `jq`, `bash`, `git`.

## Install

In Claude Code:

```
/plugin marketplace add grosa787/codex-team
/plugin install codex-team@codex-team
```

Or from a terminal:

```bash
claude plugin marketplace add grosa787/codex-team
claude plugin install codex-team@codex-team
```

The plugin loads in **new** sessions (agents and hooks register at session start). No restart of Claude Desktop is needed; just open a new session. If the repository is private, `git` must be authenticated for GitHub (for example `gh auth login`).

Check: in a new session, ask "which Codex models are available?" or run `bash "<plugin dir>/scripts/codex-job.sh" models`.

## Use

### One-off, in plain words

> Do this with Codex: add pagination to the orders API and cover it with tests.

Claude uses `/codex-team:orchestrate`: it reads the project, splits the work into tasks with disjoint files, sends briefs to Codex workers in parallel, reads the real diffs, runs the checks, and returns problems to the same Codex thread.

### As a Workflow

```
/codex-team:workflow
Задача:       what to build or change, with all requirements
Папка:        /absolute/project/path        (default: current project)
Проверка:     npm test                      (default: planner finds one)
Исполнители:  codex | claude | mixed        (default: codex)
Codex:        модель=<slug>, effort=<level> (default: your routing)
Claude:       модель=opus|sonnet|haiku|fable, effort=low|medium|high|xhigh|max
Параллельно:  3        Правок: 2
Ревью:        sonnet                        (model for review agents)
```

Every field except the task may be omitted. Free text is read as the task. The card is the same format Claude uses to launch the Workflow, so you and Claude speak the same language. Field names are Russian by design; the values and the rest are language-neutral.

### First run: routing

If no routing exists, Claude asks which model and level to use per task tier and saves it to `~/.config/codex-team/routing.json`:

```bash
bash "<plugin dir>/scripts/codex-job.sh" routing          # show
bash "<plugin dir>/scripts/codex-job.sh" routing --ack    # mark current catalog models as known
```

Example of a routing: simple → a cheap model, standard → a strong model at `high`, complex → the same model at `xhigh`; expensive models in `avoid`.

## Components

| Component | Name | What it does |
|---|---|---|
| Agent | `codex-team:codex-worker` | Relays one brief to Codex, waits, returns the report and `THREAD_ID`. Brief lines: `THREAD_ID:`, `MODEL:`, `EFFORT:`, `SANDBOX:`. |
| Skill | `/codex-team:orchestrate` | Claude as architect and reviewer over Codex workers. |
| Skill | `/codex-team:workflow` | Runs `workflows/codex-team.js` from the launch card. |
| Script | `scripts/codex-job.sh` | `start`, `wait`, `log`, `cancel`, `list`, `models`, `routing`, `usage`. Jobs live in `~/.cache/codex-team/jobs`. |
| Hook | SessionStart | Injects the live model list and your routing into the session. |

### Workflow arguments

`task`, `cwd` (absolute), `pluginRoot` are required, plus `routing` (the output of `codex-job.sh routing --json`) unless both `codexModel` and `codexEffort` are given. Optional: `check`, `executors`, `codexModel`, `codexEffort`, `claudeModel`, `claudeEffort`, `maxParallel` (3), `maxFixRounds` (2), `reviewModel`.

Use it from your own workflow scripts:

```js
await workflow({scriptPath: '<plugin dir>/workflows/codex-team.js'}, {task, cwd, pluginRoot, routing})
// or mix agents directly
agent(brief, {model: 'opus', effort: 'high'})                                   // Claude
agent('MODEL: <slug>\nEFFORT: <level>\n' + brief, {agentType: 'codex-team:codex-worker'})  // Codex
```

## Notes and limits

- Codex runs with the sandbox and approval settings from your `~/.codex/config.toml` unless a brief sets `SANDBOX:`. Check them before running on a project you care about.
- Parallel workers share one working tree; the planner gives them disjoint files. For overlapping work use git worktrees.
- Each Codex worker consumes your ChatGPT plan's Codex limits.
- Claude Desktop's Workflow card shows no token counts; Codex tokens appear in the Workflow log, reports and `codex-job.sh usage`.
- A Workflow started in a session that was opened before the plugin was installed still works (it reads the agent definition from disk); direct `Agent` calls to `codex-team:codex-worker` need a new session.

## License

MIT
