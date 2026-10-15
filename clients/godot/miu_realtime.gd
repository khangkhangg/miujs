## MiuJS realtime rooms client for Godot 4 (wire protocol v1, JSON frames). One file, no addons.
##
##   var room := MiuRealtime.new()
##   add_child(room)                       # it polls its WebSocketPeer in _process()
##   room.ticket = status["ticket"]        # game rooms: from GET /match/:queue/status
##   room.state_changed.connect(func(state, ops): render(state))
##   room.event_received.connect(func(name, data): print(name, data))
##   room.connect_to_room("wss://game.example/rooms/arena/r1a2b3", "Ann")
##   room.send_msg("move", {"x": 1})
##
## JSON numbers arrive as float (Godot's JSON parser); compare with is_equal_approx or int().
class_name MiuRealtime
extends Node

signal opened
## The whole welcome frame: me, room, resumeToken, resumed, hostKey (hosts only).
signal welcomed(frame: Dictionary)
## New state and the patch ops that produced it (empty for a full state).
signal state_changed(state: Variant, ops: Array)
signal event_received(event_name: String, data: Variant)
## Game rooms: your ticket was accepted (userId, name, team, matchId).
signal seated(seat: Dictionary)
signal error_received(code: String, message: String, fix: String)
signal closed(code: int, reason: String, will_reconnect: bool)
signal reconnecting(attempt: int, delay_sec: float)

## Close codes after which reconnecting would not help (PROTOCOL.md "Close codes").
const TERMINAL_CLOSE_CODES: Array[int] = [1000, 1003, 1009, 4001, 4003, 4004, 4005, 4008]

var url: String = ""
var player_name: String = ""
## "player" (default), "host" or "spectator".
var role: String = ""
var host_key: String = ""
## From the last welcome; sent as ?resume= when reconnecting. Save it to resume after a restart.
var resume_token: String = ""
## Game rooms: sent as ?ticket= on connect (checked before the upgrade) and as
## {"t":"msg","type":"ticket"} after every fresh (non-resumed) welcome.
var ticket: String = ""
var auto_reconnect: bool = true
var min_delay_sec: float = 0.25
var max_delay_sec: float = 5.0
var max_attempts: int = 1 << 30
## Send {"t":"ping"} this often while connected (0 = never).
var ping_interval_sec: float = 20.0

## Latest room state (or your view of it). Patched in place.
var state: Variant = null
var me: Dictionary = {}
var joined: bool = false
var pongs: int = 0
var welcomes: int = 0

var _ws: WebSocketPeer = null
var _outbox: Array[String] = []
var _closed_by_user: bool = false
var _attempt: int = 0
var _retry_in: float = -1.0
var _ping_in: float = 0.0
var _last_state: int = WebSocketPeer.STATE_CLOSED


## Connect. `options` may hold role, host_key, resume, ticket.
func connect_to_room(room_url: String, display_name: String, options: Dictionary = {}) -> Error:
	url = room_url
	player_name = display_name
	role = options.get("role", role)
	host_key = options.get("host_key", host_key)
	resume_token = options.get("resume", resume_token)
	ticket = options.get("ticket", ticket)
	_closed_by_user = false
	_attempt = 0
	return _open()


## Send a typed room message. Queued until joined (and while reconnecting).
func send_msg(type: String, data: Variant = {}, id: Variant = null) -> void:
	var f := {"t": "msg", "type": type, "data": data if data != null else {}}
	if id != null:
		f["id"] = id
	var text := JSON.stringify(f)
	if joined and _ws != null and _ws.get_ready_state() == WebSocketPeer.STATE_OPEN:
		_ws.send_text(text)
	else:
		_outbox.append(text)


func send_ping() -> void:
	_send_raw('{"t":"ping"}')


## Leave for good (no reconnect).
func close_room() -> void:
	_closed_by_user = true
	_retry_in = -1.0
	if _ws != null:
		_ws.close(1000, "bye")


func _process(delta: float) -> void:
	if _retry_in >= 0.0:
		_retry_in -= delta
		if _retry_in < 0.0:
			_open()
		return
	if _ws == null:
		return
	_ws.poll()
	var st := _ws.get_ready_state()
	if st == WebSocketPeer.STATE_OPEN:
		if _last_state != WebSocketPeer.STATE_OPEN:
			_ping_in = ping_interval_sec
			opened.emit()
		_drain()
		if ping_interval_sec > 0.0:
			_ping_in -= delta
			if _ping_in <= 0.0:
				_ping_in = ping_interval_sec
				_send_raw('{"t":"ping"}')
	elif st == WebSocketPeer.STATE_CLOSED:
		_drain()
		var code := _ws.get_close_code()
		var reason := _ws.get_close_reason()
		_ws = null
		_handle_close(code if code != -1 else 1006, reason)
	_last_state = st


## Handle one server frame (JSON text). Public so tests can replay recorded frames.
func feed(text: String) -> void:
	var f = JSON.parse_string(text)
	if typeof(f) != TYPE_DICTIONARY:
		return
	match str(f.get("t", "")):
		"welcome":
			me = f["me"] if f.get("me") is Dictionary else {}
			if f.get("resumeToken") is String:
				resume_token = f["resumeToken"]
			if f.get("hostKey") is String:
				host_key = f["hostKey"]
			joined = true
			_attempt = 0
			welcomes += 1
			welcomed.emit(f)
			if not bool(f.get("resumed", false)) and ticket != "":
				_send_raw(JSON.stringify({"t": "msg", "type": "ticket", "data": {"ticket": ticket}}))
			_flush_outbox()
		"state":
			state = f.get("state")
			state_changed.emit(state, [])
		"patch":
			var ops: Array = f["ops"] if f.get("ops") is Array else []
			state = apply_patch(state if state != null else {}, ops)
			state_changed.emit(state, ops)
		"event":
			var data = f.get("data")
			var event_name := str(f.get("event", ""))
			event_received.emit(event_name, data)
			if event_name == "seated" and data is Dictionary:
				seated.emit(data)
		"error":
			var fix = f.get("fix")
			error_received.emit(str(f.get("code", "")), str(f.get("message", "")), fix if fix is String else "")
		"pong":
			pongs += 1


## PROTOCOL.md patch algorithm: add/replace set a key, remove deletes it, "" is the root.
## Arrays are always replaced whole, so only dictionaries are walked.
static func apply_patch(doc: Variant, ops: Array) -> Variant:
	for op in ops:
		if not (op is Dictionary):
			continue
		var kind := str(op.get("op", ""))
		var path := str(op.get("path", ""))
		var value = op.get("value")
		if path == "":
			if kind != "remove":
				doc = value
			continue
		var keys := path.substr(1).split("/")
		var parent = doc
		for i in range(keys.size() - 1):
			if not (parent is Dictionary):
				break
			var k := unescape(keys[i])
			if not (parent.get(k) is Dictionary):
				parent[k] = {}
			parent = parent[k]
		if not (parent is Dictionary):
			continue
		var last := unescape(keys[keys.size() - 1])
		if kind == "remove":
			parent.erase(last)
		else:
			parent[last] = value
	return doc


## JSON Pointer segment: "~1" means "/", then "~0" means "~" (in that order).
static func unescape(segment: String) -> String:
	return segment.replace("~1", "/").replace("~0", "~")


static func is_terminal(code: int) -> bool:
	return TERMINAL_CLOSE_CODES.has(code)


## Numbers compare by value (Godot parses every JSON number as float).
static func deep_equal(a: Variant, b: Variant) -> bool:
	var ta := typeof(a)
	var tb := typeof(b)
	if (ta == TYPE_INT or ta == TYPE_FLOAT) and (tb == TYPE_INT or tb == TYPE_FLOAT):
		return float(a) == float(b)
	if ta != tb:
		return false
	if ta == TYPE_DICTIONARY:
		if a.size() != b.size():
			return false
		for k in a:
			if not b.has(k) or not deep_equal(a[k], b[k]):
				return false
		return true
	if ta == TYPE_ARRAY:
		if a.size() != b.size():
			return false
		for i in range(a.size()):
			if not deep_equal(a[i], b[i]):
				return false
		return true
	return a == b


## Run clients/protocol-vectors.json. Returns failure descriptions (empty = conformant).
static func run_vectors(json_text: String) -> Array[String]:
	var failures: Array[String] = []
	var v = JSON.parse_string(json_text)
	for p in v["patch"]:
		var got = apply_patch(JSON.parse_string(JSON.stringify(p["doc"])), p["ops"])
		if not deep_equal(got, p["expected"]):
			failures.append("patch \"%s\": got %s" % [p["name"], JSON.stringify(got)])
	for s in v["sessions"]:
		var c := MiuRealtime.new()
		var events: Array = []
		var errs: Array = []
		c.event_received.connect(func(n, d): events.append({"event": n, "data": d}))
		c.error_received.connect(func(code, _m, _f): errs.append(code))
		for frame in s["frames"]:
			c.feed(frame)
		var actual := {
			"state": c.state,
			"me": c.me if not c.me.is_empty() else null,
			"resumeToken": c.resume_token if c.resume_token != "" else null,
			"hostKey": c.host_key if c.host_key != "" else null,
			"events": events,
			"errors": errs,
			"pongs": c.pongs,
			"welcomes": c.welcomes,
		}
		for key in s["expect"]:
			if not deep_equal(actual[key], s["expect"][key]):
				failures.append("session \"%s\" %s: got %s" % [s["name"], key, JSON.stringify(actual[key])])
		c.free()
	for rc in v["reconnect"]["cases"]:
		if is_terminal(int(rc["code"])) == bool(rc["reconnect"]):
			failures.append("reconnect: code %d" % int(rc["code"]))
	for cf in v["clientFrames"]:
		if not deep_equal(JSON.parse_string(JSON.stringify(cf["frame"])), JSON.parse_string(cf["json"])):
			failures.append("clientFrame \"%s\"" % cf["name"])
	return failures


func _open() -> Error:
	_retry_in = -1.0
	joined = false
	_ws = WebSocketPeer.new()
	_last_state = WebSocketPeer.STATE_CONNECTING
	var err := _ws.connect_to_url(_build_url())
	if err != OK:
		_ws = null
		_handle_close(1006, "connect failed: %s" % error_string(err))
	return err


func _build_url() -> String:
	var q: PackedStringArray = []
	if player_name != "":
		q.append("name=" + player_name.uri_encode())
	if role != "":
		q.append("role=" + role.uri_encode())
	if host_key != "":
		q.append("hostKey=" + host_key.uri_encode())
	if resume_token != "":
		q.append("resume=" + resume_token.uri_encode())
	if ticket != "":
		q.append("ticket=" + ticket.uri_encode())  # game rooms check it before the upgrade
	if q.is_empty():
		return url
	return url + ("&" if url.contains("?") else "?") + "&".join(q)


func _drain() -> void:
	while _ws != null and _ws.get_available_packet_count() > 0:
		var pkt := _ws.get_packet()
		if _ws.was_string_packet():
			feed(pkt.get_string_from_utf8())


func _handle_close(code: int, reason: String) -> void:
	joined = false
	var will := auto_reconnect and not _closed_by_user and not is_terminal(code) and _attempt < max_attempts
	closed.emit(code, reason, will)
	if not will:
		return
	_attempt += 1
	var delay: float = min(max_delay_sec, min_delay_sec * pow(2.0, _attempt - 1))
	reconnecting.emit(_attempt, delay)
	_retry_in = delay


func _flush_outbox() -> void:
	while not _outbox.is_empty() and _ws != null and _ws.get_ready_state() == WebSocketPeer.STATE_OPEN:
		_ws.send_text(_outbox.pop_front())


func _send_raw(text: String) -> void:
	if _ws != null and _ws.get_ready_state() == WebSocketPeer.STATE_OPEN:
		_ws.send_text(text)
