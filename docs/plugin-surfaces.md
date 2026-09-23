# Plugin surface inventory — Serena, Ponytail, Graphify, LightRAG

Read-only research document for the C10-B..E implementation packets (ROADMAP section
3.2). Every claim cites a primary source fetched on **2026-09-16**. Anything not
verifiable from the upstream repo/docs/registry is marked **UNKNOWN** rather than
guessed. Nothing was installed for this document.

Version pins quoted below are the latest releases visible at access time, not
recommendations; C10-B must re-resolve exact versions at implementation.

| | Serena | Ponytail | Graphify | LightRAG |
| --- | --- | --- | --- | --- |
| Kind | MCP tool server (symbol-level code tools) | Ruleset/skill injected into the agent's context | CLI + agent skill building a queryable knowledge graph | RAG framework: Python SDK + REST/WebUI server |
| Package / channel | PyPI `serena-agent` (1.7.0 at access time); also `uvx` from git, source checkout, Docker, Nix | npm `@dietrichgebert/ponytail` (4.10.0), GitHub repo `v4.10.0` tag, per-host plugin marketplaces, plain rule-file copies | PyPI `graphifyy` (0.9.62; command is `graphify`) | PyPI `lightrag-hku` (1.5.7), source checkout, GHCR Docker images (cosign-signed) |
| Runtime deps | Python ≥3.11,<3.15 via `uv`; per-language LSP servers auto-acquired on demand | Node.js on PATH for Claude Code/Codex lifecycle hooks; skills still load without it | Python ≥3.10; tree-sitter grammars bundled as deps | Python ≥3.10; storage backends optional (in-memory defaults are eval-only) |
| Own model calls | None — Serena is a tool provider; the client LLM does the thinking | None — injected text; costs context tokens on the host agent | Code extraction: none (local tree-sitter). Docs/PDF/media semantic pass: a backend is required (assistant's model via the skill, or `--backend` API/CLI/Ollama) | Yes — up to four LLM roles (EXTRACT/KEYWORD/QUERY/VLM) plus embeddings and optional rerank |
| Subscription-capable path | N/A (no model calls of its own) | N/A (inherits the host agent's model) | Yes: `--backend claude-cli` routes through the Claude Code CLI subscription; `--backend ollama` is fully local | Local: `ollama` binding for LLM + embeddings. Subscription reuse (Claude/ChatGPT login): **no documented route** — bindings take API keys, IAM, or local endpoints; Anthropic exists as an SDK-level model function (`lightrag/llm/anthropic.py`, `ANTHROPIC_API_KEY`), not a documented server binding |
| License | GPL-3.0-or-later (application); MIT (`src/solidlsp`) | MIT | Apache-2.0 declared in `pyproject.toml` (LICENSE + LICENSE-MIT + NOTICE shipped) | MIT |

## Serena

Repo: <https://github.com/oraios/serena>; docs: <https://oraios.github.io/serena/>. Accessed 2026-09-16.

### Distribution and pinning

- Install: `uv tool install -p 3.13 serena-agent`; the `serena` CLI lands on PATH. `uv` is the only stated prerequisite ([installation docs](https://oraios.github.io/serena/02-usage/010_installation.html), accessed 2026-09-16).
- PyPI `serena-agent` is at 1.7.0, `requires_python >=3.11,<3.15` ([PyPI JSON](https://pypi.org/pypi/serena-agent/json), accessed 2026-09-16). Standard pip/uv specifiers (`serena-agent==<ver>`) can pin it; the docs themselves show only the unpinned command — pin syntax is standard package-manager behavior, not a documented feature.
- Alternatives: `uvx -p 3.13 --from git+https://github.com/oraios/serena serena` runs the latest source (each new commit triggers a re-sync — the docs themselves recommend a real install); cloned source via `uv run`; Docker; Nix ([running docs](https://oraios.github.io/serena/02-usage/020_running.html), accessed 2026-09-16). The README explicitly warns against MCP/plugin-marketplace installs as outdated ([README](https://raw.githubusercontent.com/oraios/serena/main/README.md), accessed 2026-09-16).
- Supply chain: auto-downloaded language-server artifacts are version-pinned, SHA256-verified, host-allowlisted, and installed into Serena-managed directories; npm-based language servers use pinned versions but the user's normal npm config (no lockfile `npm ci`); Python deps are pinned exactly in `pyproject.toml` because `uvx` ignores lockfiles on git installs ([security docs](https://oraios.github.io/serena/02-usage/070_security.html), accessed 2026-09-16).

### Runtime surface

- CLI `serena` with sub-commands; `serena start-mcp-server` serves MCP over stdio (default — the client spawns it), `--transport streamable-http [--port]` (server lifecycle owned by the operator; localhost-only by default), or legacy `--transport sse` ([running docs](https://oraios.github.io/serena/02-usage/020_running.html), accessed 2026-09-16).
- The server is **stateful: exactly one active project per instance**. Multiple agents on different projects = one stdio server per client; a shared HTTP instance is only for agents on the same project ([workflow docs](https://oraios.github.io/serena/02-usage/040_workflow.html), accessed 2026-09-16).
- Two language backends: LSP language servers (default, free/open-source, 40+ languages, many auto-installed on demand — a network fetch on first use) or the paid Serena JetBrains Plugin (`--language-backend JetBrains`; requires a running JetBrains IDE with the project open) ([README](https://raw.githubusercontent.com/oraios/serena/main/README.md), accessed 2026-09-16).
- A web dashboard on localhost starts by default; `--open-web-dashboard` controls it ([running docs](https://oraios.github.io/serena/02-usage/020_running.html), accessed 2026-09-16).

### Installed vs requested vs ready

- **Installed**: `serena` on PATH (or resolvable `uvx`/container command) plus `serena init` having run; language backends provisioned.
- **Requested**: the assignment names Serena plus a project path, context (e.g. `claude-code`, `codex`, `ide`), modes, and `read_only` posture.
- **Ready**: client MCP config points at a per-session `start-mcp-server` bound to the session's workspace (`--project <path>` or `--project-from-cwd` under a single-project context), the project exists (`.serena/project.yml` written, `serena project index` done), and one real project-scoped tool call succeeds. A written config file alone is not readiness — matching roadmap 3.2's "verify a real project-scoped query".
- **Watch-outs**: `activate_project` is disabled in single-project contexts when `--project` is given at startup; `activation_command` and `ls_specific_settings` are trust-gated by `trusted_project_path_patterns` and must stay untrusted for evaluator workspaces ([workflow](https://oraios.github.io/serena/02-usage/040_workflow.html) / [security](https://oraios.github.io/serena/02-usage/070_security.html), accessed 2026-09-16).

### Configuration a session binding needs

- Global `~/.serena/serena_config.yml` (auto-created; backend default, base/default modes, trusted path patterns, ignore rules) and per-project `<workspace>/.serena/project.yml` — versioned — plus git-ignored `project.local.yml` overrides ([configuration docs](https://oraios.github.io/serena/02-usage/050_configuration.html), accessed 2026-09-16).
- `project.yml` knobs that matter to us: `language_servers` (per-language LSP list), `read_only: true` disables all editing tools for the review arm, `excluded_tools` / `fixed_tools`, `ignored_paths`, `ls_workspace_folders`, `initial_prompt`, `activation_command` (trust-gated) ([project template](https://raw.githubusercontent.com/oraios/serena/main/src/serena/resources/project.template.yml), accessed 2026-09-16).
- Client launch strings: Claude Code `serena setup claude-code` or `claude mcp add serena -- serena start-mcp-server --context claude-code --project "$(pwd)"` (user scope: `--project-from-cwd`); Codex `serena setup codex` or `[mcp_servers.serena]` in `~/.codex/config.toml` with `args = ["start-mcp-server", "--project-from-cwd", "--context=codex"]`; reminder hooks exist for both (Claude Code hooks are alpha) ([clients docs](https://oraios.github.io/serena/02-usage/030_clients.html), accessed 2026-09-16).
- Memories/onboarding write into `.serena/`; `no-onboarding` / `no-memories` modes exist for benchmark-clean runs ([workflow](https://oraios.github.io/serena/02-usage/040_workflow.html) / [configuration](https://oraios.github.io/serena/02-usage/050_configuration.html), accessed 2026-09-16).

### Model/API requirements

None of its own — Serena never calls a model; the MCP client LLM does. The JetBrains backend is paid (free trial); the LSP backend is free ([README](https://raw.githubusercontent.com/oraios/serena/main/README.md), accessed 2026-09-16).

### License

GPL-3.0-or-later for the application, MIT for `src/solidlsp`; combined distributions are GPL ([README license section](https://raw.githubusercontent.com/oraios/serena/main/README.md), accessed 2026-09-16).

### What C10-B..E needs to contract for

One Serena process per session workspace (stdio), pinned `serena-agent` version, frozen context/mode set, `read_only` for review arms, `.serena/project.yml` inside the task copy, indexing charged to setup time, and an observed tool call as the readiness check. Cross-workspace containment is NOT provided — trust gating is a functionality boundary, not a sandbox ([security docs](https://oraios.github.io/serena/02-usage/070_security.html), accessed 2026-09-16).

## Ponytail

Repo: <https://github.com/DietrichGebert/ponytail>. Accessed 2026-09-16.

### Distribution and pinning

- npm `@dietrichgebert/ponytail` 4.10.0 (published by GitHub Actions OIDC trusted publisher; [npm registry](https://registry.npmjs.org/@dietrichgebert%2Fponytail/latest), accessed 2026-09-16) and tagged GitHub releases (`v4.10.0`, [release API](https://api.github.com/repos/DietrichGebert/ponytail/releases/latest), accessed 2026-09-16).
- Per-host install paths ([README](https://raw.githubusercontent.com/DietrichGebert/ponytail/main/README.md), accessed 2026-09-16): Claude Code `/plugin marketplace add DietrichGebert/ponytail` + `/plugin install ponytail@ponytail`; Codex `codex plugin marketplace add` + `codex plugin add ponytail@ponytail` plus `/hooks` trust; Copilot CLI plugin commands; OpenCode `"plugin": ["@dietrichgebert/ponytail"]` in `opencode.json` (npm specifier — a version suffix like `@4.10.0` is the pin point) or a local checkout path; Devin CLI `devin plugins install`; Gemini/Antigravity `gemini extensions install <git url>`; Pi, OpenClaw (ClawHub), Grok, Hermes, Swival, Qoder, Kiro; plus instruction-only rule-file copies (`.cursor/rules/`, `.windsurf/rules/`, `.clinerules/`, `.github/copilot-instructions.md`, `AGENTS.md`, `.kiro/steering/`).
- Version pinning granularity for marketplace installs (Claude Code `/plugin install`, `codex plugin add`, ClawHub) is **UNKNOWN** — the README does not document selecting a non-latest plugin version there. Pinning is concrete via npm version suffix (OpenCode), git tag checkout, or vendoring the rule files.

### Runtime surface

- Not a server: a ruleset plus skills plus two tiny Node.js lifecycle hooks (`hooks/`) injected by the host. Without `node` on the *non-interactive* shell's PATH the skills still load but always-on activation stays quiet ([README](https://raw.githubusercontent.com/DietrichGebert/ponytail/main/README.md), accessed 2026-09-16).
- Optional `ponytail-mcp/` package: a stdio MCP server exposing prompt `ponytail` (mode arg `lite|full|ultra`) and read-only tool `ponytail_instructions`, for MCP hosts whose only injection point is the prompt menu; explicitly *not* a replacement for always-on adapters ([ponytail-mcp README](https://raw.githubusercontent.com/DietrichGebert/ponytail/main/ponytail-mcp/README.md), accessed 2026-09-16).
- Commands: `/ponytail [lite|full|ultra|off]`, `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`, `/ponytail-gain`, `/ponytail-help`; availability depends on host skill support ([README](https://raw.githubusercontent.com/DietrichGebert/ponytail/main/README.md), accessed 2026-09-16).

### Installed vs requested vs ready

- **Installed**: plugin/rule files present for the host (or npm package resolvable), Node hooks wired where the host needs them.
- **Requested**: assignment declares the Ponytail level (`lite|full|ultra`) and host adapter.
- **Ready**: a session actually started with the ruleset active — observable via the mode/status text or `/ponytail` reporting the level; for the instruction-only copies, presence of the file plus the platform actually loading it. Whether a given harness verifiably loaded the injected rules is host-dependent and partially **UNKNOWN**; treat "file written" as installed, not ready.
- **Watch-outs**: Cursor's rule file and hooks are alternatives (rule wins silently); hooks don't reach Cursor subagents or cloud agents; rules inject into Agent-tool subagents unless `PONYTAIL_SUBAGENT_MATCHER` scopes them ([README](https://raw.githubusercontent.com/DietrichGebert/ponytail/main/README.md), accessed 2026-09-16).

### Configuration a session binding needs

- `PONYTAIL_DEFAULT_MODE` env var or `defaultMode` in `~/.config/ponytail/config.json` (`%APPDATA%\ponytail\config.json` on Windows); default `full`. `PONYTAIL_SUBAGENT_MATCHER` regex scopes subagent injection ([README](https://raw.githubusercontent.com/DietrichGebert/ponytail/main/README.md), accessed 2026-09-16).
- Residual state outside the plugin dir on uninstall: mode flags (`~/.claude/.ponytail-active`, `~/.cursor/.ponytail-active`), `~/.cursor/hooks.json` entries, optional `~/.claude/settings.json` statusline ([README](https://raw.githubusercontent.com/DietrichGebert/ponytail/main/README.md), accessed 2026-09-16). A clean session binding must account for these writes outside the workspace.

### Model/API requirements

None — it is prompt text consumed by the host agent's existing model, on whatever subscription/API the host already uses. Every active turn re-injects the ruleset, so it is a per-turn input-token cost on the host, matching the roadmap's "count repeated rule injection" note. Upstream's own benchmark (Claude Code, Haiku 4.5, n=4) reports ~−54% LOC / ~−22% tokens vs a no-skill baseline; the authors themselves corrected earlier 80–94% single-shot claims — treat all of it as vendor evidence, not office measurement ([README](https://raw.githubusercontent.com/DietrichGebert/ponytail/main/README.md), accessed 2026-09-16).

### License

MIT ([README](https://raw.githubusercontent.com/DietrichGebert/ponytail/main/README.md), [package.json](https://raw.githubusercontent.com/DietrichGebert/ponytail/main/package.json), accessed 2026-09-16).

### What C10-B..E needs to contract for

A pinned artifact (npm version, git tag, or vendored rules), the declared level, the exact host adapter and where its files land, and accounting for per-turn injection tokens. Whether marketplace installs can pin a non-latest version is UNKNOWN — the pinned path is npm specifier, tag checkout, or vendored copy.

## Graphify

Repo: <https://github.com/Graphify-Labs/graphify> (default branch `v8`). Accessed 2026-09-16.

### Distribution and pinning

- PyPI package `graphifyy` (double-y — other `graphify*` packages are unaffiliated), 0.9.62 at access time, `requires-python >=3.10`; the CLI command is `graphify` ([PyPI JSON](https://pypi.org/pypi/graphifyy/json), [pyproject.toml](https://raw.githubusercontent.com/Graphify-Labs/graphify/v8/pyproject.toml), accessed 2026-09-16).
- Install: `uv tool install graphifyy` (recommended, isolated env), `pipx install graphifyy`, or `pip install graphifyy`; run-without-install `uvx --from graphifyy graphify …` (naming the *package* is required — plain `uvx graphify` fails). Version pin via the standard specifier `graphifyy==<ver>` ([README](https://raw.githubusercontent.com/Graphify-Labs/graphify/v8/README.md), accessed 2026-09-16).
- Installed CLI version and installed skill version can drift — the README documents a `skill is from graphify <newer>, package is <older>` warning and prescribes `uv tool upgrade graphifyy && graphify install`; a session contract should pin both together ([README troubleshooting](https://raw.githubusercontent.com/Graphify-Labs/graphify/v8/README.md), accessed 2026-09-16).

### Runtime surface

- Local CLI that builds `graphify-out/` (`graph.json`, `GRAPH_REPORT.md`, `graph.html`) from a directory. Code extraction is local tree-sitter AST across ~40 grammars — deterministic, no LLM, nothing leaves the machine; docs/PDFs/images/video go through a configured LLM backend ([README](https://raw.githubusercontent.com/Graphify-Labs/graphify/v8/README.md), accessed 2026-09-16).
- Agent surfaces: `graphify install [--project] [--platform <id>]` registers the skill (per-user or per-repo `.claude/skills/`, `.agents/skills/`, etc.); `graphify <platform> install` writes always-on hooks/rules per platform (Claude Code PreToolUse hook incl. `--strict`, Codex `AGENTS.md` + deliberately no-op hook, Cursor `alwaysApply` rule, Devin CLI skill + `.windsurf/rules/graphify.md`, ~20 platforms total) ([README](https://raw.githubusercontent.com/Graphify-Labs/graphify/v8/README.md), accessed 2026-09-16).
- Optional MCP server (extra `graphifyy[mcp]`): `python -m graphify.serve graphify-out/graph.json` on stdio, or `--transport http --host/--port/--api-key`; tools `query_graph`, `get_node`, `get_neighbors`, `shortest_path`, `list_prs`, `get_pr_impact`, `triage_prs`. A shared HTTP server can serve one graph to many clients ([README](https://raw.githubusercontent.com/Graphify-Labs/graphify/v8/README.md), accessed 2026-09-16).
- `graphify hook install` adds post-commit/post-checkout rebuild hooks and a `graph.json` union merge driver; `graphify update .` re-syncs after pulls ([README](https://raw.githubusercontent.com/Graphify-Labs/graphify/v8/README.md), accessed 2026-09-16).

### Installed vs requested vs ready

- **Installed**: `graphify` on PATH with the needed extras (`[mcp]`, `[pdf]`, `[office]`, a backend extra such as `[ollama]`/`[openai]`/`[anthropic]`/`[gemini]`/`[bedrock]` when headless extraction is wanted).
- **Requested**: assignment declares code-only vs docs-inclusive scope, the backend (or "assistant's model" via the skill), and whether an MCP server or just the CLI/skill is bound.
- **Ready**: a `graph.json` built from the assignment's exact permitted source snapshot (hash it — repeat use may only reuse an index built from the same snapshot per roadmap 3.2), plus a real `graphify query` answering against it. For skill arms, readiness additionally means the host actually loaded the skill/hook — same caveat as Ponytail.
- **Watch-outs**: `.gitignore` is respected automatically; `.graphifyignore` only narrows further — grants must be enforced at ingestion, not retrieval. `graphify-out/` is meant to be committed normally, but in a benchmark it must stay inside the participant copy. Extraction can include `AGENTS.md`/`GRAPH_REPORT.md` content — keep evaluator material out of the corpus ([README](https://raw.githubusercontent.com/Graphify-Labs/graphify/v8/README.md), accessed 2026-09-16).

### Configuration a session binding needs

- Backend selection: `graphify extract --backend <gemini|kimi|claude|openai|deepseek|ollama|bedrock|azure|claude-cli>` with the matching env keys (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY` + `OPENAI_BASE_URL`/`OPENAI_MODEL` for OpenAI-compatible local servers, `OLLAMA_BASE_URL`/`OLLAMA_MODEL`, `AZURE_OPENAI_*`, AWS credential chain, `MOONSHOT_API_KEY`, `DEEPSEEK_API_KEY`) — auto-detected by key priority `Gemini → Kimi → Claude → OpenAI → DeepSeek → Azure → Bedrock → Ollama` when unset ([README](https://raw.githubusercontent.com/Graphify-Labs/graphify/v8/README.md), accessed 2026-09-16).
- Files: `.graphifyignore` (gitignore syntax), `graphify-out/` outputs, `graphify-out/.graphify_python` interpreter pin, optional query log `~/.cache/graphify-queries.log` (off by default; `GRAPHIFY_QUERY_LOG*` toggles), `~/.graphify/global-graph.json` cross-project registry ([README](https://raw.githubusercontent.com/Graphify-Labs/graphify/v8/README.md), accessed 2026-09-16).
- Behavior knobs: `GRAPHIFY_MAX_WORKERS`, `GRAPHIFY_MAX_OUTPUT_TOKENS`, `GRAPHIFY_MAX_RETRIES`, `GRAPHIFY_MAX_RETRY_DEPTH`, `GRAPHIFY_API_TIMEOUT`, `--token-budget`, `--code-only`, `--mode deep`, `GRAPHIFY_HOOK_STRICT` ([README](https://raw.githubusercontent.com/Graphify-Labs/graphify/v8/README.md), accessed 2026-09-16).

### Model/API requirements

Code-only graphs need **zero** model calls — that path is fully local and free. The semantic pass over docs/PDFs/media requires a backend; two routes need no separate paid key: `--backend claude-cli` (routes through the Claude Code CLI, "uses your Claude subscription") and `--backend ollama` (local). The others are paid API keys or AWS IAM ([README privacy/env sections](https://raw.githubusercontent.com/Graphify-Labs/graphify/v8/README.md), accessed 2026-09-16). Rerank/community-label calls reuse the same backend.

### License

`pyproject.toml` declares `Apache-2.0` and ships `LICENSE` (Apache-2.0 text), `LICENSE-MIT`, and `NOTICE` ([pyproject.toml](https://raw.githubusercontent.com/Graphify-Labs/graphify/v8/pyproject.toml), [LICENSE](https://raw.githubusercontent.com/Graphify-Labs/graphify/v8/LICENSE), accessed 2026-09-16). The exact dual-license interplay of `LICENSE-MIT` is not spelled out in the files checked — **UNKNOWN**; declared field is Apache-2.0.

### What C10-B..E needs to contract for

Pinned `graphifyy` + skill version pair, declared corpus scope with `.graphifyignore`/ingestion-side grant enforcement, the semantic backend (ideally `ollama` or `claude-cli` to stay inside existing seats — verify claude-cli subscription terms at use time), whether the MCP server is bound per session or the CLI is invoked directly, and charging extraction/index build to setup as the roadmap already requires.

## LightRAG

Repo: <https://github.com/HKUDS/LightRAG>; paper arXiv:2410.05779. Accessed 2026-09-16.

### Distribution and pinning

- PyPI `lightrag-hku` 1.5.7 at access time, `requires-python >=3.10` ([PyPI JSON](https://pypi.org/pypi/lightrag-hku/json), [pyproject.toml](https://raw.githubusercontent.com/HKUDS/LightRAG/main/pyproject.toml), accessed 2026-09-16).
- Server: `uv tool install "lightrag-hku[api]"` (or pip venv equivalent), then `cp env.example .env` and `lightrag-server`. Source: `git clone` + `make dev` / `uv sync --extra test --extra offline` + `bun install && bun run build` for the WebUI. Docker: `docker compose up` from a checkout; official GHCR images are Sigstore-cosign signed, historical tags retained ([README](https://raw.githubusercontent.com/HKUDS/LightRAG/main/README.md), accessed 2026-09-16). Pin via `"lightrag-hku[api]==<ver>"` or an image tag/digest.
- Extras: `[api]` (server + parsers), `[offline-storage]` (faiss/redis/neo4j/milvus/mongo/postgres/pgvector/qdrant/opensearch clients), `[offline-llm]` (openai/anthropic/ollama/zhipuai/aioboto3/voyageai/llama-index SDKs), `[evaluation]` (ragas), `[observability]` (langfuse) ([pyproject.toml](https://raw.githubusercontent.com/HKUDS/LightRAG/main/pyproject.toml), accessed 2026-09-16).

### Runtime surface

- `lightrag-server` / `lightrag-gunicorn`: FastAPI REST API + two WebUIs (`/webui` admin, `/workspace` query-only), default bind `0.0.0.0:9621` — **unauthenticated by default**; needs `LIGHTRAG_API_KEY` or `AUTH_ACCOUNTS`+`TOKEN_SECRET`, or `HOST=127.0.0.1`. Ollama-compatible `/api/*` routes exist and stay open unless `WHITELIST_PATHS` is tightened ([README](https://raw.githubusercontent.com/HKUDS/LightRAG/main/README.md), [env.example](https://raw.githubusercontent.com/HKUDS/LightRAG/main/env.example), accessed 2026-09-16).
- Python SDK (`from lightrag import LightRAG`) for embedded use — upstream recommends the REST API for integration and flags SDK-only features as experimental ([README](https://raw.githubusercontent.com/HKUDS/LightRAG/main/README.md), accessed 2026-09-16).
- Auxiliary CLIs: `lightrag-download-cache`, `lightrag-repair-chunk-tracking`, `lightrag-hash-password`, `lightrag-clean-llmqc`, `lightrag-rebuild-vdb` ([pyproject.toml](https://raw.githubusercontent.com/HKUDS/LightRAG/main/pyproject.toml), accessed 2026-09-16).
- Storage: four stores (KV / vector / graph / doc-status) default to in-memory + file persistence (`JsonKVStorage`, `NanoVectorDBStorage`, `NetworkXStorage`, `JsonDocStatusStorage`) — explicitly small-scale/eval-only; production points at PostgreSQL (all four), MongoDB, OpenSearch, or specialized Milvus/Qdrant/Neo4j/Memgraph ([README](https://raw.githubusercontent.com/HKUDS/LightRAG/main/README.md), [config.py](https://raw.githubusercontent.com/HKUDS/LightRAG/main/lightrag/api/config.py), accessed 2026-09-16).
- Query modes: `local`, `global`, `hybrid`, `naive`, `mix` (default `mix`); the API can return retrieved contexts alongside answers — the hook for the roadmap's "context-only results for the existing agent" ([README](https://raw.githubusercontent.com/HKUDS/LightRAG/main/README.md), accessed 2026-09-16).

### Installed vs requested vs ready

- **Installed**: `lightrag-server` resolvable with chosen extras, `.env` generated (wizard `make env-*` or hand-edit), `WORKING_DIR`/`INPUT_DIR` set.
- **Requested**: assignment declares the corpus (the task's document set), per-role model routes, storage profile, and which surface the agent sees (REST query endpoint vs SDK vs `/api/*`).
- **Ready**: server up, documents inserted and indexed (extraction billed to setup), and a real query returning contexts. Index state lives under `WORKING_DIR`/`rag_storage` — per-session isolation means separate working dirs or separate storage backends.
- **Watch-outs**: the default 0.0.0.0 unauthenticated bind is a real exposure if launched carelessly; embedding model is frozen at first indexing (changing it means re-embedding everything); identical queries are served from `ENABLE_LLM_CACHE` — freshness-phase runs must account for it ([README](https://raw.githubusercontent.com/HKUDS/LightRAG/main/README.md), [env.example](https://raw.githubusercontent.com/HKUDS/LightRAG/main/env.example), accessed 2026-09-16).

### Configuration a session binding needs

- `.env` (from `env.example` or the `make env-*` wizard): `HOST`, `PORT`, auth (`LIGHTRAG_API_KEY` / `AUTH_ACCOUNTS` + `TOKEN_SECRET`), `WORKING_DIR`, `INPUT_DIR`, `LIGHTRAG_PARSER` rules, `MAX_ASYNC_LLM`/`EXTRACT_MAX_ASYNC_LLM`/`MAX_PARALLEL_INSERT`/`EMBEDDING_FUNC_MAX_ASYNC`/`EMBEDDING_BATCH_NUM` concurrency, `ENABLE_LLM_CACHE`, `WHITELIST_PATHS` ([env.example](https://raw.githubusercontent.com/HKUDS/LightRAG/main/env.example), accessed 2026-09-16).
- Model routes: `LLM_BINDING` / `LLM_MODEL` / `LLM_BINDING_HOST` / `LLM_BINDING_API_KEY` globally, with `{EXTRACT|KEYWORD|QUERY|VLM}_LLM_*` per-role overrides; same pattern for `EMBEDDING_BINDING*` and `RERANK_BINDING*` ([RoleSpecificLLMConfiguration.md](https://raw.githubusercontent.com/HKUDS/LightRAG/main/docs/RoleSpecificLLMConfiguration.md), [env.example](https://raw.githubusercontent.com/HKUDS/LightRAG/main/env.example), accessed 2026-09-16).

### Model/API requirements — the critical open question, answered

LightRAG makes real model calls in **both** phases: EXTRACT-role LLM calls per text chunk during indexing (plus merge summaries), KEYWORD/QUERY LLM calls per query, an embedding model for every chunk/entity/relation, an optional reranker, and a VLM only when `VLM_PROCESS_ENABLE=true` and the document's `process_options` include `i` ([README config guide](https://raw.githubusercontent.com/HKUDS/LightRAG/main/README.md), [RoleSpecificLLMConfiguration.md](https://raw.githubusercontent.com/HKUDS/LightRAG/main/docs/RoleSpecificLLMConfiguration.md), accessed 2026-09-16).

Documented server routes (`--llm-binding` choices in `lightrag/api/config.py`, verified in source 2026-09-16):

| Role | Binding choices |
| --- | --- |
| LLM | `openai` (incl. any OpenAI-compatible host: OpenRouter, vLLM, SGLang, llama.cpp via `LLM_BINDING_HOST`), `openai-ollama`, `ollama`, `lollms`, `azure_openai`, `bedrock` (IAM/bearer, no API key), `gemini` |
| Embedding | `openai`, `azure_openai`, `ollama`, `lollms`, `bedrock`, `jina`, `gemini`, `voyageai` |
| Rerank | `null` (off), `cohere`, `jina`, `aliyun` — `RERANK_BINDING_HOST` may point at a local rerank service |

- **Free/local path exists**: `LLM_BINDING=ollama` + `EMBEDDING_BINDING=ollama` + local rerank endpoint is a documented all-local stack; upstream suggests `Qwen3-30B-A3B`-class extraction models, `BAAI/bge-m3` embeddings, `BAAI/bge-reranker-v2-m3` rerank ([README config guide](https://raw.githubusercontent.com/HKUDS/LightRAG/main/README.md), [env.example](https://raw.githubusercontent.com/HKUDS/LightRAG/main/env.example), accessed 2026-09-16). Whether local models clear the C10 quality gate is an empirical question for C10-E, not answered by docs.
- **Subscription reuse: no documented route.** Every hosted binding takes an API key or cloud credentials; there is no Claude Pro/Max, ChatGPT, or Codex-subscription path in the documented bindings. `lightrag/llm/anthropic.py` provides an Anthropic Messages-API function using `ANTHROPIC_API_KEY` for SDK callers (and `anthropic` appears in the role doc's vision-capable provider list), but it is **not** among the `--llm-binding` server choices — server-side Anthropic support is only reachable through an OpenAI-compatible gateway if at all; that viability is **UNKNOWN** ([config.py choices](https://raw.githubusercontent.com/HKUDS/LightRAG/main/lightrag/api/config.py), [anthropic.py](https://raw.githubusercontent.com/HKUDS/LightRAG/main/lightrag/llm/anthropic.py), [RoleSpecificLLMConfiguration.md](https://raw.githubusercontent.com/HKUDS/LightRAG/main/docs/RoleSpecificLLMConfiguration.md), accessed 2026-09-16).
- **Unverifiable items, flagged UNKNOWN**: whether an OpenAI-compatible gateway fronting Claude models preserves extraction quality; actual per-document/per-query token costs at the fixture scale; free-tier quotas of any hosted embedding/LLM route.

### License

MIT ([pyproject.toml](https://raw.githubusercontent.com/HKUDS/LightRAG/main/pyproject.toml), accessed 2026-09-16).

### What C10-B..E needs to contract for

A pinned `lightrag-hku` version, a generated `.env` bound to one session (loopback bind + `LIGHTRAG_API_KEY`), a dedicated `WORKING_DIR` per arm, explicit `*_LLM_*`/`EMBEDDING_*`/`RERANK_*` routes (Ollama-local vs a declared paid route — the roadmap's BLOCKED_EXTERNAL rule applies to unsupported subscription reuse), `ENABLE_LLM_CACHE` handling for the freshness phase, and per-call usage accounting since extraction/query/rerank calls are all billable model traffic.
