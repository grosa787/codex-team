---
name: orchestrate
description: Claude as architect and reviewer, OpenAI Codex (the user's local Codex CLI on their ChatGPT subscription) as the implementing agents. Use when the user asks to do work "через Codex", "с помощью Codex/ChatGPT/GPT", "раздели на агентов Codex", "Codex пишет, ты проверяешь", or otherwise wants Codex workers to implement while Claude plans, delegates and verifies.
argument-hint: <task to implement with Codex workers>
---

# Codex team: Claude orchestrates, Codex implements

You are the architect, dispatcher and reviewer. Codex workers write the code. You keep the plan, the quality bar and the final word; Codex's "done" is a claim you check, never a fact.

Task: $ARGUMENTS

## 0. Routing first
Run `bash "${CLAUDE_PLUGIN_ROOT}/scripts/codex-job.sh" routing`. If it says NOT CONFIGURED, run `codex-job.sh models`, ask the user with AskUserQuestion which Codex model and reasoning level to use for simple, standard and complex tasks and which models to avoid (offer only models and levels from that live list; do not guess prices), save it with `codex-job.sh routing --set` (JSON on stdin: `{"tiers":{"simple":{"model":"..","effort":".."},"standard":{..},"complex":{..}},"avoid":[..],"notes":".."}`), and show the result. Do not start Codex before that, unless the user names the model and level for this task. If `codex-job.sh routing` lists NEW MODEL or ROUTED MODEL GONE lines: look up those models' prices and benchmarks (WebSearch: OpenAI announcements and pricing page), compare them with the routed models, and tell the user what you found with sources. If a new model is cheaper and stronger than a routed one, you may use it for that tier in this run, say so, and ask the user (AskUserQuestion) whether to save it in the routing (`routing --set`). Then run `codex-job.sh routing --ack`. Routing tiers are defaults: raise the model or level for a task that needs it, and say why.

## 1. Understand before delegating
Read enough of the project yourself to write precise briefs: structure, conventions, how it is built and tested (find the real test/lint/build commands). Briefs written without this produce wrong code that costs more to review than to write.

## 2. Split the work
- One worker task = one coherent change with a clear finish line (a module, an endpoint plus its tests, a refactor of one area).
- Tasks that run at the same time in the same directory must own **disjoint files**. If two tasks need the same file, run them one after another, or give each its own git worktree (Agent tool `isolation: "worktree"`; the worker then runs Codex inside that worktree and you merge the branches).
- A task that needs another's result waits for it (next wave).
- Small or tightly coupled work is cheaper to do in one task, or yourself, than to split.

## 3. Write each brief
Every brief is self-contained - Codex sees nothing of this conversation:

```
Working directory: <absolute path>
Goal: <what must be true when done>
Context: <relevant files, existing patterns to follow, why this change>
Scope: you may edit <files/dirs>; do not touch <others>
Constraints: <stack, style, no new dependencies, etc.>
Acceptance criteria:
- <checkable statement>
- ...
Check with: <exact command(s)>
MODEL: <slug>             (optional; omit to use the user's Codex config)
EFFORT: <level>           (optional; omit to use the user's Codex config)
```

Pick `MODEL`/`EFFORT` from the routing by how hard the task honestly is (simple / standard / complex), and tell the user which tier and model each task got. Codex models and reasoning levels come from the live catalog - run `bash "${CLAUDE_PLUGIN_ROOT}/scripts/codex-job.sh" models` (the session-start note lists them too). Never assume a list from memory: new models appear there as soon as Codex sees them. Pick per task: light models and levels for routine edits save the user's ChatGPT quota; the strongest model and higher levels for hard ones.

Codex and Claude agents mix freely: a task can go to a Claude subagent instead (Agent tool with `model`), and Claude and Codex workers can run side by side, each reviewed the same way.

## 4. Dispatch
Use the Agent tool with `subagent_type: "codex-team:codex-worker"` and the brief as the prompt. Independent tasks go out together in one message, so they run in parallel. Each returns Codex's report with a `THREAD_ID`.

## 5. Verify every result yourself
For each report:
- Read the actual diff (`git diff`, new files) - not just Codex's summary.
- Run the check commands yourself and read the output.
- Compare against every acceptance criterion; look for scope creep, deleted tests, stubs, TODOs, silent fallbacks, hard-coded test values.

## 6. Send fixes back to the same Codex session
If something is wrong, dispatch `codex-team:codex-worker` again with `THREAD_ID: <id>` on the first line, the working directory, and a concrete list of problems with evidence (failing command and output, file:line). Resuming keeps Codex's context, so the fix brief can be short. After two failed fix rounds on the same problem, fix it yourself or report it to the user - do not loop.

## 7. Integrate and report
When all tasks pass, run the full build/test suite on the combined result. Then tell the user: what each Codex worker did, with its model, level and tokens (the TOKENS line of each report; `codex-job.sh usage` sums them per model), what you had to send back or fix yourself, and the verification evidence (commands and their results). Name anything not verified.

## Notes
- Running many Codex workers at once consumes the ChatGPT plan's limits quickly; 2-4 parallel workers is a sensible default.
- For a fixed plan → build → review → fix pipeline that runs on its own, use `/codex-team:workflow` instead.
- Direct use without a subagent: `bash "${CLAUDE_PLUGIN_ROOT}/scripts/codex-job.sh" --help` (start / wait / log / cancel / list).
