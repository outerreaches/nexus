# Nexus

Lightweight, always-on multi-agent assistant (OpenClaw-inspired), starting with:
- Gateway process (HTTP status + Telegram bot)
- OpenRouter + OpenAI-compatible local models (LM Studio / Ollama) via a single OpenAI-compat client
- Self-modifiable prompts via state personalization files (`SOUL.md`, `AGENTS.md`, `USER.md`, `CODEGUIDE.md`, etc.)
- Basic tool loop (file ops, web search/fetch, guarded shell exec, managed browser, paper trade logging)

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
- Default model is `moonshot/kimi-k2.5` (override via `llm.openaiCompat.model`).
- `OPENROUTER_API_KEY`
- `BRAVE_API_KEY` (optional; enables `web_search` via Brave)
- `PERPLEXITY_API_KEY` (optional; enables `web_search` via Perplexity direct)
- `TELEGRAM_BOT_TOKEN`

5) Start the gateway:
```bash
npm run dev -- gateway --verbose
```

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
- `web_fetch`: keyless HTTP fetch + basic extraction (timeouts, redirect limits, small cache)

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
- Use `telegram_send_file` to send files back to users by path.
- Env tuning:
  - `NEXUS_TELEGRAM_MAX_INBOUND_FILES_PER_MESSAGE` (default `5`)
  - `NEXUS_TELEGRAM_MAX_INBOUND_FILE_BYTES` (default `20971520` = 20 MB)
  - `NEXUS_TELEGRAM_FILE_BLACKBOARD_TTL_MS` (default `2592000000` = 30 days)
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
- `permissions.allowCodeEdit` (config) controls whether `file_*` tools may target the running codebase via `root:"code"`.
- `permissions.allowCodeWrite` (config) or `NEXUS_ALLOW_CODE_WRITE=1` enables code-root writes (`file_write`/`file_edit`/`file_edit_lines`).
- `NEXUS_TELEGRAM_ALLOW_ALL=1` allows any Telegram user if `channels.telegram.allowFrom` is empty (not recommended).

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

Drop tools into `stateDir/tools/` (default `~/.nexus/tools/`) and call `tools_reload` to load them without restarting:
- `*.tool.json` (built-in simple types: `shell`, `http`)
- `*.tool.mjs` (arbitrary JavaScript module; full power)

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

Enable via env (simplest in Docker):
- `NEXUS_PROACTIVE=1`
- Optional tuning: `NEXUS_PROACTIVE_INTERVAL_MS`, `NEXUS_PROACTIVE_MAX_INTERVAL_MS`, `NEXUS_PROACTIVE_JITTER_MS`
- `NEXUS_PROACTIVE_NOTIFY_TELEGRAM=1` sends non-idle outputs to allowlisted Telegram user ids

Or via config (`stateDir/nexus.json`): `proactive.enabled`, `proactive.intervalMs`, etc.

### Internal Scheduler (Cron Jobs)

Nexus includes an internal **cron scheduler** (no external cron or Python scripts required).

Key behavior:
- Jobs are **owned by the agent that creates them** (important for future multi-agent swarms).
- When a job run fails, the gateway notifies the **owning agent** (not the user) so it can self-heal and decide whether to notify you.

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
- Code edits: `file_*` tools can target `root:"code"` (or absolute paths under the code dir). This is controlled by `permissions.allowCodeEdit` and `codeDir` in config.
- Deploy code changes with `ha_deploy` (`action:"apply"`) in HA workflows.
- `gateway_restart` is for non-HA restarts or emergency operations, not normal code rollout.
