# Config Files Reference (Himalaya)

## Default Config Path

- Default file: `~/.config/himalaya/config.toml`

## Override Config Paths

- CLI flag: `--config /abs/path/config.toml`
- Env var: `HIMALAYA_CONFIG=/abs/path/config.toml`
- Multiple config files are supported with `:` delimiter (same behavior as `$PATH` style lists).

Example:

```bash
HIMALAYA_CONFIG=/etc/himalaya/public.toml:/etc/himalaya/private.toml himalaya account list
```

## Account Basics

Accounts live under TOML tables like:

```toml
[accounts.work]
default = true
email = "me@example.com"
display-name = "Me"
```

## Example Config File

- Local example for this skill: `reference/config.example.toml`
- Quick copy:

```bash
mkdir -p ~/.config/himalaya
cp /abs/path/to/skill/reference/config.example.toml ~/.config/himalaya/config.toml
```

- Or run directly with an explicit path:

```bash
HIMALAYA_CONFIG=/abs/path/to/skill/reference/config.example.toml himalaya account list
```

## Key Config Areas Used By This Skill

- `backend.*` (receive backend, usually IMAP)
- `folder.aliases.*` (inbox/sent/drafts/trash and custom aliases)
- `folder.list.*` (folder listing defaults)
- `envelope.list.*` (page size and display defaults)
- `message.read.*` and `message.write.*`
- `message.send.backend.*` (send backend, usually SMTP)
- `message.send.save-copy`
- `message.delete.*` (safe vs hard delete behavior)
- `template.*` (new/reply/forward composition behavior)
- `signature` and `signature-delim` (account signature defaults)
- `downloads-dir` (attachment destination default)

## Security Guidance

- Prefer command/keyring-backed auth over plaintext secrets in config.
- Avoid exposing private config content in logs/tool output.

Source references:

- https://github.com/pimalaya/himalaya/blob/master/config.sample.toml
- https://github.com/pimalaya/himalaya/blob/master/src/cli.rs
- https://github.com/pimalaya/himalaya/blob/master/README.md
