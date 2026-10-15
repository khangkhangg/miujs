// MiuRealtime.cs - MiuJS realtime rooms client for Unity and .NET (wire protocol v1, JSON frames).
//
// One file, no packages: System.Net.WebSockets.ClientWebSocket plus a tiny JSON codec (MiniJson),
// because Unity's JsonUtility cannot read dynamic JSON (no dictionaries, no top-level arrays, no
// polymorphic values) and room state is dynamic. Written in C# 5 syntax so it compiles on every
// Unity version and on plain .NET.
//
//   var room = new MiuJS.MiuRealtime("wss://game.example/rooms/arena/r1a2b3", "Ann");
//   room.Ticket = status.ticket;          // from GET /match/:queue/status (game rooms)
//   room.QueueEvents = true;              // Unity: raise events on the main thread...
//   room.OnState += (state, ops) => Render(state);
//   room.OnEvent += (name, data) => Debug.Log(name);
//   await room.ConnectAsync();
//   void Update() { room.DispatchEvents(); } // ...from Update()
//   room.Send("move", new Dictionary<string, object> { { "x", 1 } });
//
// JSON values map to: object (Dictionary<string, object>), array (List<object>), string, double
// (every number), bool, null. See README.md.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace MiuJS
{
    public sealed class MiuRealtime : IDisposable
    {
        /// <summary>Close codes after which reconnecting would not help (PROTOCOL.md "Close codes").</summary>
        public static readonly int[] TerminalCloseCodes = { 1000, 1003, 1009, 4001, 4003, 4004, 4005, 4008, 4009 };

        // ---- options ---------------------------------------------------------------------------
        public string Url { get; private set; }
        /// <summary>Display name (1-32 characters). Sent as ?name= on fresh joins.</summary>
        public string Name;
        /// <summary>"player" (default), "host" or "spectator".</summary>
        public string Role;
        public string HostKey;
        /// <summary>From the last welcome; sent as ?resume= when reconnecting. Persist it to resume after an app restart.</summary>
        public string ResumeToken;
        /// <summary>Game rooms: the match ticket. Sent as ?ticket= on connect (checked before the upgrade) and as {"t":"msg","type":"ticket"} after every fresh welcome.</summary>
        public string Ticket;
        public bool AutoReconnect = true;
        public int MinDelayMs = 250;
        public int MaxDelayMs = 5000;
        public int MaxAttempts = int.MaxValue;
        /// <summary>Send {"t":"ping"} this often while connected (0 = never).</summary>
        public int PingIntervalMs = 20000;
        /// <summary>True: events wait in a queue until DispatchEvents() (call it from Unity's Update). False: raised on the socket thread.</summary>
        public bool QueueEvents = false;

        // ---- state -----------------------------------------------------------------------------
        /// <summary>Latest room state (or your view of it). Patched in place; copy it if you keep it across frames.</summary>
        public object State { get; private set; }
        /// <summary>{ id, name, role } from the welcome frame.</summary>
        public Dictionary<string, object> Me { get; private set; }
        public bool Joined { get; private set; }
        public int Pongs { get; private set; }
        public int Welcomes { get; private set; }

        // ---- events ----------------------------------------------------------------------------
        public event Action OnOpen;
        /// <summary>The whole welcome frame (me, room, resumeToken, resumed, hostKey?).</summary>
        public event Action<Dictionary<string, object>> OnWelcome;
        /// <summary>New state and the ops that produced it (empty for a full state).</summary>
        public event Action<object, List<object>> OnState;
        /// <summary>A room event: name and data.</summary>
        public event Action<string, object> OnEvent;
        /// <summary>Game rooms: your ticket was accepted (userId, name, team, matchId).</summary>
        public event Action<Dictionary<string, object>> OnSeated;
        /// <summary>code, message, fix (fix may be null).</summary>
        public event Action<string, string, string> OnError;
        /// <summary>close code, reason, willReconnect.</summary>
        public event Action<int, string, bool> OnClose;
        /// <summary>attempt, delay in ms.</summary>
        public event Action<int, int> OnReconnecting;

        private readonly object gate = new object();
        private readonly Queue<string> outbox = new Queue<string>();
        private readonly Queue<Action> pending = new Queue<Action>();
        private readonly SemaphoreSlim sendLock = new SemaphoreSlim(1, 1);
        private ClientWebSocket ws;
        private CancellationTokenSource cts;
        private bool closedByUser;
        private int attempt;

        public MiuRealtime(string url, string name)
        {
            Url = url;
            Name = name;
        }

        public static bool IsTerminal(int code)
        {
            return Array.IndexOf(TerminalCloseCodes, code) >= 0;
        }

        /// <summary>Open the connection (the first welcome arrives through OnWelcome).</summary>
        public Task ConnectAsync()
        {
            closedByUser = false;
            return OpenAsync();
        }

        /// <summary>Leave for good (no reconnect).</summary>
        public void Close()
        {
            closedByUser = true;
            ClientWebSocket sock;
            lock (gate) sock = ws;
            if (sock == null) return;
            try
            {
                sock.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None).Wait(2000);
            }
            catch (Exception) { }
            HandleClose(sock, 1000, "bye");
        }

        public void Dispose()
        {
            Close();
        }

        /// <summary>Drop the connection as if the network failed (tests the resume path).</summary>
        public void DropConnectionForTest()
        {
            ClientWebSocket sock;
            lock (gate) sock = ws;
            if (sock != null) sock.Abort();
        }

        /// <summary>Raise queued events (QueueEvents = true). Call from the main thread, e.g. Update().</summary>
        public void DispatchEvents()
        {
            while (true)
            {
                Action a;
                lock (pending)
                {
                    if (pending.Count == 0) return;
                    a = pending.Dequeue();
                }
                a();
            }
        }

        /// <summary>Send a typed room message. Queued until joined (and while reconnecting).</summary>
        public void Send(string type, object data)
        {
            Send(type, data, null);
        }

        /// <summary>Send with a request id; an error caused by it echoes the id.</summary>
        public void Send(string type, object data, object id)
        {
            var f = new Dictionary<string, object>();
            f["t"] = "msg";
            f["type"] = type;
            f["data"] = data ?? new Dictionary<string, object>();
            if (id != null) f["id"] = id;
            string json = MiniJson.Serialize(f);
            lock (gate)
            {
                if (!Joined || ws == null)
                {
                    outbox.Enqueue(json);
                    return;
                }
            }
            SendRaw(json);
        }

        public void Ping()
        {
            SendRaw("{\"t\":\"ping\"}");
        }

        // ---- frames ----------------------------------------------------------------------------

        /// <summary>Handle one server frame (JSON text). Public so tests can replay recorded frames.</summary>
        public void Feed(string text)
        {
            Dictionary<string, object> f;
            try
            {
                f = MiniJson.Parse(text) as Dictionary<string, object>;
            }
            catch (Exception)
            {
                return;
            }
            if (f == null) return;
            switch (Str(f, "t"))
            {
                case "welcome":
                    {
                        Me = f.ContainsKey("me") ? f["me"] as Dictionary<string, object> : null;
                        ResumeToken = Str(f, "resumeToken");
                        string hk = Str(f, "hostKey");
                        if (hk != null) HostKey = hk;
                        bool resumed = f.ContainsKey("resumed") && f["resumed"] is bool && (bool)f["resumed"];
                        lock (gate) Joined = true;
                        attempt = 0;
                        Welcomes++;
                        Emit(delegate { if (OnWelcome != null) OnWelcome(f); });
                        if (!resumed && Ticket != null)
                        {
                            var data = new Dictionary<string, object>();
                            data["ticket"] = Ticket;
                            var msg = new Dictionary<string, object>();
                            msg["t"] = "msg";
                            msg["type"] = "ticket";
                            msg["data"] = data;
                            SendRaw(MiniJson.Serialize(msg));
                        }
                        FlushOutbox();
                        break;
                    }
                case "state":
                    {
                        State = f.ContainsKey("state") ? f["state"] : null;
                        object s = State;
                        Emit(delegate { if (OnState != null) OnState(s, new List<object>()); });
                        break;
                    }
                case "patch":
                    {
                        var ops = f.ContainsKey("ops") ? f["ops"] as List<object> : null;
                        State = ApplyPatch(State ?? new Dictionary<string, object>(), ops);
                        object s = State;
                        Emit(delegate { if (OnState != null) OnState(s, ops ?? new List<object>()); });
                        break;
                    }
                case "event":
                    {
                        string name = Str(f, "event");
                        object data = f.ContainsKey("data") ? f["data"] : null;
                        Emit(delegate { if (OnEvent != null) OnEvent(name, data); });
                        var seat = data as Dictionary<string, object>;
                        if (name == "seated" && seat != null) Emit(delegate { if (OnSeated != null) OnSeated(seat); });
                        break;
                    }
                case "error":
                    {
                        string code = Str(f, "code"), message = Str(f, "message"), fix = Str(f, "fix");
                        Emit(delegate { if (OnError != null) OnError(code, message, fix); });
                        break;
                    }
                case "pong":
                    Pongs++;
                    break;
            }
        }

        // ---- patches ---------------------------------------------------------------------------

        /// <summary>PROTOCOL.md patch algorithm: add/replace set a key, remove deletes it, "" is the root. Arrays are replaced whole.</summary>
        public static object ApplyPatch(object doc, List<object> ops)
        {
            if (ops == null) return doc;
            foreach (object o in ops)
            {
                var op = o as Dictionary<string, object>;
                if (op == null) continue;
                string kind = Str(op, "op");
                string path = Str(op, "path") ?? "";
                object value = op.ContainsKey("value") ? op["value"] : null;
                if (path.Length == 0)
                {
                    if (kind != "remove") doc = value;
                    continue;
                }
                string[] raw = path.Substring(1).Split('/');
                var parent = doc as Dictionary<string, object>;
                for (int i = 0; i < raw.Length - 1 && parent != null; i++)
                {
                    string k = Unescape(raw[i]);
                    object next;
                    if (!parent.TryGetValue(k, out next) || !(next is Dictionary<string, object>))
                    {
                        next = new Dictionary<string, object>();
                        parent[k] = next;
                    }
                    parent = (Dictionary<string, object>)next;
                }
                if (parent == null) continue;
                string last = Unescape(raw[raw.Length - 1]);
                if (kind == "remove") parent.Remove(last);
                else parent[last] = value;
            }
            return doc;
        }

        /// <summary>JSON Pointer segment: "~1" means "/", then "~0" means "~" (in that order).</summary>
        public static string Unescape(string segment)
        {
            return segment.Replace("~1", "/").Replace("~0", "~");
        }

        // ---- conformance -----------------------------------------------------------------------

        /// <summary>Run clients/protocol-vectors.json. Returns failure descriptions (empty = conformant).</summary>
        public static List<string> RunVectors(string json)
        {
            var failures = new List<string>();
            var v = (Dictionary<string, object>)MiniJson.Parse(json);
            foreach (object o in (List<object>)v["patch"])
            {
                var p = (Dictionary<string, object>)o;
                object got = ApplyPatch(MiniJson.Clone(p["doc"]), (List<object>)p["ops"]);
                if (!MiniJson.DeepEquals(got, p["expected"])) failures.Add("patch \"" + p["name"] + "\": got " + MiniJson.Serialize(got));
            }
            foreach (object o in (List<object>)v["sessions"])
            {
                var s = (Dictionary<string, object>)o;
                var c = new MiuRealtime("ws://vectors.invalid/rooms/x/1", "vectors");
                var events = new List<object>();
                var errs = new List<object>();
                c.OnEvent += delegate (string n, object d)
                {
                    var e = new Dictionary<string, object>();
                    e["event"] = n;
                    e["data"] = d;
                    events.Add(e);
                };
                c.OnError += delegate (string code, string m, string fix) { errs.Add(code); };
                foreach (object frame in (List<object>)s["frames"]) c.Feed((string)frame);
                var actual = new Dictionary<string, object>();
                actual["state"] = c.State;
                actual["me"] = c.Me;
                actual["resumeToken"] = c.ResumeToken;
                actual["hostKey"] = c.HostKey;
                actual["events"] = events;
                actual["errors"] = errs;
                actual["pongs"] = (double)c.Pongs;
                actual["welcomes"] = (double)c.Welcomes;
                foreach (KeyValuePair<string, object> kv in (Dictionary<string, object>)s["expect"])
                {
                    if (!MiniJson.DeepEquals(actual[kv.Key], kv.Value)) failures.Add("session \"" + s["name"] + "\" " + kv.Key + ": got " + MiniJson.Serialize(actual[kv.Key]));
                }
            }
            var rc = (Dictionary<string, object>)v["reconnect"];
            foreach (object o in (List<object>)rc["cases"])
            {
                var c = (Dictionary<string, object>)o;
                int code = Convert.ToInt32(c["code"], CultureInfo.InvariantCulture);
                if (IsTerminal(code) == (bool)c["reconnect"]) failures.Add("reconnect: code " + code);
            }
            foreach (object o in (List<object>)v["clientFrames"])
            {
                var c = (Dictionary<string, object>)o;
                object again = MiniJson.Parse(MiniJson.Serialize(c["frame"]));
                if (!MiniJson.DeepEquals(again, MiniJson.Parse((string)c["json"]))) failures.Add("clientFrame \"" + c["name"] + "\"");
            }
            return failures;
        }

        // ---- transport -------------------------------------------------------------------------

        private string BuildUrl()
        {
            var q = new StringBuilder();
            Action<string, string> add = delegate (string k, string val)
            {
                if (string.IsNullOrEmpty(val)) return;
                q.Append(q.Length == 0 ? "" : "&").Append(k).Append('=').Append(Uri.EscapeDataString(val));
            };
            add("name", Name);
            add("role", Role);
            add("hostKey", HostKey);
            add("resume", ResumeToken);
            add("ticket", Ticket); // game rooms check it before the upgrade
            if (q.Length == 0) return Url;
            return Url + (Url.IndexOf('?') >= 0 ? "&" : "?") + q;
        }

        private async Task OpenAsync()
        {
            var sock = new ClientWebSocket();
            var src = new CancellationTokenSource();
            lock (gate)
            {
                ws = sock;
                cts = src;
                Joined = false;
            }
            try
            {
                await sock.ConnectAsync(new Uri(BuildUrl()), src.Token).ConfigureAwait(false);
            }
            catch (Exception e)
            {
                HandleClose(sock, 1006, e.Message);
                return;
            }
            Emit(delegate { if (OnOpen != null) OnOpen(); });
            Task receive = ReceiveLoop(sock, src.Token);
            Task ping = PingLoop(sock, src.Token);
            GC.KeepAlive(receive);
            GC.KeepAlive(ping);
        }

        private async Task ReceiveLoop(ClientWebSocket sock, CancellationToken ct)
        {
            var buf = new byte[16384];
            var ms = new MemoryStream();
            try
            {
                while (sock.State == WebSocketState.Open)
                {
                    WebSocketReceiveResult r = await sock.ReceiveAsync(new ArraySegment<byte>(buf), ct).ConfigureAwait(false);
                    if (r.MessageType == WebSocketMessageType.Close)
                    {
                        int code = r.CloseStatus.HasValue ? (int)r.CloseStatus.Value : 1005;
                        string reason = r.CloseStatusDescription ?? "";
                        try
                        {
                            await sock.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None).ConfigureAwait(false);
                        }
                        catch (Exception) { }
                        HandleClose(sock, code, reason);
                        return;
                    }
                    ms.Write(buf, 0, r.Count);
                    if (!r.EndOfMessage) continue;
                    byte[] bytes = ms.ToArray();
                    ms.SetLength(0);
                    if (r.MessageType == WebSocketMessageType.Text) Feed(Encoding.UTF8.GetString(bytes));
                }
            }
            catch (Exception e)
            {
                HandleClose(sock, 1006, e.Message);
                return;
            }
            HandleClose(sock, sock.CloseStatus.HasValue ? (int)sock.CloseStatus.Value : 1006, "");
        }

        private async Task PingLoop(ClientWebSocket sock, CancellationToken ct)
        {
            if (PingIntervalMs <= 0) return;
            try
            {
                while (!ct.IsCancellationRequested)
                {
                    await Task.Delay(PingIntervalMs, ct).ConfigureAwait(false);
                    if (sock.State == WebSocketState.Open) await SendAsync(sock, "{\"t\":\"ping\"}").ConfigureAwait(false);
                }
            }
            catch (Exception) { }
        }

        private void HandleClose(ClientWebSocket sock, int code, string reason)
        {
            lock (gate)
            {
                if (sock != ws) return; // an older socket
                ws = null;
                Joined = false;
                if (cts != null) cts.Cancel();
            }
            bool will = AutoReconnect && !closedByUser && !IsTerminal(code) && attempt < MaxAttempts;
            Emit(delegate { if (OnClose != null) OnClose(code, reason, will); });
            if (!will) return;
            attempt++;
            int delay = (int)Math.Min(MaxDelayMs, (long)MinDelayMs << Math.Min(attempt - 1, 20));
            int n = attempt;
            Emit(delegate { if (OnReconnecting != null) OnReconnecting(n, delay); });
            Task.Delay(delay).ContinueWith(delegate (Task t)
            {
                if (closedByUser) return;
                Task reopen = OpenAsync();
                GC.KeepAlive(reopen);
            });
        }

        private void FlushOutbox()
        {
            while (true)
            {
                string json;
                lock (gate)
                {
                    if (outbox.Count == 0 || ws == null) return;
                    json = outbox.Dequeue();
                }
                SendRaw(json);
            }
        }

        private void SendRaw(string json)
        {
            ClientWebSocket sock;
            lock (gate) sock = ws;
            if (sock == null) return;
            Task t = SendAsync(sock, json);
            GC.KeepAlive(t);
        }

        private async Task SendAsync(ClientWebSocket sock, string json)
        {
            await sendLock.WaitAsync().ConfigureAwait(false);
            try
            {
                if (sock.State == WebSocketState.Open)
                {
                    byte[] bytes = Encoding.UTF8.GetBytes(json);
                    await sock.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None).ConfigureAwait(false);
                }
            }
            catch (Exception) { }
            finally
            {
                sendLock.Release();
            }
        }

        private void Emit(Action a)
        {
            if (!QueueEvents)
            {
                a();
                return;
            }
            lock (pending) pending.Enqueue(a);
        }

        private static string Str(Dictionary<string, object> d, string key)
        {
            object v;
            return d.TryGetValue(key, out v) ? v as string : null;
        }
    }

    /// <summary>Minimal JSON: object = Dictionary&lt;string, object&gt;, array = List&lt;object&gt;, number = double.</summary>
    public static class MiniJson
    {
        public static object Parse(string json)
        {
            int i = 0;
            object v = Value(json, ref i);
            Ws(json, ref i);
            if (i != json.Length) throw new FormatException("Trailing characters at " + i);
            return v;
        }

        public static string Serialize(object v)
        {
            var sb = new StringBuilder();
            Write(sb, v);
            return sb.ToString();
        }

        public static object Clone(object v)
        {
            return Parse(Serialize(v));
        }

        public static bool DeepEquals(object a, object b)
        {
            if (a == null || b == null) return a == null && b == null;
            if (IsNumber(a) && IsNumber(b)) return Convert.ToDouble(a, CultureInfo.InvariantCulture) == Convert.ToDouble(b, CultureInfo.InvariantCulture);
            var da = a as IDictionary;
            var db = b as IDictionary;
            if (da != null || db != null)
            {
                if (da == null || db == null || da.Count != db.Count) return false;
                foreach (DictionaryEntry e in da)
                {
                    if (!db.Contains(e.Key) || !DeepEquals(e.Value, db[e.Key])) return false;
                }
                return true;
            }
            var la = a as IList;
            var lb = b as IList;
            if (la != null || lb != null)
            {
                if (la == null || lb == null || la.Count != lb.Count || a is string || b is string) return a.Equals(b);
                for (int i = 0; i < la.Count; i++) if (!DeepEquals(la[i], lb[i])) return false;
                return true;
            }
            return a.Equals(b);
        }

        private static bool IsNumber(object v)
        {
            return v is double || v is float || v is int || v is long || v is short || v is byte || v is decimal || v is uint || v is ulong;
        }

        private static void Ws(string s, ref int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
        }

        private static object Value(string s, ref int i)
        {
            Ws(s, ref i);
            if (i >= s.Length) throw new FormatException("Unexpected end of JSON");
            char c = s[i];
            if (c == '{')
            {
                var o = new Dictionary<string, object>();
                i++;
                Ws(s, ref i);
                if (i < s.Length && s[i] == '}')
                {
                    i++;
                    return o;
                }
                while (true)
                {
                    Ws(s, ref i);
                    string k = Str(s, ref i);
                    Ws(s, ref i);
                    Expect(s, ref i, ':');
                    o[k] = Value(s, ref i);
                    Ws(s, ref i);
                    if (i < s.Length && s[i] == ',')
                    {
                        i++;
                        continue;
                    }
                    Expect(s, ref i, '}');
                    return o;
                }
            }
            if (c == '[')
            {
                var a = new List<object>();
                i++;
                Ws(s, ref i);
                if (i < s.Length && s[i] == ']')
                {
                    i++;
                    return a;
                }
                while (true)
                {
                    a.Add(Value(s, ref i));
                    Ws(s, ref i);
                    if (i < s.Length && s[i] == ',')
                    {
                        i++;
                        continue;
                    }
                    Expect(s, ref i, ']');
                    return a;
                }
            }
            if (c == '"') return Str(s, ref i);
            if (Lit(s, ref i, "true")) return true;
            if (Lit(s, ref i, "false")) return false;
            if (Lit(s, ref i, "null")) return null;
            int start = i;
            while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
            if (start == i) throw new FormatException("Unexpected character '" + c + "' at " + i);
            return double.Parse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture);
        }

        private static bool Lit(string s, ref int i, string word)
        {
            if (string.CompareOrdinal(s, i, word, 0, word.Length) != 0) return false;
            i += word.Length;
            return true;
        }

        private static void Expect(string s, ref int i, char c)
        {
            if (i >= s.Length || s[i] != c) throw new FormatException("Expected '" + c + "' at " + i);
            i++;
        }

        private static string Str(string s, ref int i)
        {
            Expect(s, ref i, '"');
            var sb = new StringBuilder();
            while (i < s.Length)
            {
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\')
                {
                    sb.Append(c);
                    continue;
                }
                if (i >= s.Length) break;
                char e = s[i++];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        sb.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                        i += 4;
                        break;
                    default: throw new FormatException("Bad escape at " + i);
                }
            }
            throw new FormatException("Unterminated string");
        }

        private static void Write(StringBuilder sb, object v)
        {
            if (v == null)
            {
                sb.Append("null");
                return;
            }
            var s = v as string;
            if (s != null)
            {
                Quote(sb, s);
                return;
            }
            if (v is bool)
            {
                sb.Append((bool)v ? "true" : "false");
                return;
            }
            if (IsNumber(v))
            {
                double d = Convert.ToDouble(v, CultureInfo.InvariantCulture);
                if (double.IsNaN(d) || double.IsInfinity(d)) sb.Append("null");
                else if (d == Math.Floor(d) && Math.Abs(d) < 9007199254740992d) sb.Append(((long)d).ToString(CultureInfo.InvariantCulture));
                else sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
                return;
            }
            var dict = v as IDictionary;
            if (dict != null)
            {
                sb.Append('{');
                bool first = true;
                foreach (DictionaryEntry e in dict)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    Quote(sb, Convert.ToString(e.Key, CultureInfo.InvariantCulture));
                    sb.Append(':');
                    Write(sb, e.Value);
                }
                sb.Append('}');
                return;
            }
            var list = v as IEnumerable;
            if (list != null)
            {
                sb.Append('[');
                bool first = true;
                foreach (object x in list)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    Write(sb, x);
                }
                sb.Append(']');
                return;
            }
            Quote(sb, Convert.ToString(v, CultureInfo.InvariantCulture));
        }

        private static void Quote(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }
    }
}
