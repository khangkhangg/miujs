# MiuJS realtime for Godot 4 (GDScript)

`miu_realtime.gd` is a single-file client for MiuJS realtime rooms and `@miujs/game` matches. It
uses Godot's `WebSocketPeer` and speaks the JSON wire protocol in
[`packages/realtime/PROTOCOL.md`](../../packages/realtime/PROTOCOL.md): welcome, state, patch,
event, error, ping/pong, and reconnecting with the resume token.

## Install

Copy `miu_realtime.gd` into your project (for example `res://addons/miu/`). It registers the
`MiuRealtime` class. Requires **Godot 4.x**. Web exports work too, since `WebSocketPeer` maps to the
browser WebSocket.

## Quick start (matchmaking)

```gdscript
extends Node

var room := MiuRealtime.new()

# room_url and ticket come from GET /match/ranked/status once state == "matched"
# (or from the notify WebSocket). Tickets are short-lived: connect right away.
func play(room_url: String, ticket: String) -> void:
	add_child(room)                      # polls the socket in _process()
	room.ticket = ticket
	room.seated.connect(func(seat): print("playing as team ", int(seat["team"])))
	room.state_changed.connect(func(state, _ops): render(state))
	room.event_received.connect(func(event_name, data): print(event_name, data))
	room.error_received.connect(func(code, message, fix): push_warning("%s: %s → %s" % [code, message, fix]))
	room.connect_to_room(room_url, "Ann")

func move(cell: int) -> void:
	room.send_msg("move", {"cell": cell})

func render(state) -> void:
	pass
```

- The node must be in the tree, because `_process()` polls the socket and raises signals on the
  main thread.
- Godot parses every JSON number as `float`. Use `int(state["score"])` where you need ints.
- `send_msg()` before the welcome (or while reconnecting) is queued and flushed once joined.
- `state` is patched in place. Use `state.duplicate(true)` to keep a snapshot.

## Signals and behaviour

| Frame / situation | Behaviour |
|---|---|
| connect | Game rooms: the ticket goes in the URL (`?ticket=`). The server refuses the upgrade without a genuine ticket, or without a pure `?resume=`. |
| `welcome` | Sets `me`, `resume_token` and `host_key` (hosts only), then emits `welcomed`. On a fresh join it sends `ticket` as `{"t":"msg","type":"ticket","data":{"ticket":…}}`, then flushes queued messages. |
| `state` | Replaces `state` and emits `state_changed(state, [])`. |
| `patch` | Applies the ops with the PROTOCOL.md algorithm (`MiuRealtime.apply_patch`) and emits `state_changed(state, ops)`. |
| `event` | Emits `event_received(name, data)`. A `seated` event also emits `seated(seat)`. |
| `error` | Emits `error_received(code, message, fix)`. |
| `pong` | Counts `pongs`. A ping goes out every `ping_interval_sec` (default 20). |
| close 1000/1003/1009/4001/4003/4004/4005/4008/4009 | Emits `closed(code, reason, false)` and stops. |
| any other close / network loss | Emits `closed(…, true)` and `reconnecting(attempt, delay)`, then reconnects with `?resume=<token>` and exponential backoff. |

To resume after a restart, save `resume_token` and pass it as `connect_to_room(url, name, { "resume": token })`.

## Conformance

[`clients/protocol-vectors.json`](../protocol-vectors.json) holds the shared vectors: patch cases,
server-frame sessions, diff outputs, reconnect rules and client frame shapes. Run them headless:

```bash
godot --headless --path clients/godot --script res://tests/run_vectors.gd -- ../protocol-vectors.json
```

From code, `MiuRealtime.run_vectors(text)` returns an empty array when the client is conformant.

**Status:** `packages/game/test/protocol-vectors.test.ts` runs a line-by-line JS transcription of
the same algorithm against these vectors. The Unity client also runs them for real. This GDScript
file has **not** been run in Godot from this repo, because no Godot binary is available in CI. Run
the command above once before you rely on it. MessagePack is not supported (JSON only).
