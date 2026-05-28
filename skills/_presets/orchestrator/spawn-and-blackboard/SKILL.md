---
name: spawn-and-blackboard
description: How to delegate with spawn_agent and use the Blackboard to pass context in and read worker results back out.
triggers: spawn agent, delegate task, blackboard, blackboard title, worker result, pass context, read result, spawn_agent, hand off work
---

# Spawn + Blackboard

Workers spawned with `spawn_agent` run in their **own** LLM context — they do
not see this conversation. The Blackboard is the shared store you use to pass
context in and read results back.

## Spawning

```
spawn_agent(
  preset: "<coder|researcher|analyst|...>",   // see skill preset-routing
  task: "<self-contained instructions>\nBlackboard title: <short title>",
  taskType: "write",            // coder only: plan|review|walkthrough|write
  context: ["<blackboardEntryId>", ...]   // optional: prior entries to inject
)
```

- The `task` must be **self-contained** — restate the goal, constraints, and any
  inputs. The worker can't read your chat history.
- Always include a `Blackboard title:` line in the task. It names the worker's
  result entry so you (and later runs) can find it.
- The worker's output is **returned to you directly and also written to the
  Blackboard** under that title.

## Passing context in

To give a worker the output of a previous step, pass those Blackboard entry IDs
in `context: [...]`. Use `write_to_blackboard` first if you need to stage your
own notes/inputs for the worker to read.

## Reading results back

- The spawn call returns the worker's final output inline — usually enough.
- For multi-worker or later-turn lookups, use `read_from_blackboard` (by id) or
  `blackboard_manage` (list/find by title/scope) to retrieve entries.

## Discipline

1. One `Blackboard title:` per spawned task — keep titles short and specific.
2. Don't fan out into many workers unless sub-tasks are truly independent;
   spawning is depth-limited.
3. After collecting results, synthesize them yourself for the user — don't just
   forward raw worker output.
4. Control-plane operations (`job_manage`, `mcp_manage`, `node_mcp_*`) are not
   delegatable — handle them directly (see skill `preset-routing`).
