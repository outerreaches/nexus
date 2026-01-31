# Nexus

Lightweight, always-on multi-agent assistant (OpenClaw-inspired), starting with:
- Gateway process (HTTP status + Telegram bot)
- OpenRouter + OpenAI-compatible local models (LM Studio / Ollama) via a single OpenAI-compat client
- Self-modifiable prompts via workspace personalization files (SOUL.md, IDENTITY.md, USER.md, etc.)
- Basic tool loop (file ops, web search/fetch, guarded shell exec, managed browser, paper trade logging)

## Quick start

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

To skip the interactive prompts and use defaults:
```bash
npm run dev -- init --skip-onboarding
```

4) Edit your config (default location is `~/.nexus/nexus.json`) and set secrets:
- `OPENROUTER_API_KEY`
- `BRAVE_API_KEY` (optional; enables `web_search` via Brave)
- `PERPLEXITY_API_KEY` (optional; enables `web_search` via Perplexity direct)
- `TELEGRAM_BOT_TOKEN`

5) Start the gateway:
```bash
npm run dev -- gateway --verbose
```

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
  - `nexus pairing list telegram`
  - `nexus pairing approve telegram <CODE>`

Human-action responses (OTP/MFA/etc) without leaking secrets into the LLM:
- The agent will create a request id via `human_request`.
- Reply to the bot with: `/act <ID> <your response>` (this stores the response in state and nudges the agent to continue; the secret is not sent through the model).
- To fill an OTP field in the browser without exposing it to the model, use `browser` action `type_action` with `actionId=<ID>`.

Delivery modes:
- `channels.telegram.mode="polling"` (default): simplest, works anywhere.
- `channels.telegram.mode="webhook"`: requires `channels.telegram.webhookUrl` or `channels.telegram.webhookPublicUrl` and exposes `channels.telegram.webhookPath` on the gateway HTTP server.

## Gmail (OAuth API)

For Gmail, the recommended approach is the official Gmail API (OAuth2), not browser-login automation.

1) Create OAuth credentials (Desktop app) and enable Gmail API in Google Cloud.

2) Set env vars:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

3) Run authorization (stores tokens under `stateDir/gmail/oauth.json`):
```bash
nexus gmail auth
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
- `NEXUS_TELEGRAM_ALLOW_ALL=1` allows any Telegram user if `channels.telegram.allowFrom` is empty (not recommended).

## Custom tools

Drop tools into `~/.nexus/tools/` and call `tools_reload` to load them without restarting:
- `*.tool.json` (built-in simple types: `shell`, `http`)
- `*.tool.mjs` (arbitrary JavaScript module; full power)

## Personalization & Soul Files

Nexus uses a workspace-based personalization system inspired by [OpenClaw](https://github.com/openclaw/openclaw). All personalization files live in `~/.nexus/workspace/`:

| File | Purpose |
|------|---------|
| `SOUL.md` | Agent persona, philosophy, personality, boundaries |
| `IDENTITY.md` | Agent name, emoji, avatar, vibe |
| `USER.md` | Your profile — name, timezone, preferences, context |
| `AGENTS.md` | Operating instructions, memory strategy, rules |
| `TOOLS.md` | Tool usage guidelines and restrictions |
| `HEARTBEAT.md` | Optional proactive task checklist |
| `NOTES.md` | Persistent scratchpad across sessions |

### Proactive Heartbeat (Always-On)

When enabled, the gateway runs periodic **proactive heartbeat ticks** that prompt the agent to review `HEARTBEAT.md` and take small, high-value actions. If there is nothing to do, the agent should respond `IDLE` and the scheduler will back off automatically.

Enable via env (simplest in Docker):
- `NEXUS_PROACTIVE=1`
- Optional tuning: `NEXUS_PROACTIVE_INTERVAL_MS`, `NEXUS_PROACTIVE_MAX_INTERVAL_MS`, `NEXUS_PROACTIVE_JITTER_MS`
- `NEXUS_PROACTIVE_NOTIFY_TELEGRAM=1` sends non-idle outputs to allowlisted Telegram user ids

Or via config (`stateDir/nexus.json`): `proactive.enabled`, `proactive.intervalMs`, etc.

### First-Time Setup (Onboarding)

When you run `nexus init` for the first time, an interactive onboarding wizard guides you through creating these files with your preferences.

To re-run onboarding later:
```bash
npm run dev -- onboard           # Only runs if files don't exist
npm run dev -- onboard --force   # Overwrites existing files
```

### Per-Agent Overrides

For multi-agent setups, you can create agent-specific overrides in `~/.nexus/workspace/agents/<agent-id>/`:
```
~/.nexus/workspace/
├── SOUL.md                    # Default for all agents
├── agents/
│   ├── researcher/
│   │   └── SOUL.md            # Override for "researcher" agent
│   └── coder/
│       └── SOUL.md            # Override for "coder" agent
```

## Full self-modification

- Prompts: edit personalization files in `~/.nexus/workspace/` (SOUL.md, IDENTITY.md, USER.md, etc.).
- Code edits: `file_*` tools can target `root:"code"` (or absolute paths under the code dir). This is controlled by `permissions.allowCodeEdit` and `codeDir` in config.
- Restart: call `gateway_restart` after changing code/config.
