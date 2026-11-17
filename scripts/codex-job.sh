#!/usr/bin/env bash
# Run OpenAI Codex CLI tasks as detached background jobs.
# A job survives the caller's tool timeout; `wait` blocks for a bounded time
# and can be called again until the job finishes.
set -euo pipefail

JOBS_DIR="${CODEX_TEAM_JOBS_DIR:-$HOME/.cache/codex-team/jobs}"
CODEX_CONFIG="${CODEX_HOME:-$HOME/.codex}/config.toml"
ROUTING_FILE="${CODEX_TEAM_ROUTING:-$HOME/.config/codex-team/routing.json}"

usage() {
  cat <<'EOF'
Usage:
  codex-job.sh start --cd DIR --prompt-file FILE [--model M] [--effort E] [--sandbox S] [--resume THREAD_ID]
      Start a Codex task in DIR. Prints JOB=<id>.
      --model    a Codex model slug from `models` (default: your ~/.codex/config.toml)
      --effort   a reasoning level the model supports, see `models` (default: your config)
      --sandbox  read-only|workspace-write|danger-full-access (default: your config)
      --resume   continue an earlier Codex thread (keeps its context) with FILE as the next message
  codex-job.sh wait JOB [--timeout SECONDS]
      Block until the job ends or SECONDS pass (default 540). Prints a report.
      If it prints STATUS: running, call wait again.
  codex-job.sh log JOB      Codex messages and commands so far (progress / debugging)
  codex-job.sh cancel JOB   Stop a running job
  codex-job.sh list         All jobs and their state
  codex-job.sh models [--json|--context]
      Live Codex model catalog (`codex debug models`): models, reasoning levels, defaults
  codex-job.sh routing [--json | --set | --ack]
      Which Codex model/level to use for simple, standard and complex tasks, and models to avoid.
      --set reads JSON from stdin: {"tiers":{"simple":{"model":..,"effort":..},"standard":{..},"complex":{..}},"avoid":[..],"notes":".."}
            and records the current catalog as known models.
      --ack marks every model now in the catalog as known (after the user decided about new ones).
      Without options it also lists models that appeared since, and routed models that disappeared.
  codex-job.sh usage [--since YYYY-MM-DD]
      Codex tokens spent by these jobs, per model
EOF
}

die() { echo "codex-job: $*" >&2; exit 2; }

job_dir() {
  local dir="$JOBS_DIR/$1"
  [[ -d "$dir" ]] || die "no such job: $1"
  echo "$dir"
}

job_state() {
  local dir="$1"
  if [[ -f "$dir/cancelled" ]]; then echo cancelled
  elif [[ -f "$dir/exit_code" ]]; then
    if [[ "$(cat "$dir/exit_code")" == 0 ]]; then echo completed; else echo failed; fi
  elif kill -0 "$(cat "$dir/pid")" 2>/dev/null; then echo running
  else echo crashed
  fi
}

# Top-level key from the Codex config (before any [section]); empty if unset.
config_value() {
  [[ -f "$CODEX_CONFIG" ]] || return 0
  awk -v k="$1" '/^\[/{exit} $0 ~ "^"k"[ \t]*=" {sub(/^[^=]*=[ \t]*/, ""); gsub(/"/, ""); print; exit}' "$CODEX_CONFIG"
}

catalog() {
  command -v codex >/dev/null || die "codex CLI not found in PATH. Install it (npm i -g @openai/codex) and run: codex login"
  codex debug models
}

cmd_models() {
  local mode="${1:-table}" cat
  cat="$(catalog)"
  case "$mode" in
    --json) jq '[.models[] | select(.visibility=="list") | {slug, display_name, description, default_reasoning_level, reasoning_levels: [.supported_reasoning_levels[].effort]}]' <<<"$cat" ;;
    table|--context)
      if [[ "$mode" == --context ]]; then
        echo "codex-team plugin: OpenAI Codex models available right now (live from the local Codex CLI catalog)."
        echo "Run one with the Agent tool, subagent_type \"codex-team:codex-worker\", putting \"MODEL: <slug>\" and \"EFFORT: <level>\" lines at the top of the brief; in Workflow scripts use agent(brief, {agentType: 'codex-team:codex-worker'}). Omitted lines use the user's Codex config."
      fi
      echo "Codex config default: model=$(config_value model) effort=$(config_value model_reasoning_effort)"
      if [[ "$mode" == --context ]]; then
        if [[ -f "$ROUTING_FILE" ]]; then
          echo "The user's Codex routing: the default model/level per task tier. Raise the model or level for a task that needs it (say why); never use 'avoid' models unless the user asks:"
          jq -c 'del(.knownModels)' "$ROUTING_FILE"
          local changes; changes="$(routing_changes)"
          if [[ -n "$changes" ]]; then
            echo "$changes"
            echo "Before the next Codex run: look up these models' prices and benchmarks (OpenAI announcements, pricing page), compare with the routed models, and tell the user. If a new model is cheaper and stronger than a routed one, you may use it for that tier and ask the user whether to save it in the routing (codex-job.sh routing --set). Afterwards run codex-job.sh routing --ack."
          fi
        else
          echo "Codex routing is NOT configured yet. Before the first Codex run, ask the user which Codex model and reasoning level to use for simple, standard and complex tasks (and which models to avoid), then save it with: codex-job.sh routing --set"
        fi
      fi
      jq -r '.models[] | select(.visibility=="list") | "- \(.slug): levels \([.supported_reasoning_levels[].effort] | join("/")) (default \(.default_reasoning_level)). \(.description)"' <<<"$cat"
      ;;
    *) die "unknown option for models: $mode" ;;
  esac
}

# Fail early, with the valid choices, on a model or reasoning level Codex does not offer.
validate_choice() {
  local model="$1" effort="$2" cat m levels
  [[ -z "$model$effort" ]] && return 0
  cat="$(catalog)"
  if [[ -n "$model" ]] && ! jq -e --arg m "$model" '.models[] | select(.slug==$m)' <<<"$cat" >/dev/null; then
    die "unknown Codex model '$model'. Available: $(jq -r '[.models[] | select(.visibility=="list") | .slug] | join(", ")' <<<"$cat")"
  fi
  [[ -z "$effort" ]] && return 0
  m="${model:-$(config_value model)}"
  levels="$(jq -r --arg m "$m" '.models[] | select(.slug==$m) | [.supported_reasoning_levels[].effort] | join(" ")' <<<"$cat")"
  if [[ -z "$levels" ]]; then
    echo "codex-job: model '$m' is not in the Codex catalog (custom provider?); reasoning level '$effort' is passed through unchecked" >&2
    return 0
  fi
  [[ " $levels " == *" $effort "* ]] || die "model '$m' does not support reasoning level '$effort'. Supported: $levels"
}

# Models in the catalog that the routing has not seen, and routed models gone from the catalog.
routing_changes() {
  local cat; cat="$(catalog)"
  jq -r --slurpfile r "$ROUTING_FILE" '
    ($r[0].knownModels // []) as $known
    | [.models[] | select(.visibility=="list") | .slug] as $now
    | (.models[] | select(.visibility=="list" and ((.slug as $s | $known | index($s)) | not))
        | "NEW MODEL since routing was saved: \(.slug) - levels \([.supported_reasoning_levels[].effort] | join("/")). \(.description)"),
      ($r[0].tiers | to_entries[] | select((.value.model as $m | $now | index($m)) | not)
        | "ROUTED MODEL GONE from the catalog: \(.key) uses \(.value.model)")' <<<"$cat"
}

cmd_routing() {
  case "${1:-}" in
    "")
      if [[ -f "$ROUTING_FILE" ]]; then
        jq -r '"simple:   \(.tiers.simple.model) / \(.tiers.simple.effort)",
               "standard: \(.tiers.standard.model) / \(.tiers.standard.effort)",
               "complex:  \(.tiers.complex.model) / \(.tiers.complex.effort)",
               "avoid:    \(.avoid | join(", "))",
               "notes:    \(.notes // "")"' "$ROUTING_FILE"
        routing_changes
      else
        echo "NOT CONFIGURED ($ROUTING_FILE). Ask the user, then: codex-job.sh routing --set"
      fi ;;
    --json) if [[ -f "$ROUTING_FILE" ]]; then cat "$ROUTING_FILE"; else echo null; fi ;;
    --set)
      local new tier m e
      new="$(cat)"
      jq -e '.tiers.simple and .tiers.standard and .tiers.complex and (.avoid | type == "array")' <<<"$new" >/dev/null \
        || die "routing needs tiers.simple, tiers.standard, tiers.complex (each {model, effort}) and an avoid array"
      for tier in simple standard complex; do
        m="$(jq -r --arg t "$tier" '.tiers[$t].model' <<<"$new")"
        e="$(jq -r --arg t "$tier" '.tiers[$t].effort' <<<"$new")"
        validate_choice "$m" "$e"
      done
      mkdir -p "$(dirname "$ROUTING_FILE")"
      jq --argjson known "$(catalog | jq '[.models[] | select(.visibility=="list") | .slug]')" '. + {knownModels: $known}' <<<"$new" > "$ROUTING_FILE"
      echo "Saved $ROUTING_FILE"
      cmd_routing ;;
    --ack)
      [[ -f "$ROUTING_FILE" ]] || die "routing is not configured"
      local tmp; tmp="$(mktemp)"
      jq --argjson known "$(catalog | jq '[.models[] | select(.visibility=="list") | .slug]')" '.knownModels = $known' "$ROUTING_FILE" > "$tmp"
      mv "$tmp" "$ROUTING_FILE"
      echo "All current Codex models marked as known." ;;
    *) die "unknown option for routing: $1" ;;
  esac
}

cmd_usage() {
  local since=""
  [[ "${1:-}" == --since ]] && since="${2//-/}"
  [[ -d "$JOBS_DIR" ]] || { echo "No jobs yet."; return 0; }
  local dir id
  for dir in "$JOBS_DIR"/*/; do
    dir="${dir%/}"; id="$(basename "$dir")"
    [[ -n "$since" && "${id%%-*}" < "$since" ]] && continue
    [[ -f "$dir/events.jsonl" && -f "$dir/model" ]] || continue
    jq -c --arg m "$(cat "$dir/model")" 'select(.type=="turn.completed") | {m: $m, u: .usage}' "$dir/events.jsonl"
  done | jq -rs '
    group_by(.m)[] | {m: .[0].m, runs: length,
      input: (map(.u.input_tokens) | add), cached: (map(.u.cached_input_tokens) | add),
      output: (map(.u.output_tokens) | add), reasoning: (map(.u.reasoning_output_tokens) | add)}
    | "\(.m): runs=\(.runs) input=\(.input) (cached \(.cached)) output=\(.output) reasoning=\(.reasoning)"'
}

cmd_start() {
  local cwd="" prompt_file="" model="" effort="" sandbox="" resume=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cd) cwd="$2"; shift 2 ;;
      --prompt-file) prompt_file="$2"; shift 2 ;;
      --model) model="$2"; shift 2 ;;
      --effort) effort="$2"; shift 2 ;;
      --sandbox) sandbox="$2"; shift 2 ;;
      --resume) resume="$2"; shift 2 ;;
      *) die "unknown option for start: $1" ;;
    esac
  done
  [[ -n "$cwd" ]] || die "--cd is required"
  [[ -d "$cwd" ]] || die "directory not found: $cwd"
  [[ -n "$prompt_file" && -s "$prompt_file" ]] || die "--prompt-file must be an existing non-empty file"
  command -v codex >/dev/null || die "codex CLI not found in PATH. Install it (npm i -g @openai/codex) and run: codex login"
  command -v jq >/dev/null || die "jq not found in PATH"
  validate_choice "$model" "$effort"
  cwd="$(cd "$cwd" && pwd)"

  local id dir
  id="$(date +%Y%m%d-%H%M%S)-$$-$RANDOM"
  dir="$JOBS_DIR/$id"
  mkdir -p "$dir"
  cp "$prompt_file" "$dir/prompt.md"
  echo "$cwd" > "$dir/cwd"
  echo "model=${model:-$(config_value model)} effort=${effort:-$(config_value model_reasoning_effort)}" > "$dir/model"
  date +%s > "$dir/started_at"

  local args=(exec)
  [[ -n "$resume" ]] && args+=(resume)
  args+=(--json --skip-git-repo-check -o "$dir/last_message.md")
  [[ -n "$model" ]] && args+=(-m "$model")
  [[ -n "$effort" ]] && args+=(-c "model_reasoning_effort=\"$effort\"")
  if [[ -n "$sandbox" ]]; then
    if [[ -n "$resume" ]]; then args+=(-c "sandbox_mode=\"$sandbox\""); else args+=(-s "$sandbox"); fi
  fi
  if [[ -n "$resume" ]]; then
    echo "$resume" > "$dir/resumed_thread"
    args+=("$resume" -)
  else
    args+=(-C "$cwd" -)
  fi

  (
    trap '' HUP
    cd "$cwd"
    set +e
    codex "${args[@]}" < "$dir/prompt.md" > "$dir/events.jsonl" 2> "$dir/stderr.log"
    echo $? > "$dir/exit_code"
  ) </dev/null >/dev/null 2>&1 &
  echo $! > "$dir/pid"
  disown

  echo "JOB=$id"
  echo "CWD=$cwd"
}

report() {
  local id="$1" dir="$2" state="$3" ev="$2/events.jsonl"
  local started now
  started="$(cat "$dir/started_at")"; now="$(date +%s)"
  echo "STATUS: $state"
  echo "JOB: $id"
  echo "CWD: $(cat "$dir/cwd")"
  [[ -f "$dir/model" ]] && echo "CODEX: $(cat "$dir/model")"
  echo "ELAPSED_SECONDS: $((now - started))"
  [[ -f "$ev" ]] || { echo "No Codex output yet."; return; }

  local thread
  thread="$(jq -r 'select(.type=="thread.started") | .thread_id' "$ev" | head -n1)"
  [[ -z "$thread" && -f "$dir/resumed_thread" ]] && thread="$(cat "$dir/resumed_thread")"
  echo "THREAD_ID: ${thread:-unknown}   (send follow-ups with: start --resume ${thread:-<id>})"
  [[ "$state" == running ]] && return

  [[ -f "$dir/exit_code" ]] && echo "EXIT_CODE: $(cat "$dir/exit_code")"
  echo "TOKENS: $(jq -r 'select(.type=="turn.completed") | .usage | "input=\(.input_tokens) cached=\(.cached_input_tokens) output=\(.output_tokens) reasoning=\(.reasoning_output_tokens)"' "$ev" | tail -n1)"
  echo "COMMANDS_RUN: $(jq -c 'select(.type=="item.completed" and .item.type=="command_execution")' "$ev" | wc -l | tr -d ' ')"

  echo "FAILED_COMMANDS (non-zero exit, last 10):"
  jq -r 'select(.type=="item.completed" and .item.type=="command_execution" and .item.exit_code != 0 and .item.exit_code != null)
         | "  [exit \(.item.exit_code)] \(.item.command | .[0:200])"' "$ev" | tail -n10

  echo "FILES_EDITED_BY_CODEX_PATCHES:"
  jq -r 'select(.type=="item.completed" and .item.type=="file_change") | .item.changes[] | "  \(.kind) \(.path)"' "$ev" | sort -u

  local errors
  errors="$(jq -r 'select(.type=="turn.failed" or .type=="error") | (.error.message // .message // tostring)' "$ev")"
  [[ -n "$errors" ]] && { echo "CODEX_ERRORS:"; echo "$errors" | sed 's/^/  /'; }

  local cwd; cwd="$(cat "$dir/cwd")"
  if git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "GIT_STATUS (whole working tree, may include other workers' changes):"
    git -C "$cwd" status --short | sed 's/^/  /'
  fi

  echo "----- CODEX FINAL MESSAGE -----"
  if [[ -s "$dir/last_message.md" ]]; then cat "$dir/last_message.md"; else echo "(Codex produced no final message)"; fi
  echo
  echo "----- END -----"
  if [[ "$state" != completed ]]; then
    echo "STDERR (last 20 lines):"
    tail -n20 "$dir/stderr.log" | sed 's/^/  /'
  fi
}

cmd_wait() {
  [[ $# -ge 1 ]] || die "wait needs a JOB id"
  local id="$1" timeout=540; shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --timeout) timeout="$2"; shift 2 ;;
      *) die "unknown option for wait: $1" ;;
    esac
  done
  local dir state deadline
  dir="$(job_dir "$id")"
  deadline=$(( $(date +%s) + timeout ))
  while :; do
    state="$(job_state "$dir")"
    [[ "$state" != running ]] && break
    (( $(date +%s) >= deadline )) && break
    sleep 5
  done
  report "$id" "$dir" "$state"
  if [[ "$state" == running ]]; then
    echo "LATEST CODEX ACTIVITY:"
    progress_lines "$dir" | tail -n8 | cut -c1-240 | sed 's/^/  /'
    echo "Job still running. Call: codex-job.sh wait $id"
  fi
  return 0
}

progress_lines() {
  [[ -f "$1/events.jsonl" ]] || return 0
  jq -r 'select(.type=="item.completed") | .item
         | if .type=="agent_message" then "codex: \(.text)"
           elif .type=="command_execution" then "$ \(.command | .[0:200])  [exit \(.exit_code)]"
           elif .type=="file_change" then "edit: \([.changes[] | .path] | join(", "))"
           else "\(.type)" end' "$1/events.jsonl"
}

cmd_log() {
  [[ $# -eq 1 ]] || die "log needs a JOB id"
  local dir; dir="$(job_dir "$1")"
  echo "STATUS: $(job_state "$dir")"
  [[ -f "$dir/events.jsonl" ]] || { echo "No Codex output yet."; return 0; }
  progress_lines "$dir"
}

cmd_cancel() {
  [[ $# -eq 1 ]] || die "cancel needs a JOB id"
  local dir pid; dir="$(job_dir "$1")"; pid="$(cat "$dir/pid")"
  if [[ "$(job_state "$dir")" != running ]]; then echo "Job $1 is not running ($(job_state "$dir"))."; return 0; fi
  touch "$dir/cancelled"
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true
  echo "Cancelled job $1."
}

cmd_list() {
  [[ -d "$JOBS_DIR" ]] || { echo "No jobs yet."; return 0; }
  local dir
  for dir in "$JOBS_DIR"/*/; do
    [[ -d "$dir" ]] || continue
    dir="${dir%/}"
    printf '%s  %-9s  %s\n' "$(basename "$dir")" "$(job_state "$dir")" "$(cat "$dir/cwd")"
  done
}

[[ $# -ge 1 ]] || { usage; exit 2; }
sub="$1"; shift
case "$sub" in
  start) cmd_start "$@" ;;
  wait) cmd_wait "$@" ;;
  log) cmd_log "$@" ;;
  cancel) cmd_cancel "$@" ;;
  list) cmd_list ;;
  models) cmd_models "$@" ;;
  routing) cmd_routing "$@" ;;
  usage) cmd_usage "$@" ;;
  -h|--help|help) usage ;;
  *) usage; exit 2 ;;
esac
