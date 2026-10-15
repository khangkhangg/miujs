## Headless conformance run:
##   godot --headless --path clients/godot --script res://tests/run_vectors.gd -- ../protocol-vectors.json
## Prints OK (exit 0) or one FAIL line per failure (exit 1).
extends SceneTree


func _init() -> void:
	var args := OS.get_cmdline_user_args()
	var path: String = args[0] if args.size() > 0 else "res://../protocol-vectors.json"
	var text := FileAccess.get_file_as_string(path)
	if text == "":
		printerr("cannot read %s" % path)
		quit(2)
		return
	var failures := MiuRealtime.run_vectors(text)
	for f in failures:
		print("FAIL ", f)
	print("OK" if failures.is_empty() else "%d failures" % failures.size())
	quit(0 if failures.is_empty() else 1)
