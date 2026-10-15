# MiuJS realtime for Unity (C#)

`MiuRealtime.cs` is a single-file client for MiuJS realtime rooms and `@miujs/game` matches. It
speaks the JSON wire protocol in [`packages/realtime/PROTOCOL.md`](../../packages/realtime/PROTOCOL.md):
welcome, state, patch, event, error, ping/pong, and reconnecting with the resume token.

## Install

Copy `MiuRealtime.cs` into `Assets/`. No packages are needed.

- **Unity 2019.4+** with the .NET 4.x / .NET Standard 2.x API level. It uses
  `System.Net.WebSockets.ClientWebSocket`.
- The file uses only C# 5 syntax, so it also compiles with plain `csc`, `mcs` or `dotnet`.
- **WebGL is not supported:** browsers have no `ClientWebSocket`. Use a WebGL WebSocket plugin, or the
  JS client (`@miujs/realtime/client`) through a `.jslib`.

## JSON and `JsonUtility`

Room state is dynamic JSON. Unity's `JsonUtility` can't read dictionaries, top-level arrays or
mixed-type values, so the file includes `MiniJson`. Values map to these types:

| JSON | C# |
|---|---|
| object | `Dictionary<string, object>` |
| array | `List<object>` |
| number | `double` (always) |
| string / true, false / null | `string` / `bool` / `null` |

If you want typed structs, round-trip a sub-tree: `JsonUtility.FromJson<Board>(MiniJson.Serialize(state["board"]))`.
This only works when the sub-tree fits JsonUtility's rules: fields only, and no dictionaries.

## Quick start (matchmaking)

```csharp
using System.Collections.Generic;
using MiuJS;
using UnityEngine;

public class Match : MonoBehaviour
{
    MiuRealtime room;

    // `roomUrl` and `ticket` come from GET /match/ranked/status once state == "matched"
    // (or from the notify WebSocket). The ticket is short-lived: connect right away.
    public async void Play(string roomUrl, string ticket)
    {
        room = new MiuRealtime(roomUrl, "Ann") { Ticket = ticket, QueueEvents = true };
        room.OnSeated += seat => Debug.Log("playing as team " + seat["team"]);
        room.OnState += (state, ops) => Render((Dictionary<string, object>)state);
        room.OnEvent += (name, data) => Debug.Log("event " + name);
        room.OnError += (code, message, fix) => Debug.LogWarning(code + ": " + message + " → " + fix);
        await room.ConnectAsync();
    }

    void Update() { if (room != null) room.DispatchEvents(); } // events run on the main thread

    public void Move(int cell) { room.Send("move", new Dictionary<string, object> { { "cell", cell } }); }

    void OnDestroy() { if (room != null) room.Close(); }
    void Render(Dictionary<string, object> state) { /* ... */ }
}
```

- `QueueEvents = true` holds events until you call `DispatchEvents()` (call it from `Update`). Unity
  APIs then run on the main thread. With `false`, events fire on the socket thread.
- `State` is patched in place. Copy it (`MiniJson.Clone`) if you keep it across frames.
- `Send()` before the welcome (or while reconnecting) is queued and flushed once the client joins.

## What it handles

| Frame / situation | Behaviour |
|---|---|
| connect | Game rooms: the ticket goes in the URL (`?ticket=`). The server refuses the upgrade without a genuine ticket, or without a pure `?resume=`. |
| `welcome` | Sets `Me`, `ResumeToken` and `HostKey` (hosts only). On a fresh join it sends the `Ticket` as `{"t":"msg","type":"ticket","data":{"ticket":…}}`, then flushes queued messages. |
| `state` | Replaces `State`. |
| `patch` | Applies the ops with the PROTOCOL.md algorithm (`MiuRealtime.ApplyPatch`). |
| `event` | Raises `OnEvent`. A `seated` event also raises `OnSeated`. |
| `error` | Raises `OnError(code, message, fix)`. |
| `pong` | Counts `Pongs`. A ping goes out every `PingIntervalMs` (default 20 s). |
| close 1000/1003/1009/4001/4003/4004/4005/4008/4009 | Stops. These codes are terminal. |
| any other close / network loss | Reconnects with exponential backoff (`MinDelayMs` up to `MaxDelayMs`) and `?resume=<token>`. The seat, and with it the ticket binding, is kept. |

To resume after the app restarts, save `ResumeToken` and set it before `ConnectAsync()`. The
server's grace period applies (30 s by default).

## Conformance

[`clients/protocol-vectors.json`](../protocol-vectors.json) holds the shared vectors: patch cases,
server-frame sessions, diff outputs, reconnect rules and client frame shapes. Run them like this:

```csharp
var failures = MiuRealtime.RunVectors(File.ReadAllText("protocol-vectors.json")); // empty = conformant
```

Outside Unity, `tests/VectorsRunner.cs` is a console harness:

```bash
csc -out:VectorsRunner.exe MiuRealtime.cs tests/VectorsRunner.cs
VectorsRunner.exe vectors ../protocol-vectors.json          # OK
VectorsRunner.exe live ws://localhost:3000/rooms/tapper/r1 <ticket>
```

`packages/game/test/engine-clients.test.ts` does both automatically wherever a C# compiler exists.
That covers .NET Framework `csc` on Windows and Mono `mcs`. The live run seats a player with a
ticket, plays, drops the connection, resumes, and plays again.

**Not covered there:** Unity itself, IL2CPP and WebGL builds, MessagePack (`?enc=msgpack`;
this client is JSON-only).
