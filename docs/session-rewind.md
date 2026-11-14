# Session rewind

A Rexa fork patch: `_sh.rexa/session/rewind` discards a session's history after
one message, in place. It is ACP RFD #1321's `session/rewind` under Rexa's
name, so moving to the standard method is a rename. Served on ACP v1 and v2.

## Capability

`initialize` advertises it, on every connection:

- v1: `agentCapabilities._meta["sh.rexa/sessionRewind"] = {}`
- v2: `capabilities._meta["sh.rexa/sessionRewind"] = {}`

## Request

```json
{"sessionId": "<session>", "toMessageId": "<message>"}
```

`toMessageId` is a `messageId` the adapter sent for this session on a message
chunk, live or replayed: an agent message, a thought, a user message (its Codex
item id on v1, the client id on v2), or a v2 review message.

## Outcomes

- **Rewound:** the adapter calls the app-server's
  `thread/revert {threadId, beforeTurnId}` with the turn after the one holding
  `toMessageId`, and answers `{lastMessageId}`, the last message kept. Same
  session id, same thread.
- **Whole turns:** Codex reverts turns, not messages. A message inside a turn
  keeps the rest of that turn, and `lastMessageId` names its last message, so
  it can follow `toMessageId`.
- **Nothing after it:** a message in the last turn changes nothing and answers
  `{lastMessageId}`.
- **Durable:** Codex writes a new rollout that references the kept prefix and
  moves the thread's pointer to it; a later `session/resume` or `session/load`,
  in a new process too, sees only the kept turns.

## Errors

| Case | Code | `data.reason` |
| --- | --- | --- |
| No message with that id | `-32002` | `unknown_message_id` |
| A turn runs, or a prompt waits to start one | `-32600` | `turn_running` |
| Legacy (non-paginated) Codex history with turns to discard | `-32600` | `unsupported_history` |
| Session not open on this connection | `-32002` | none |

A prompt sent while the revert runs starts its turn after it.

## The reload

`thread/revert` shuts the thread's runtime down and loads it again. The client
sees none of it:

- **Hidden:** while the revert runs, the adapter drops every notification of
  the session's own thread: the `notLoaded` and `idle` status changes, the
  startup warnings Codex repeats, and anything else the reload sends. The
  window closes once the notifications that came before the revert's answer
  are handled. A turn Codex starts on the thread (`turn/started`, or an
  `active` status) ends it at once, so nothing a turn sends is dropped.
  Subagent threads are not filtered.
- **Session list:** `_session/list/subscribe` skips the reload's status
  changes and refreshes the row once on `thread/reverted`.
- **Context usage:** the adapter keeps the usage Codex reported for each turn
  and, after the revert, sends a `usage_update` with that of the newest kept
  turn. A turn that reported no usage to this process (one from before a
  `session/resume`) leaves the last value until the next turn.
- **Also cleared:** a predicted follow-up prompt; background terminals are
  read again.

What the reload still does, outside the client's view:

- runs the user's SessionEnd hooks, and drops pending async hook results;
- stops and restarts the thread's MCP servers, losing their state;
- ends the thread's background terminals and code-mode session;
- shuts down running subagents; the subagent threads of discarded turns stay
  in the store.

Files are not restored: a file a discarded turn wrote or edited stays as it
is. The client keeps its own checkpoints.
