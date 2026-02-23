# Node Fleet Inventory

Inventory files are used by gateway-side rollout loops for reference-node and reference-node-lite upgrades.

Format:

- One SSH target per line (`user@host`, IP, or SSH config alias).
- Blank lines are allowed.
- Lines starting with `#` are comments.

Recommended files:

- `infra/node-fleet/lite-canary.txt` — canary `reference-node-lite` hosts
- `infra/node-fleet/lite-prod.txt` — production `reference-node-lite` hosts
- `infra/node-fleet/host-canary.txt` — canary host-mode `reference-node` hosts
- `infra/node-fleet/host-prod.txt` — production host-mode `reference-node` hosts

Example:

```text
# canary nodes
nexus@10.10.20.11
nexus@10.10.20.12
```
