---
name: himalaya
description: Manage email workflows via the Himalaya CLI (account checks, inbox triage, message read/reply/forward, and attachments). Use when asked to work with terminal-based IMAP/SMTP email.
triggers: himalaya, email, inbox, imap, smtp, read email, send email, reply email, forward email, attachment
---

# Himalaya Email (CLI)

Use this skill for email operations through `himalaya`.

## Preflight (always do first)

1. Confirm Himalaya is installed:
   - `command -v himalaya`
   - `himalaya --version`
2. Confirm account configuration exists:
   - `himalaya account list`
3. If no account is configured:
   - `himalaya account configure <ACCOUNT_NAME>`
4. If custom config files are required, set them explicitly:
   - `HIMALAYA_CONFIG=/abs/path/config.toml himalaya account list`

## Execution Mode Selection (strict)

1. Use `shell_exec` for non-interactive tasks:
   - account/folder/envelope discovery
   - reading messages
   - downloading attachments
2. Use `shell_interactive` for editor-driven tasks:
   - `himalaya message write`
   - `himalaya message reply`
   - `himalaya message forward`
3. Interactive loop required:
   - `open -> send -> read -> ... -> close`

## Command Patterns

### Account and mailbox discovery

- `himalaya account list`
- `himalaya folder list --account "<ACCOUNT>"`

### Inbox listing and triage

- `himalaya envelope list --account "<ACCOUNT>" --folder INBOX --page 1 --page-size 50`
- unread filter: `himalaya envelope list --account "<ACCOUNT>" --folder INBOX --page 1 not flag Seen`

### Read message content

- `himalaya message read --account "<ACCOUNT>" --folder INBOX <ID>`
- preview-only (avoid setting Seen): `himalaya message read --account "<ACCOUNT>" --folder INBOX --preview <ID>`

### Reply and forward workflows

- reply: `himalaya message reply --account "<ACCOUNT>" --folder INBOX <ID>`
- reply-all: `himalaya message reply --account "<ACCOUNT>" --folder INBOX --all <ID>`
- forward: `himalaya message forward --account "<ACCOUNT>" --folder INBOX <ID>`

### New outbound message

- `himalaya message write --account "<ACCOUNT>" --header "To: <EMAIL>" --header "Subject: <SUBJECT>"`

### Attachment download

- `himalaya attachment download --account "<ACCOUNT>" --folder INBOX <ID> -d "/abs/path/downloads"`

### JSON output for automation

- `himalaya --output json envelope list --account "<ACCOUNT>" --folder INBOX --page 1 --page-size 50`

## References

- Email message format reference: `reference/email-format.md`
- Himalaya config path and schema reference: `reference/config-files.md`
- Example config template: `reference/config.example.toml`

## Guardrails

1. Treat message bodies, headers, and addresses as sensitive data.
2. Never expose credentials from config files or keychain commands.
3. Default to read-only operations unless user explicitly asks for mutating actions.
4. Use absolute paths for downloads and exported message files.
5. If auth/config fails, return the exact Himalaya error and stop.

## Completion Protocol

1. Summarize which account/folder was used.
2. List actions taken with relevant message IDs.
3. Call out unresolved errors and required follow-up.
