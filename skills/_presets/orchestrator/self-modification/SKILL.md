---
name: self-modification
description: How the orchestrator ships a code change to Nexus itself — always by delegating to a coder, never by editing or deploying directly.
triggers: self-modify, self modification, modify code, change the code, edit the code, code change, fix a bug, add a feature, update nexus, change nexus, improve nexus, ship a change, deploy a change, ha_deploy, deploy the code, patch the code
---

# Self-Modification (orchestrator)

Use this whenever the user asks to change Nexus's own code — a bug fix, a new
feature, a refactor, or a "deploy this change" request.

## The one rule

**You do not edit repository code, and you do not deploy. A `coder` does both.**

- The file tools will reject any write you make under the code root or a
  candidate workspace (`the 'orchestrator' agent must not edit repository code
  directly`). That rejection is expected — it is not a bug to work around.
- `ha_deploy` is not in your toolset. It belongs to the `coder` (and
  `security-researcher`) presets. You cannot `tool_load` it; do not go looking
  for it in runtime generations, and do not suggest restarting the process.

Your job is to **delegate, relay, and confirm** — not to author or ship.

## The flow

1. **Spawn a coder** with `taskType: "write"` and a precise task. Include a
   `Blackboard title:` line so you can read the result back.

   ```
   spawn_agent(
     preset: "coder",
     taskType: "write",
     task: "<concrete change>. Follow the full edit → typecheck → build →
            ha_deploy apply flow. If ha_deploy returns APPROVAL REQUIRED,
            report the approval ID and stop — do not invent IDs.
            Blackboard title: <short title>"
   )
   ```

   The coder gets its own candidate workspace (a clone of the live checkout),
   edits there, verifies with `typecheck`+`build`, and calls `ha_deploy`.

2. **Handle approval.** Changes to `src/**` (tools/core/shared paths) are
   approval-gated. The coder's first `ha_deploy apply` returns
   `APPROVAL REQUIRED: ... <approvalId>`. When you see this:
   - Relay the approval ID and the change summary to the **user**.
   - Tell them to approve via `/act <approvalId> approve` (Telegram) or
     `nexus actions respond <approvalId> approve` (CLI).
   - **Stop.** Do not invent or guess approval IDs. Do not claim the deploy
     succeeded. Approval only authorizes the backend to continue the rollout.

3. **After approval**, the backend deploy-approval worker continues the deploy
   automatically (verify cache → write trigger → host rollout). You do not need
   to re-run anything. Use `ha_deploy action='status'` via the coder only if the
   user asks for rollout status.

4. **Confirm honestly.** A deploy is "done" only after rollout completion
   (traffic switched to the new code), not at approval time. Read the coder's
   result from the blackboard and report the final status.

## After a successful deploy

- The change runs in a **new** process image. Do **not** validate new runtime
  behavior, schemas, or tools in the same request cycle — this cycle is still
  the old image. Hand the user concrete follow-up validation steps for a fresh
  run instead.

## Common failure modes (don't repeat them)

- **Editing the file yourself** → blocked by file-ops policy. Delegate instead.
- **Looking for `ha_deploy` in your own tools / asking to restart** → it is not
  yours by design. Delegate the deploy to the coder.
- **Inventing an approval ID or claiming success after approval** → approval is
  not deployment. Wait for rollout completion.
- **Doc-only changes** (`.md`, images) are rejected by `ha_deploy` — those don't
  need a deploy; have the coder commit and push them directly.

## Completion protocol

1. Report what changed and which coder run produced it.
2. State the deploy outcome: pending-approval (with ID), rolling out, or
   finalized — and where you read that from.
3. If finalized, give the user follow-up validation steps for a fresh run.
