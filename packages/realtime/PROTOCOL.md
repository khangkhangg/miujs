# MiuJS rooms wire protocol (v1)

Everything a client needs to join a MiuJS realtime room from any language (Unity, Godot,
Swift, Python, a browser without the JS SDK). The protocol is plain JSON over WebSocket.

## Connecting

```
GET ws(s)://<host>/rooms/<type>/<id>?name=<name>&role=<role>&resume=<token>&hostKey=<key>
```

| Query     | Required | Meaning |
|-----------|----------|---------|
| `name`    | yes, unless `resume` or a `join` frame follows | Display name, 1-32 characters. |
| `role`    | no       | `player` (default), `host` or `spectator`. |
| `resume`  | no       | `resumeToken` from an earlier `welcome`: get your old seat back. |
| `hostKey` | no       | `hostKey` from the host's `welcome`: join as a second host device. |

- `<type>` is the room type (e.g. `quiz`); `<id>` is 1-64 of `A-Z a-z 0-9 _ -` (e.g. a 6-digit code).
- The room is created on first join. **The first non-spectator to join is the host.**
- Plain HTTP on this URL returns `426` (`MIU_E_WS_EXPECTED`); an unknown type returns `404`
  (`MIU_E_ROOM_TYPE_UNKNOWN`). Both are JSON `{ "error": { code, message, fix } }`.

If the query has no `name` and no `resume`, the connection stays open and waits for a `join` frame.

## Frames

Every frame is one JSON object (text frame) with a string field `t`. Binary frames are rejected.

### Client → server

| `t`    | Fields | Meaning |
|--------|--------|---------|
| `join` | `name`, `role?`, `resume?`, `hostKey?` | Join (same meaning as the query parameters). Only needed if the URL had no name/resume. |
| `msg`  | `type`, `data`, `id?` | A typed room message, e.g. `{"t":"msg","type":"answer","data":{"choice":2}}`. `data` must match that message's schema. `id` (any JSON value) is echoed back on an error caused by this message. |
| `ping` | — | Keep-alive; the server replies `pong`. |

### Server → client

| `t`       | Fields | Meaning |
|-----------|--------|---------|
| `welcome` | `me: {id, name, role}`, `room: {type, id}`, `resumeToken`, `resumed`, `hostKey?` | You joined. Store `resumeToken` to reconnect. `hostKey` is only sent to hosts. Sent again on the same connection if your role changes (e.g. you were promoted to host). |
| `state`   | `state` | The full room state. Sent right after `welcome` (also after a resume). Replace your copy. |
| `patch`   | `ops: [...]` | Changes since the last `state`/`patch`. Apply in order (see below). |
| `event`   | `event`, `data` | A one-off event from `room.broadcast()` / `room.send()`. |
| `error`   | `code`, `message`, `fix?`, `details?`, `id?` | Something you sent was rejected. The connection stays open unless noted. |
| `pong`    | — | Reply to `ping`. |

Ordering guarantee: state changes made by the server before it sends an `event` arrive (as a
`patch`) before that event.

## Patches

`ops` is a subset of JSON Patch ([RFC 6902](https://www.rfc-editor.org/rfc/rfc6902)):

```json
{ "t": "patch", "ops": [
  { "op": "replace", "path": "/phase", "value": "reveal" },
  { "op": "add",     "path": "/players/p_1a2b", "value": { "name": "Ann", "score": 0 } },
  { "op": "remove",  "path": "/players/p_9z8y" }
] }
```

- `path` is a JSON Pointer ([RFC 6901](https://www.rfc-editor.org/rfc/rfc6901)): segments split by `/`,
  with `~1` meaning `/` and `~0` meaning `~` inside a key. `""` is the whole document.
- `add` and `replace` both mean "set this key to `value`"; `remove` means "delete this key".
- **Arrays are always replaced whole** (the path never points inside an array), so a client only
  needs to walk objects. Full apply algorithm:

```
for op in ops:
  if op.path == "": doc = op.value (unless remove); continue
  keys = op.path[1:].split("/").map(unescape)      # unescape: "~1"→"/", then "~0"→"~"
  parent = doc; for k in keys[:-1]: parent = parent[k]
  if op.op == "remove": delete parent[keys[-1]] else parent[keys[-1]] = op.value
```

## Reconnecting

When a connection drops, the player keeps their seat for **30 seconds** (configurable per room
with `reconnectMs`). Reconnect with `?resume=<resumeToken>`: you get a `welcome` with the same
`me.id` and `resumed: true`, then a full `state`. After the grace period the player is removed
(the room's `onLeave` runs) and the token stops working: resuming then fails with
`MIU_E_ROOM_RESUME_EXPIRED`, unless you also pass `name`, in which case you join as a new player.

If the same player connects twice, the older connection is closed with code `4001`.

## Close codes

| Code | Meaning | Reconnect? |
|------|---------|------------|
| 1000 | Room closed normally | no |
| 4001 | Replaced by a newer connection for the same player | no |
| 4003 | `MIU_E_ROOM_HOST_KEY`: asked for `host` without the right `hostKey` | no |
| 4004 | `MIU_E_ROOM_CLOSED`: room was closed | no |
| 4005 | `MIU_E_ROOM_FULL` | no |
| other | Network problem / server restart | yes, with `resume` |

## Error codes

| Code | When |
|------|------|
| `MIU_E_ROOM_BAD_FRAME` | Not JSON, not an object, binary, or unknown `t`. |
| `MIU_E_ROOM_JOIN_INVALID` | Missing/too long name, unknown role. |
| `MIU_E_ROOM_ALREADY_JOINED` | A second `join` on one connection. |
| `MIU_E_ROOM_NOT_JOINED` | `msg` before joining. |
| `MIU_E_ROOM_RESUME_EXPIRED` | Unknown or expired resume token and no name. |
| `MIU_E_ROOM_HOST_KEY` | Asked to be host without the right key (connection closed, 4003). |
| `MIU_E_ROOM_FULL` | `maxPlayers` reached (connection closed, 4005). |
| `MIU_E_ROOM_CLOSED` | The room was closed (connection closed, 4004). |
| `MIU_E_ROOM_UNKNOWN_MESSAGE` | `msg.type` is not one of the room's client messages (`fix` lists them). |
| `MIU_E_ROOM_MESSAGE_INVALID` | `msg.data` failed validation; `details.issues` and `details.schema` (JSON Schema) say why. |
| `MIU_E_ROOM_HANDLER_FAILED` | The server handler crashed; state was rolled back. |
| `MIU_E_ROOM_STATE_INVALID` | The handler produced state that breaks the schema; rolled back. |
| any other `MIU_E_*` | Thrown by the room's own handler (e.g. `MIU_E_FORBIDDEN`). |

Errors never close the room and, unless listed above, never close your connection.

## Example session

```
→ (connect) ws://localhost:3000/rooms/quiz/123456?name=Ann
← {"t":"welcome","me":{"id":"p_1a2b3c","name":"Ann","role":"player"},"room":{"type":"quiz","id":"123456"},"resumeToken":"9f…","resumed":false}
← {"t":"state","state":{"phase":"lobby","round":-1,"players":{"p_1a2b3c":{"name":"Ann","score":0,"gained":0}},…}}
← {"t":"patch","ops":[{"op":"replace","path":"/phase","value":"question"},…]}
→ {"t":"msg","type":"answer","data":{"choice":2},"id":1}
← {"t":"patch","ops":[{"op":"replace","path":"/answered","value":["p_1a2b3c"]}]}
→ {"t":"msg","type":"answer","data":{"choice":1},"id":2}
← {"t":"error","code":"MIU_E_QUIZ_ALREADY_ANSWERED","message":"You already answered this question","fix":"Wait for the reveal.","id":2}
```

## Cloudflare

On Workers each room is one Durable Object named `"<type>:<id>"` (binding `MIU_ROOMS` by
default). The wire protocol is identical.
