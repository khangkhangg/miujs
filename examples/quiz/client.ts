/** Single-file quiz client: vanilla JS + CSS, no build step. */
export const page = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Miu Quiz</title>
<style>
  :root { --bg: #f6f5f2; --fg: #1d1d1f; --muted: #6b6b70; --card: #fff; --line: #e3e1dc; --accent: #5b4bdb; }
  @media (prefers-color-scheme: dark) { :root { --bg: #151517; --fg: #f2f2f3; --muted: #9a9aa2; --card: #1f1f23; --line: #303036; --accent: #8f83ff; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 640px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 22px; margin: 0 0 16px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 12px; }
  input, button { font: inherit; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); }
  button { cursor: pointer; }
  button.primary { background: var(--accent); color: #fff; border-color: transparent; }
  button:disabled { opacity: .5; cursor: default; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .choices { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
  .choices button { padding: 18px 12px; color: #fff; border: 0; font-weight: 600; }
  .c0 { background: #d64545; } .c1 { background: #2f6fd6; } .c2 { background: #c99a1e; } .c3 { background: #2f9e5b; }
  .correct { outline: 4px solid var(--fg); }
  .muted { color: var(--muted); font-size: 14px; }
  ol { padding-left: 20px; margin: 0; } li { padding: 2px 0; }
  .timer { font-variant-numeric: tabular-nums; font-weight: 700; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <h1>Miu Quiz</h1>
  <form id="join" class="card row">
    <input id="name" placeholder="Your name" required maxlength="24" />
    <label class="row muted"><input type="checkbox" id="host" /> Host</label>
    <button class="primary">Join</button>
  </form>
  <section id="game" hidden>
    <div class="card"><div id="status" class="muted">Connecting…</div><div id="body"></div></div>
    <div id="hostbar" class="row" hidden>
      <button id="start" class="primary">Start</button><button id="next">Next</button><button id="reset">New game</button>
    </div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
let ws, me = {}, timer;
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => "&#" + ch.charCodeAt(0) + ";");
const send = (o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
const board = (rows) => "<ol>" + rows.map((r) => "<li>" + esc(r.name) + " — <b>" + r.score + "</b>" + (r.lastPoints ? " <span class=muted>(+" + r.lastPoints + ")</span>" : "") + "</li>").join("") + "</ol>";

$("join").onsubmit = (e) => {
  e.preventDefault();
  const q = new URLSearchParams({ name: $("name").value, host: $("host").checked });
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/play?" + q);
  ws.onmessage = (ev) => render(JSON.parse(ev.data));
  ws.onclose = () => { $("status").textContent = "Disconnected"; clearInterval(timer); };
  $("join").hidden = true; $("game").hidden = false;
};
$("start").onclick = () => send({ type: "start" });
$("next").onclick = () => send({ type: "next" });
$("reset").onclick = () => send({ type: "reset" });

function countdown(deadline) {
  clearInterval(timer);
  const tick = () => { const s = Math.max(0, Math.ceil((deadline - Date.now()) / 1000)); const el = document.querySelector(".timer"); if (el) el.textContent = s + "s"; };
  tick(); timer = setInterval(tick, 250);
}

function render(m) {
  const body = $("body"), status = $("status");
  switch (m.type) {
    case "welcome": me = m; $("hostbar").hidden = !m.host; status.textContent = m.host ? "You are the host" : "Waiting for the host to start"; break;
    case "lobby": if (m.state.phase === "lobby") body.innerHTML = "<p>Players (" + m.players.length + ")</p><ol>" + m.players.map((p) => "<li>" + esc(p.name) + "</li>").join("") + "</ol>"; break;
    case "question":
      status.innerHTML = "Question " + (m.round + 1) + " / " + m.totalRounds + " · <span class=timer></span>";
      body.innerHTML = "<h2>" + esc(m.question.prompt) + "</h2><div class=choices>" + m.question.choices.map((c, i) => "<button class=c" + (i % 4) + " data-i=" + i + (me.host ? " disabled" : "") + ">" + esc(c) + "</button>").join("") + "</div>";
      body.querySelectorAll("[data-i]").forEach((b) => (b.onclick = () => { send({ type: "answer", choice: +b.dataset.i }); body.querySelectorAll("button").forEach((x) => (x.disabled = true)); }));
      countdown(Date.now() + m.ms); break;
    case "answered": status.textContent = m.accepted ? "Answer locked in…" : "Answer not accepted (" + m.reason + ")"; break;
    case "answer": if (me.host) status.textContent = m.answered + " / " + m.total + " answered"; break;
    case "reveal": {
      clearInterval(timer);
      const mine = m.results.find((r) => r.id === me.id);
      status.textContent = mine ? (mine.correct ? "Correct! +" + mine.points : "Not this time") : "Answer revealed";
      body.querySelectorAll("[data-i]").forEach((b) => b.classList.toggle("correct", +b.dataset.i === m.answer));
      break;
    }
    case "leaderboard": status.textContent = "Leaderboard"; body.innerHTML = board(m.scoreboard); break;
    case "finished": status.textContent = "Final results"; body.innerHTML = board(m.scoreboard); break;
    case "error": status.textContent = m.message; break;
  }
}
</script>
</body>
</html>`;
