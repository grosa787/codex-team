export const meta = {
  name: 'codex-team',
  description: 'Claude plans and reviews; Codex and/or Claude agents implement, any model and reasoning level; fix rounds',
  whenToUse: 'Implement a multi-part coding task with OpenAI Codex (and optionally Claude) agents as executors and Claude as architect and reviewer',
  phases: [
    { title: 'Plan', detail: 'Claude splits the task into self-contained briefs, picks executor, model and reasoning level per task' },
    { title: 'Build', detail: 'Codex/Claude agents implement each brief, Claude reviews it, fixes go back to the same executor' },
    { title: 'Integrate', detail: 'Claude checks the combined result; one fix round if needed' },
  ],
}

// args: { task, cwd, pluginRoot, routing, check?, executors?: 'codex'|'mixed'|'claude',
//         codexModel?, codexEffort?, claudeModel?, claudeEffort?, maxParallel?, maxFixRounds?, reviewModel? }
// routing: output of `codex-job.sh routing --json` - {tiers: {simple|standard|complex: {model, effort}}, avoid: [], notes}
const A = args || {}
if (typeof A.task !== 'string' || !A.task.trim()) throw new Error('args.task (string) is required')
if (typeof A.cwd !== 'string' || !A.cwd.startsWith('/')) throw new Error('args.cwd (absolute path) is required')
if (typeof A.pluginRoot !== 'string' || !A.pluginRoot.startsWith('/')) throw new Error('args.pluginRoot (absolute path of the codex-team plugin) is required')
const EXECUTORS = A.executors || 'codex'
if (!['codex', 'mixed', 'claude'].includes(EXECUTORS)) throw new Error(`args.executors must be codex, mixed or claude, got ${EXECUTORS}`)
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const TIERS = ['simple', 'standard', 'complex']
const R = A.routing
if (EXECUTORS !== 'claude' && !(A.codexModel && A.codexEffort)) {
  if (!R || !R.tiers || !TIERS.every((k) => R.tiers[k] && R.tiers[k].model && R.tiers[k].effort)) {
    throw new Error('args.routing is required for Codex executors: run `codex-job.sh routing`; if it is not configured, ask the user and save it with `codex-job.sh routing --set`')
  }
}
const MAX_PARALLEL = A.maxParallel || 3
const MAX_FIX = A.maxFixRounds === undefined ? 2 : A.maxFixRounds
const reviewOpts = A.reviewModel ? { model: A.reviewModel } : {}
const JOB = `${A.pluginRoot}/scripts/codex-job.sh`

const WORKER_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['completed', 'failed', 'timeout', 'cancelled', 'crashed', 'error'] },
    threadId: { type: 'string', description: 'Codex THREAD_ID from the report, or "unknown" (Claude executors: "none")' },
    tokens: {
      type: 'object',
      description: 'Codex only: numbers from the TOKENS line of the report',
      properties: { input: { type: 'integer' }, cached: { type: 'integer' }, output: { type: 'integer' }, reasoning: { type: 'integer' } },
      required: ['input', 'cached', 'output', 'reasoning'],
    },
    report: { type: 'string', description: 'Full report: for Codex the unshortened codex-job.sh output; for Claude what changed, commands run and results' },
  },
  required: ['status', 'threadId', 'report'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    issues: { type: 'array', items: { type: 'string' }, description: 'Concrete problems with file:line or command + output; empty when pass' },
    evidence: { type: 'string', description: 'What you ran and read, with key output' },
  },
  required: ['verdict', 'issues', 'evidence'],
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    checkCommand: { type: 'string', description: 'Command that builds/tests the whole project, or empty string if there is none' },
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          brief: { type: 'string', description: 'Complete self-contained brief for the executor' },
          files: { type: 'array', items: { type: 'string' }, description: 'Files/dirs (relative to cwd) this task may create or edit' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          executor: { type: 'string', enum: ['codex', 'claude'] },
          tier: { type: 'string', enum: TIERS, description: 'How hard the task is; picks the Codex model from the routing' },
          model: { type: 'string', description: 'Claude: opus, sonnet, haiku or fable. Codex: "" to take the routing default for the tier, or a slug to override it' },
          effort: { type: 'string', description: 'Claude: reasoning level. Codex: "" for the routing default, or a level to override it' },
          why: { type: 'string', description: 'Why this tier, and why any override of the routing default ("" if none)' },
        },
        required: ['id', 'title', 'brief', 'files', 'dependsOn', 'executor', 'tier', 'model', 'effort', 'why'],
      },
    },
  },
  required: ['summary', 'checkCommand', 'tasks'],
}

// ---------- Plan ----------
const executorRule = {
  codex: 'Every task uses executor "codex".',
  claude: 'Every task uses executor "claude".',
  mixed: 'Choose per task: "codex" or "claude", whichever fits the task better (for example Claude for delicate design/prose work, Codex for bulk implementation). Use both where it makes sense.',
}[EXECUTORS]

phase('Plan')
const plan = await agent(
  `You are the software architect. Executor agents implement; you only plan.

Project directory: ${A.cwd}
Task from the user:
${A.task}
${A.check ? `\nThe user's check command for the whole project: ${A.check}\n` : ''}
Read the project enough to plan well: structure, conventions, and the real build/test/lint commands. Do not edit any files.

Available executors:
- "codex": OpenAI Codex. The user's routing gives the default model and reasoning level per task tier: ${JSON.stringify(R ? { tiers: R.tiers, avoid: R.avoid, notes: R.notes } : null)}. Leave model/effort "" to use the default. Override them only when this task in this project really needs a stronger model or more reasoning (or a cheaper one clearly suffices), and say why in "why". Never pick a model from "avoid". Valid Codex models and levels right now: run \`bash "${JOB}" models\`.${A.codexModel ? `. The user fixed the model to ${A.codexModel}.` : ''}${A.codexEffort ? ` The user fixed the reasoning level to ${A.codexEffort}.` : ''}
- "claude": a Claude agent. Models: opus, sonnet, haiku, fable. Reasoning levels: ${CLAUDE_EFFORTS.join(', ')}.${A.claudeModel ? ` The user asked for model ${A.claudeModel}.` : ''}${A.claudeEffort ? ` The user asked for reasoning level ${A.claudeEffort}.` : ''}
${executorRule}

Split the task into 1-6 tasks. Rules:
- Each task is one coherent change with a checkable finish line. Do not over-split: tightly coupled work belongs in one task.
- "files" lists every file or directory (relative to the project directory) the task may create or edit. Tasks that touch the same file must be ordered with dependsOn.
- A task that needs another task's result lists it in dependsOn.
- "tier": simple (mechanical, well-specified edits), standard (ordinary feature work), complex (hard logic, architecture, subtle bugs). Be honest: overrating wastes the user's tokens, underrating costs quality.
- Claude executors: set "model" and "effort" explicitly (what the user asked for, otherwise your choice by tier).
- "brief" is self-contained (the executor sees nothing else) and follows this shape:
  Goal: ...
  Context: relevant files, patterns to follow, why
  Scope: you may edit <files>; do not touch anything else
  Constraints: ...
  Acceptance criteria: a list of checkable statements
  Check with: exact command(s)
- checkCommand: the command that builds/tests the whole project, or "" if there is none.`,
  { label: 'Claude architect', phase: 'Plan', schema: PLAN_SCHEMA },
)
if (!plan) throw new Error('planning agent returned nothing')

const ids = new Set()
for (const t of plan.tasks) {
  if (ids.has(t.id)) throw new Error(`duplicate task id in plan: ${t.id}`)
  ids.add(t.id)
  if (EXECUTORS !== 'mixed' && t.executor !== EXECUTORS) throw new Error(`task ${t.id} uses executor ${t.executor}, but executors=${EXECUTORS}`)
  // User-given choices win over the planner's.
  if (t.executor === 'codex') {
    const route = R && R.tiers && R.tiers[t.tier]
    const planned = { model: t.model, effort: t.effort }
    t.model = A.codexModel || t.model || (route && route.model)
    t.effort = A.codexEffort || t.effort || (route && route.effort)
    if (!t.model || !t.effort) throw new Error(`task ${t.id}: no Codex model/effort for tier ${t.tier}`)
    if (!A.codexModel && R && (R.avoid || []).includes(t.model)) throw new Error(`task ${t.id}: planner chose ${t.model}, which the user's routing says to avoid`)
    t.override = !A.codexModel && !A.codexEffort && (planned.model || planned.effort) && route
      ? `routing default ${route.model}/${route.effort} overridden: ${t.why}` : ''
  } else {
    if (!t.model) throw new Error(`task ${t.id}: Claude executor needs an explicit model`)
    t.model = A.claudeModel || t.model
    t.effort = A.claudeEffort || t.effort
    if (t.effort && !CLAUDE_EFFORTS.includes(t.effort)) throw new Error(`task ${t.id}: Claude reasoning level must be one of ${CLAUDE_EFFORTS.join(', ')}, got ${t.effort}`)
  }
}
for (const t of plan.tasks) {
  for (const d of t.dependsOn) if (!ids.has(d)) throw new Error(`task ${t.id} depends on unknown task ${d}`)
}
const who = (t) => `${t.executor === 'codex' ? 'Codex' : 'Claude'} ${t.model}${t.effort ? `/${t.effort}` : ''}`

// Codex tokens are not in Claude's own counters, so they are logged and summed here.
const codexTokens = {}
const fmt = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)
function countTokens(t, w) {
  if (t.executor !== 'codex' || !w || !w.tokens) return ''
  const k = `${t.model}/${t.effort}`
  const acc = codexTokens[k] || (codexTokens[k] = { runs: 0, input: 0, cached: 0, output: 0, reasoning: 0 })
  acc.runs++
  for (const f of ['input', 'cached', 'output', 'reasoning']) acc[f] += w.tokens[f]
  return `, tokens in ${fmt(w.tokens.input)} (cached ${fmt(w.tokens.cached)}) out ${fmt(w.tokens.output)} reasoning ${fmt(w.tokens.reasoning)}`
}
log(`Plan: ${plan.tasks.map((t) => `${t.id} [${t.tier}] → ${who(t)}`).join(', ')}. ${plan.summary}`)
for (const t of plan.tasks) if (t.override) log(`${t.id}: ${t.override}`)

// ---------- Executors ----------
// Codex workers follow the plugin's agent definition read from disk, so the
// workflow runs even in sessions started before the plugin's agents loaded.
const RELAY = `You are the codex-worker relay. First read ${A.pluginRoot}/agents/codex-worker.md and follow its instructions exactly; in that file \${CLAUDE_PLUGIN_ROOT} means ${A.pluginRoot}. Your brief follows.\n\n`

function execute(t, brief, label, phase, threadId) {
  if (t.executor === 'codex') {
    const header = [
      threadId ? `THREAD_ID: ${threadId}` : '',
      t.model ? `MODEL: ${t.model}` : '',
      t.effort ? `EFFORT: ${t.effort}` : '',
    ].filter(Boolean).join('\n')
    return agent(`${RELAY}${header ? `${header}\n` : ''}Working directory: ${A.cwd}\n\n${brief}`, { label, phase, model: 'sonnet', schema: WORKER_SCHEMA })
  }
  const opts = { label, phase, schema: WORKER_SCHEMA }
  if (t.model) opts.model = t.model
  if (t.effort) opts.effort = t.effort
  return agent(
    `Working directory: ${A.cwd}\n\n${brief}\n\nImplement this yourself, within the scope above, and run the checks. Do not commit. Return status "completed" when done (or "failed" if you could not), threadId "none", and in report: files changed, commands run with their results, anything unfinished or uncertain.`,
    opts,
  )
}

// ---------- Build ----------
const overlaps = (a, b) => a === b || a.startsWith(b.replace(/\/$/, '') + '/') || b.startsWith(a.replace(/\/$/, '') + '/')
const canResume = (t, w) => t.executor === 'codex' && w.threadId && w.threadId !== 'unknown'

const reviewPrompt = (t, w) => `You review a change that an agent (${who(t)}) made. Do not edit any files.

Project directory: ${A.cwd}
Task "${t.title}" - the brief the agent received:
${t.brief}

Files in this task's scope: ${t.files.join(', ')}
Other agents may be editing other files at the same time: judge only this task's scope.

The agent's report (a claim, not proof):
${w.report}

Verify independently: read the actual diff and new files in scope (git diff / git status), run the check commands from the brief and read their output, and test each acceptance criterion. Look for stubs, TODOs, deleted or weakened tests, hard-coded expected values, silent fallbacks, and edits outside the scope.
verdict "pass" only when every criterion is met and you have the evidence. Otherwise "fail" with concrete, actionable issues (file:line, or command and its output).`

async function runTask(t) {
  const base = { id: t.id, title: t.title, executor: who(t), tier: t.tier, why: t.why }
  let w = await execute(t, t.brief, `${who(t)} · ${t.id}`, 'Build')
  for (let round = 0; ; round++) {
    if (!w) return { ...base, status: 'worker-error', rounds: round }
    log(`${who(t)} ${t.id}${round ? ` (fix ${round})` : ''}: ${w.status}${t.executor === 'codex' ? `, thread ${w.threadId}${countTokens(t, w) || ', tokens n/a'}` : ''}`)
    if (w.status !== 'completed') return { ...base, status: `${t.executor}-${w.status}`, rounds: round, threadId: w.threadId, report: w.report }
    const r = await agent(reviewPrompt(t, w), { label: `Claude review · ${t.id}`, phase: 'Build', schema: REVIEW_SCHEMA, ...reviewOpts })
    if (!r) return { ...base, status: 'review-error', rounds: round, threadId: w.threadId }
    log(`Claude review ${t.id}: ${r.verdict}${r.issues.length ? ` (${r.issues.length} issue(s))` : ''}`)
    if (r.verdict === 'pass') return { ...base, status: 'passed', rounds: round, threadId: w.threadId, evidence: r.evidence }
    if (round >= MAX_FIX) return { ...base, status: 'failed-review', rounds: round, threadId: w.threadId, issues: r.issues, evidence: r.evidence }
    log(`${t.id}: fix round ${round + 1}/${MAX_FIX}`)
    const issues = r.issues.map((x, i) => `${i + 1}. ${x}`).join('\n')
    w = canResume(t, w)
      ? await execute(t, `The reviewer found problems with your change for "${t.title}". Fix all of them within the same scope, re-run the checks, and report.\n\n${issues}`, `${who(t)} fix ${round + 1} · ${t.id}`, 'Build', w.threadId)
      : await execute(t, `${t.brief}\n\nAn earlier attempt at this task was reviewed and these problems must be fixed:\n${issues}`, `${who(t)} fix ${round + 1} · ${t.id}`, 'Build')
  }
}

phase('Build')
const results = new Map()
let pending = plan.tasks.slice()
while (pending.length) {
  const wave = []
  const usedFiles = []
  for (const t of pending) {
    if (wave.length >= MAX_PARALLEL) break
    if (!t.dependsOn.every((d) => results.has(d))) continue
    if (t.files.some((f) => usedFiles.some((u) => overlaps(f, u)))) continue
    wave.push(t)
    usedFiles.push(...t.files)
  }
  if (!wave.length) throw new Error(`dependency cycle in plan among: ${pending.map((t) => t.id).join(', ')}`)
  pending = pending.filter((t) => !wave.includes(t))

  const runnable = []
  for (const t of wave) {
    const failedDeps = t.dependsOn.filter((d) => results.get(d).status !== 'passed')
    if (failedDeps.length) {
      results.set(t.id, { id: t.id, title: t.title, executor: who(t), status: 'skipped', reason: `dependencies did not pass: ${failedDeps.join(', ')}` })
      log(`${t.id}: skipped, dependencies did not pass (${failedDeps.join(', ')})`)
    } else runnable.push(t)
  }
  log(`Wave: ${runnable.map((t) => t.id).join(', ') || '(nothing runnable)'}`)
  const done = await parallel(runnable.map((t) => () => runTask(t)))
  runnable.forEach((t, i) => results.set(t.id, done[i] || { id: t.id, title: t.title, executor: who(t), status: 'error' }))
}
const taskResults = plan.tasks.map((t) => results.get(t.id))

// ---------- Integrate ----------
phase('Integrate')
const integratePrompt = `You check the combined result of several agents' changes. Do not edit any files.

Project directory: ${A.cwd}
Original task from the user:
${A.task}

Planned tasks and their outcomes:
${taskResults.map((r) => `- ${r.id} "${r.title}" (${r.executor}): ${r.status}`).join('\n')}

Run the whole-project check ${plan.checkCommand ? `(\`${plan.checkCommand}\`)` : '(find the project\'s build/test commands)'}, read the full diff (git status, git diff), and judge whether the original task is done as a whole: pieces fit together, nothing missing, nothing broken elsewhere.
verdict "pass" only with evidence. Otherwise "fail" with concrete, actionable issues.`

let integration = await agent(integratePrompt, { label: 'Claude integration check', phase: 'Integrate', schema: REVIEW_SCHEMA, ...reviewOpts })
let integrationFix = null
if (integration && integration.verdict === 'fail' && taskResults.every((r) => r.status === 'passed')) {
  log(`Integration found ${integration.issues.length} issue(s); one fix round`)
  const fixer = EXECUTORS === 'claude'
    ? { executor: 'claude', model: A.claudeModel || 'sonnet', effort: A.claudeEffort || '' }
    : { executor: 'codex', model: A.codexModel || R.tiers.standard.model, effort: A.codexEffort || R.tiers.standard.effort }  // R is validated above unless both are given
  integrationFix = await execute(
    fixer,
    `Goal: fix these integration problems in the project so the whole task below works end to end.\n\nOriginal task:\n${A.task}\n\nProblems found by the reviewer:\n${integration.issues.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\nCheck with: ${plan.checkCommand || 'the project\'s build and test commands'}`,
    `${who(fixer)} · integration fix`,
    'Integrate',
  )
  log(`${who(fixer)} integration fix: ${integrationFix ? integrationFix.status : 'error'}${countTokens(fixer, integrationFix)}`)
  integration = await agent(integratePrompt, { label: 'Claude integration recheck', phase: 'Integrate', schema: REVIEW_SCHEMA, ...reviewOpts })
}

for (const [k, v] of Object.entries(codexTokens)) {
  log(`Codex ${k}: ${v.runs} run(s), tokens in ${fmt(v.input)} (cached ${fmt(v.cached)}) out ${fmt(v.output)} reasoning ${fmt(v.reasoning)}`)
}

return {
  codexTokens,
  summary: plan.summary,
  checkCommand: plan.checkCommand,
  tasks: taskResults,
  integration,
  integrationFix: integrationFix && { status: integrationFix.status, threadId: integrationFix.threadId },
}
