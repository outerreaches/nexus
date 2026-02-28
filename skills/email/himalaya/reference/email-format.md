# Email Format Reference (Himalaya)

Himalaya message commands operate on raw email messages as **headers + blank line + body**.

## Raw Message Shape

1. Headers at the top, one per line, `Key: Value`.
2. One blank line.
3. Message body.

Example:

```text
From: Example <example@localhost>
To: Recipient <recipient@example.com>
Subject: Hello from Himalaya

This is the message body.
```

## Notes From Upstream Implementation

- Himalaya describes messages as headers/body separated by two new lines in `src/email/message/command/mod.rs`.
- `message send` accepts raw message content from either:
  - message arguments (`himalaya message send ...`)
  - stdin pipe (preferred for full raw messages)
- When reading raw message content, line endings are normalized to CRLF internally before sending (`\r\n`).

## Template (MML) Support

Himalaya also supports template workflows (`template` subcommand) that use MML for richer composition (attachments/encryption).

Source references:

- https://github.com/pimalaya/himalaya/blob/master/src/email/message/command/mod.rs
- https://github.com/pimalaya/himalaya/blob/master/src/email/message/command/send.rs
- https://github.com/pimalaya/himalaya/blob/master/src/email/message/template/command/mod.rs
