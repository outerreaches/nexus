# Nexus

Lightweight, always-on multi-agent assistant (OpenClaw-inspired), starting with:
- Gateway process (HTTP status + Telegram bot)
- OpenRouter + OpenAI-compatible local models (LM Studio / Ollama) via a single OpenAI-compat client
- Self-modifiable prompts via state personalization files (`SOUL.md`, `AGENTS.md`, `USER.md`, `CODEGUIDE.md`, etc.)
- Basic tool loop (file ops, web search/fetch, guarded shell exec, managed browser, paper trade logging)
- Dynamic MCP integration via `mcp-manager` and runtime MCP profiles

## Quick start

Requirements:
- Node.js 22+ (`package.json` enforces `>=22`)

1) Install deps:
```bash
npm install
```

2) Create a local env file:
```bash
cp .env.example .env
```

3) Create config + workspace with interactive onboarding:
```bash
npm run dev -- init
```

This launches an interactive onboarding wizard that creates personalized configuration files for your agent. You'll be asked for:
- **Agent identity**: Name, emoji, personality vibe
- **Your profile**: Name, timezone, context
- **Telegram setup**: enable/disable, allowlist, pairing policy

For true headless setup, provide onboarding values from JSON:
```bash
npm run dev -- init --onboarding-json examples/init-onboarding.template.json
```

An example template is included at `examples/init-onboarding.template.json`.
Onboarding is required and gateway startup is blocked until initialization is complete.
To re-run onboarding and overwrite generated files/config values, use:
```bash
npm run dev -- init --force
```
Without `--force`, `init` preserves existing non-empty state markdown files and only creates missing/empty ones.

4) Configure secrets in your environment (typically `.env`) and keep placeholders in config (`~/.nexus/nexus.json`):
- Default model is `moonshotai/kimi-k2.5` (override via `llm.openaiCompat.model`).
- `OPENROUTER_API_KEY`
- Optional local/OpenAI-compatible endpoint (for local-only routing or fallback):
  - `NEXUS_LOCAL_LLM_BASE_URL`
  - `NEXUS_LOCAL_LLM_API_KEY`
  - `NEXUS_LOCAL_LLM_MODEL`
- `BRAVE_API_KEY` (optional; enables `web_search` via Brave)
- `PERPLEXITY_API_KEY` (optional; enables `web_search` via Perplexity direct)
- `TELEGRAM_BOT_TOKEN`

5) Start the gateway:
```bash
npm run dev -- gateway --verbose
```

## Model routing and fallback

Nexus supports per-agent/per-preset model routing with optional fallback providers.

Route resolution order:
1. `llm.routing.byAgent[agentId]`
2. `llm.routing.byPreset[preset]`
3. `llm.routing.default`

`spawn_agent` also supports `modelMode: "local_only"` to force local-provider routing for privacy-sensitive work. Nested workers inherit `modelMode` unless explicitly overridden.

Example:
```json
{
  "llm": {
    "openaiCompat": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "model": "moonshotai/kimi-k2.5"
    },
    "providers": {
      "local": {
        "baseUrl": "${NEXUS_LOCAL_LLM_BASE_URL}",
        "apiKey": "${NEXUS_LOCAL_LLM_API_KEY}",
        "model": "${NEXUS_LOCAL_LLM_MODEL}"
      }
    },
    "routing": {
      "default": {
        "primary": { "provider": "default" },
        "fallback": { "provider": "local" }
      },
      "byPreset": {
        "coder": {
          "primary": { "provider": "default", "model": "moonshotai/kimi-k2.5" },
          "fallback": { "provider": "local" }
        }
      },
      "byAgent": {},
      "localProvider": "local"
    }
  }
}
```

## MCP integration

Nexus now supports runtime-managed MCP servers and dynamic MCP worker profiles without bloating the orchestrator prompt/tool schema.

Design:
- The orchestrator only gets `mcp_overview` (read-only summary).
- MCP lifecycle + delegation is handled by the `mcp-manager` preset.
- MCP worker presets are stored as dynamic profiles and are hidden by default.
- Only active MCP servers are connected and loaded into the tool registry.

Core MCP tools:
- `mcp_overview`
- `mcp_server_list|add|update|probe|activate|deactivate|remove`
- `mcp_profile_list|create|update|delete`
- `mcp_delegate` (activate/provision profile + spawn scoped worker + optional cleanup)

MCP profile tool policy:
- By default, profile `toolNames` are expected to be MCP tools (`mcp.<server>.<tool>`).
- You can include non-MCP tools on demand by setting `allowNonMcpTools=true` in:
  - `mcp_profile_create`
  - `mcp_profile_update`
  - `mcp_delegate` (when creating an ephemeral profile via `toolNames`)
- Keep non-MCP additions minimal and task-specific.

Recommended flow:
1. Orchestrator calls `mcp_overview`.
2. Orchestrator spawns `mcp-manager` for setup/delegation.
3. `mcp-manager` uses `mcp_delegate` to run a scoped worker on MCP tools.
4. Results are exchanged via blackboard IDs between workers.

## Safety warning

The default `docker-compose.yml` enables:
- `NEXUS_PROACTIVE=1`
- `NEXUS_ALLOW_SHELL_EXEC=1`
- `NEXUS_ALLOW_CODE_WRITE=1`

This allows autonomous background execution and direct code mutation. Run only on trusted hosts/repositories, keep backups, and lock Telegram access down with `channels.telegram.allowFrom` and/or pairing.

## Docker dev

Build + interactive CLI chat:
```bash
docker build -t nexus-agent:dev .
docker run -it --rm \
  -e OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  -e NEXUS_ALLOW_SHELL_EXEC=1 \
  -v nexus_data:/data \
  nexus-agent:dev chat
```

Gateway (HTTP + Telegram):
```bash
docker compose up --build
```

Notes:
- State lives in the Docker volume at `/data/nexus` (config, workspace, history DB, browser profile).
- Headless browser is enabled by default in the container (`NEXUS_BROWSER_HEADLESS=1`).

## Browser tool (managed Chrome via CDP)

The `browser` tool controls a Chromium browser using stable element refs produced by `browser.snapshot` (plus `text`, `screenshot`, `scroll`, `press`).

By default it launches a **local** Chrome/Brave/Edge with a persistent profile in `~/.nexus/browser/default`. For sandboxing/VM setups you can point it at a **remote CDP** endpoint instead.

Environment variables:
- `NEXUS_BROWSER_EXECUTABLE_PATH` (recommended) — path to Chrome/Brave/Edge
- `NEXUS_BROWSER_CDP_PORT` (optional) — defaults to `gatewayPort + 2`
- `NEXUS_BROWSER_REMOTE_CDP_URL` (optional) — connect to an existing browser via CDP (skips launching locally)
- `NEXUS_BROWSER_HEADLESS=1` (optional)
- `NEXUS_BROWSER_NO_SANDBOX=1` (optional; mainly for containers)

### Password-based logins (credential vault)

If you need the agent to log into websites with a username + password, avoid typing passwords into chat (that would send them to your LLM provider).

Instead:
1) Put the secret in an env var and start Nexus with it set.
2) Store it in the local credential vault via `credential_set` using `passwordEnv` / `usernameEnv`.
3) Use `browser.type_secret` to fill form fields without exposing the password to the model.

If the agent needs to create new accounts autonomously, prefer generating passwords locally via `credential_generate` (the password is never revealed to the model).

Optional at-rest encryption:
- Set `NEXUS_CREDENTIALS_KEY` to encrypt stored passwords under `stateDir/secrets/credentials.json`.

Convenience actions:
- `browser` action `click_text` clicks a button/link by visible text.
- `browser` action `wait` waits for selector/text/url/title/load-state.

## Web tools

- `web_search`: Brave Search API (`BRAVE_API_KEY`) or Perplexity Sonar via OpenRouter/direct (`OPENROUTER_API_KEY` or `PERPLEXITY_API_KEY`)
- `web_fetch`: keyless HTTP fetch + text extraction (timeouts, redirect limits, small cache). Non-text binaries (images, PDFs, etc.) are saved to the workspace and return a local file path instead of inlining payloads.
- `langextract_extract`: experimental structured entity/field extraction via Python LangExtract. Supports text/path/url/blackboard input (including local/remote PDF extraction), writes a JSON artifact to disk, and can write a blackboard artifact reference for downstream agents. Uses OpenRouter by default (existing Nexus model route), with optional per-call model override. Supports compact auto-generated few-shot examples and internal chunk/merge for long text sources. Python runtime deps: `pip install 'langextract[openai]' pypdf`. Note: currently disabled in default agent presets due reliability issues.

Safety knob:
- `NEXUS_ALLOW_PRIVATE_WEB_FETCH=1` allows fetching private/loopback hostnames and IPs (disabled by default).

## Telegram

Access control options (OpenClaw-style):
- Static allowlist: set `channels.telegram.allowFrom` to your Telegram user id(s).
- Pairing: if `channels.telegram.pairing.enabled` is true, an unknown user who DMs the bot receives a pairing code; the operator approves it via:
  - `npm run dev -- pairing list telegram`
  - `npm run dev -- pairing approve telegram <CODE>`

Human-action responses (OTP/MFA/etc) without leaking secrets into the LLM:
- The agent will create a request id via `human_request`.
- Reply to the bot with: `/act <ID> <your response>` (this stores the response in state and nudges the agent to continue; the secret is not sent through the model).
- To fill an OTP field in the browser without exposing it to the model, use `browser` action `type_action` with `actionId=<ID>`.

Delivery modes:
- `channels.telegram.mode="polling"` (default): simplest, works anywhere.
- `channels.telegram.mode="webhook"`: requires `channels.telegram.webhookUrl` or `channels.telegram.webhookPublicUrl` and exposes `channels.telegram.webhookPath` on the gateway HTTP server.

Telegram file I/O:
- Inbound attachments auto-trigger analysis. Files are stored under `state/telegram-files/...` and indexed in blackboard entries.
- Supported image attachments are also forwarded to the LLM as multimodal `image_url` parts (inline data URLs), with size/count caps.
  - Inline MIME allowlist: `image/png`, `image/jpeg`, `image/webp`, `image/gif` (OpenRouter-compatible).
  - Use a vision-capable model on your OpenRouter route; non-vision models may ignore image parts.
  - If provider/model rejects image parts (e.g., non-vision route), Nexus retries once automatically with text-only content.
- Use `telegram_send_file` to send files back to users by path.
- Use `image_analyze` to analyze existing images from a direct path or blackboard attachment (`blackboardId` + `attachmentIndex`).
- Use `image_generate` to create image files via the active model route, persist them, optionally write a blackboard artifact, and optionally send them to Telegram.
- Use `image_edit` to edit an existing image (from file path or blackboard attachment), persist outputs, optionally write a blackboard artifact, and optionally send them to Telegram.
- Env tuning:
  - `NEXUS_TELEGRAM_MAX_INBOUND_FILES_PER_MESSAGE` (default `5`)
  - `NEXUS_TELEGRAM_MAX_INBOUND_FILE_BYTES` (default `20971520` = 20 MB)
  - `NEXUS_TELEGRAM_FILE_BLACKBOARD_TTL_MS` (default `2592000000` = 30 days)
  - `NEXUS_TELEGRAM_LLM_MAX_INLINE_IMAGES` (default `3`)
  - `NEXUS_TELEGRAM_LLM_MAX_INLINE_IMAGE_BYTES` (default `4194304` = 4 MB)
  - `NEXUS_TELEGRAM_SEND_FILE_ALLOW_ANY=1` allows sending files outside `stateDir`/`workspaceDir`/`codeDir` (default: restricted to those roots)

## Gmail (OAuth API)

For Gmail, the recommended approach is the official Gmail API (OAuth2), not browser-login automation.

1) Create OAuth credentials (Desktop app) and enable Gmail API in Google Cloud.

2) Set env vars:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

3) Run authorization (stores tokens under `stateDir/gmail/oauth.json`):
```bash
npm run dev -- gmail auth
```

Docker auth example:
```bash
docker exec -it nexus-nexus-1 nexus gmail auth --listen 0.0.0.0 --port 18790
```

Agent tools:
- `gmail_profile`
- `gmail_search`
- `gmail_get_message`
- `gmail_send`

## Safety knobs

- `permissions.allowShellExec` (config) or `NEXUS_ALLOW_SHELL_EXEC=1` enables the `shell_exec` tool (disabled otherwise).
- `permissions.allowCodeEdit` (config) controls whether `file_*` tools may target the running codebase (absolute paths under `codeDir`).
- `permissions.allowCodeWrite` (config) or `NEXUS_ALLOW_CODE_WRITE=1` enables writes under `codeDir` (`file_write`/`file_edit`/`file_edit_lines`).
- `NEXUS_TELEGRAM_ALLOW_ALL=1` allows any Telegram user if `channels.telegram.allowFrom` is empty (not recommended).
- `/dashboard` and `/api/*` are operator surfaces and currently have no built-in auth/rate limiting. Keep them on trusted networks or front them with an authenticated proxy.

## CLI tool command

Run a single tool directly from CLI:

```bash
npm run dev -- tool <tool_name> '<json_args>'
```

Example:
```bash
npm run dev -- tool query_data '{"instrument":"BTC","currency":"usd"}'
```

In Docker (when `nexus` binary is on PATH in the container):
```bash
docker exec -it nexus-nexus-1 nexus tool <tool_name> '<json_args>'
```

## Custom tools

Drop tools into `stateDir/tools/` (default `~/.nexus/tools/`):
- `*.tool.json` (built-in simple types: `shell`, `http`)
- `*.tool.mjs` (arbitrary JavaScript module; full power)

Then run `tools_reload` to load them without restarting.  
Note: `tools_reload` is exposed to the `coder` preset only; the orchestrator should delegate reloads to a coder run.

## Personalization & Soul Files

Nexus uses a state-based personalization system inspired by [OpenClaw](https://github.com/openclaw/openclaw). Personalization files live in `stateDir` (default `~/.nexus/`):

| File | Purpose |
|------|---------|
| `SOUL.md` | Agent persona, philosophy, personality, boundaries |
| `USER.md` | Your profile — name, timezone, preferences, context |
| `AGENTS.md` | Operating instructions, memory strategy, rules |
| `CODEGUIDE.md` | Coder agent implementation and deploy workflow guidance |
| `HEARTBEAT.md` | Optional proactive task checklist |
| `NOTES.md` | Persistent scratchpad across sessions |

### Proactive Heartbeat (Always-On)

When enabled, the gateway runs periodic **proactive heartbeat ticks** that prompt the agent to review `HEARTBEAT.md` and take small, high-value actions. If there is nothing to do, the agent should respond `IDLE` and the scheduler will back off automatically.

Execution behavior:
- Heartbeat runs use a background execution lane (separate from interactive Telegram/CLI requests).
- Heartbeat orchestrator runs reuse the latest Telegram thread context for the same agent to maintain continuity.

Enable via env (simplest in Docker):
- `NEXUS_PROACTIVE=1`
- Optional tuning: `NEXUS_PROACTIVE_INTERVAL_MS`, `NEXUS_PROACTIVE_MAX_INTERVAL_MS`, `NEXUS_PROACTIVE_JITTER_MS`
- `NEXUS_PROACTIVE_NOTIFY_TELEGRAM=1` sends non-idle outputs to allowlisted Telegram user ids
- `NEXUS_SPAWN_BUDGET_MIN_RATIO` (default `0.75`) sets a floor for explicit spawn budget overrides as a fraction of preset budget (helps prevent accidental ultra-low worker budgets).

Or via config (`stateDir/nexus.json`): `proactive.enabled`, `proactive.intervalMs`, etc.

### Internal Scheduler (Cron Jobs)

Nexus includes an internal **cron scheduler** (no external cron or Python scripts required).

Key behavior:
- Jobs are stored with `owner_agent_id` derived from `NEXUS_SCHEDULER_AGENT_ID` (default `main`), and current job tools do not enforce per-caller ownership checks.
- When a job run fails, the scheduler can notify the configured scheduler agent id (not the end user) so it can self-heal and decide whether to notify you.
- Scheduler-triggered orchestrator `agent_task` runs execute in the background lane and reuse the latest Telegram thread context for the same agent.
- Tool failures may include normalized tags like `[ERROR_CLASS=... retry=...]` to guide retry/backoff decisions.

Tools:
- `job_create`, `job_list`, `job_get`, `job_update`, `job_pause`, `job_resume`
- `job_run_now`, `job_runs`, `job_run_get`, `job_events`, `job_delete`
- `telegram_send` can proactively message the allowlisted user from scheduled jobs

Config/env:
- Config: `scheduler.*` (enabled, tick interval, failure policy)
- Env override: `NEXUS_SCHEDULER=0` disables the scheduler

### First-Time Setup (Onboarding)

Run `npm run dev -- init` for guided interactive setup, or provide `--onboarding-json` for headless setup.
Use `npm run dev -- init --force` whenever you want to re-run onboarding.

### Per-Agent Overrides

For multi-agent setups, you can create agent-specific overrides in `stateDir/agents/<agent-id>/` (default `~/.nexus/agents/<agent-id>/`):
```
~/.nexus/
├── SOUL.md                    # Default for all agents
├── agents/
│   ├── researcher/
│   │   └── SOUL.md            # Override for "researcher" agent
│   └── coder/
│       └── SOUL.md            # Override for "coder" agent
```

## Full self-modification

- Prompts: edit personalization files in `stateDir` (default `~/.nexus/`) such as `SOUL.md`, `AGENTS.md`, `USER.md`, `CODEGUIDE.md`, `HEARTBEAT.md`, `NOTES.md`.
- Code edits: `file_*` tools must use absolute paths under the code dir. Access is controlled by `permissions.allowCodeEdit` and `codeDir` in config.
- Deploy code changes with `ha_deploy` (`action:"apply"`) in HA workflows.
- `gateway_restart` is for non-HA restarts or emergency operations, not normal code rollout.
