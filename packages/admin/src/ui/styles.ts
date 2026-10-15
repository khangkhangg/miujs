// The admin stylesheet. One file, served with a content hash. No inline styles anywhere, so a
// CSP without 'unsafe-inline' for styles works.

export function adminCss(accent = "#2557d6"): string {
  return `:root{--accent:${accent};--bg:#f6f7f9;--panel:#fff;--text:#1b1f24;--muted:#5b6470;--line:#d9dde3;--danger:#b42318;--ok:#067647;--warn:#9a6700;--radius:6px;--focus:0 0 0 3px #fff,0 0 0 5px var(--accent);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--text);background:var(--bg)}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--panel:#1a1f25;--text:#e8eaed;--muted:#a3abb5;--line:#323a44;--danger:#f97066;--ok:#47cd89;--warn:#fdb022;--focus:0 0 0 3px #111418,0 0 0 5px var(--accent)}}
*{box-sizing:border-box}
html,body{margin:0;max-width:100%;overflow-x:hidden}
body{font-size:15px;line-height:1.45}
a{color:var(--accent)}
:focus-visible{outline:none;box-shadow:var(--focus);border-radius:3px}
.skip{position:absolute;left:-9999px;top:0;background:var(--panel);padding:.5rem 1rem;z-index:10}
.skip:focus{left:.5rem;top:.5rem}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
header.top{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;justify-content:space-between;padding:.6rem 1rem;background:var(--panel);border-bottom:1px solid var(--line)}
.brand{display:flex;gap:.5rem;align-items:center;font-weight:700;color:var(--text);text-decoration:none}
.brand img{height:28px;width:auto}
.top-actions{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.shell{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:calc(100vh - 52px)}
nav.side{background:var(--panel);border-right:1px solid var(--line);padding:1rem .5rem}
nav.side ul{list-style:none;margin:0;padding:0}
nav.side a{display:block;padding:.45rem .75rem;border-radius:var(--radius);color:var(--text);text-decoration:none}
nav.side a[aria-current="page"]{background:var(--bg);font-weight:600;border-left:3px solid var(--accent)}
nav.side h2{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:1rem .75rem .25rem}
main{padding:1.25rem;min-width:0}
h1{font-size:1.4rem;margin:0 0 1rem}
.page-head{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;justify-content:space-between;margin-bottom:1rem}
.page-head h1{margin:0}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:1rem;margin-bottom:1rem}
.btn,button{font:inherit;display:inline-flex;align-items:center;gap:.3rem;min-height:36px;padding:.35rem .8rem;border-radius:var(--radius);border:1px solid var(--line);background:var(--panel);color:var(--text);cursor:pointer;text-decoration:none}
.btn.primary,button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.danger,button.danger{color:var(--danger);border-color:var(--danger)}
button:disabled{opacity:.55;cursor:not-allowed}
input,select,textarea{font:inherit;color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:.4rem .55rem;min-height:36px;max-width:100%}
textarea{width:100%}
.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.9em}
.field{margin-bottom:.9rem;display:flex;flex-direction:column;gap:.25rem;max-width:640px;border:0;padding:0}
.field input[type=text],.field input[type=email],.field input[type=url],.field input[type=tel],.field select{width:100%}
.field.check{flex-direction:row;flex-wrap:wrap;align-items:center;gap:.5rem}
label.check{display:inline-flex;align-items:center;gap:.35rem;margin-right:1rem}
legend{font-weight:600;padding:0;margin-bottom:.25rem}
label{font-weight:600}
.req{color:var(--danger)}
.help,.hint,.muted{color:var(--muted);font-size:.875rem;margin:0}
.field-error{color:var(--danger);font-size:.875rem;margin:0;font-weight:600}
.field-error::before{content:"⚠ "}
.has-error input,.has-error select,.has-error textarea,[aria-invalid="true"]{border-color:var(--danger);border-width:2px}
.alert{border:1px solid var(--danger);border-left-width:4px;background:var(--panel);padding:.75rem 1rem;border-radius:var(--radius);margin-bottom:1rem}
.alert.ok{border-color:var(--ok)}
.alert ul{margin:.25rem 0 0;padding-left:1.25rem}
.money{display:flex;align-items:center;gap:.4rem}
.unit{color:var(--muted);font-size:.875rem}
.tabs{position:relative;display:flex;gap:.25rem;flex-wrap:nowrap;overflow-x:auto;border-bottom:1px solid var(--line);margin-bottom:1rem;padding-bottom:0}
.tabs a{padding:.5rem .8rem;text-decoration:none;color:var(--muted);border-bottom:3px solid transparent;white-space:nowrap}
.tabs a[aria-current="page"]{color:var(--text);border-bottom-color:var(--accent);font-weight:600}
.toolbar{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin-bottom:.75rem}
.filters{display:flex;flex-direction:column;gap:.5rem}
.filter-row{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center}
.table-wrap{position:relative;overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius)}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:.5rem .65rem;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:.8rem;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);white-space:nowrap}
th a{color:inherit;text-decoration:none}
th a::after{content:" ↕";opacity:.4}
th[aria-sort=ascending] a::after{content:" ▲";opacity:1}
th[aria-sort=descending] a::after{content:" ▼";opacity:1}
td.rt{max-width:22rem;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.pager{display:flex;gap:.5rem;justify-content:flex-end;margin-top:.75rem}
.badge{display:inline-block;padding:.05rem .5rem;border-radius:999px;border:1px solid var(--line);font-size:.8rem;font-weight:600;white-space:nowrap}
.badge::before{content:"";display:inline-block;width:.55em;height:.55em;border-radius:50%;margin-right:.35em;background:var(--muted);vertical-align:middle}
.c-gray::before{background:#667085}.c-red::before{background:#d92d20}.c-orange::before{background:#ef6820}.c-yellow::before{background:#eaaa08}.c-green::before{background:#16b364}.c-teal::before{background:#15b79e}.c-blue::before{background:#2e90fa}.c-purple::before{background:#7a5af8}.c-pink::before{background:#ee46bc}
.chip{display:inline-block;padding:.05rem .45rem;border-radius:4px;background:var(--bg);border:1px solid var(--line);font-size:.8rem}
.board{position:relative;display:flex;gap:.75rem;overflow-x:auto;padding-bottom:.5rem;align-items:flex-start}
.column{flex:0 0 260px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);display:flex;flex-direction:column;max-height:75vh}
.column h2{font-size:.95rem;margin:0;padding:.6rem .75rem;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:.5rem}
.column ol{list-style:none;margin:0;padding:.5rem;display:flex;flex-direction:column;gap:.5rem;overflow-y:auto;min-height:3rem}
.column.drop-target{outline:2px dashed var(--accent);outline-offset:-4px}
.card{background:var(--bg);border:1px solid var(--line);border-radius:var(--radius);padding:.5rem .6rem;cursor:grab}
.card[aria-grabbed=true]{opacity:.6}
.card.pending{border-style:dashed}
.card .meta{color:var(--muted);font-size:.85rem}
.calendar{table-layout:fixed;min-width:640px}
.calendar td{height:6.5rem;width:14.28%}
.calendar td.out{background:var(--bg);color:var(--muted)}
.calendar .day{font-weight:600;font-size:.8rem}
.calendar ul{list-style:none;margin:.25rem 0 0;padding:0;font-size:.85rem}
.record{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:1rem}
.record aside .panel h2{font-size:1rem;margin-top:0}
dl.meta{display:grid;grid-template-columns:auto 1fr;gap:.25rem .75rem;margin:0}
dl.meta dt{color:var(--muted)}
.timeline{list-style:none;margin:0;padding:0}
.timeline li{border-left:2px solid var(--line);padding:0 0 .9rem .75rem;margin-left:.3rem}
.timeline .when{color:var(--muted);font-size:.8rem}
.rte-toolbar{display:flex;flex-wrap:wrap;gap:.25rem;margin-bottom:.25rem}
.rte-toolbar button{min-height:30px;padding:.15rem .5rem;font-size:.85rem}
.rte-editor{min-height:8rem;border:1px solid var(--line);border-radius:var(--radius);padding:.5rem;background:var(--panel)}
.picker{position:relative}
.picker [role=listbox]{position:absolute;z-index:5;left:0;right:0;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);margin:.2rem 0 0;padding:.25rem;list-style:none;max-height:16rem;overflow-y:auto}
.picker [role=option]{padding:.35rem .5rem;border-radius:4px;cursor:pointer}
.picker [role=option][aria-selected=true]{background:var(--bg);outline:2px solid var(--accent)}
.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.5rem}
.step{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:var(--radius);padding:.75rem}
.step.has-error{border-left-color:var(--danger)}
.step .branch{margin:.5rem 0 0 1rem;padding-left:.75rem;border-left:2px dashed var(--line)}
.step header{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;justify-content:space-between;margin-bottom:.5rem}
.drop{height:.6rem;border-radius:4px}
.drop.active{background:var(--accent);opacity:.4}
.status{font-weight:600}
.status.completed{color:var(--ok)}.status.failed{color:var(--danger)}.status.cancelled{color:var(--muted)}.status.waiting,.status.sleeping,.status.running,.status.queued{color:var(--warn)}
.status::before{margin-right:.3em}
.status.completed::before{content:"✓"}.status.failed::before{content:"✕"}.status.cancelled::before{content:"⦸"}.status.waiting::before,.status.sleeping::before{content:"⏸"}.status.running::before,.status.queued::before{content:"▶"}
.login{max-width:380px;margin:4rem auto}
.grid-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:.75rem}
.grid-cards a{display:block;padding:1rem;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);text-decoration:none;color:var(--text);font-weight:600}
details.menu summary{cursor:pointer}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:.5rem;margin:0 0 1rem}
.stat{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:var(--radius);padding:.5rem .75rem}
.stat dt{color:var(--muted);font-size:.8rem}
.stat dd{margin:0;font-weight:700;font-size:1.1rem;overflow-wrap:anywhere}
.stat.tone-good{border-left-color:var(--ok)}.stat.tone-warning{border-left-color:var(--warn)}.stat.tone-critical{border-left-color:var(--danger)}
.plugin-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:.75rem}
.plugin-card h2{font-size:1.05rem;margin:0 0 .5rem}
.plugin-card h3{font-size:.9rem;margin:.5rem 0 .25rem}
.plugin-card .stats{grid-template-columns:repeat(auto-fill,minmax(110px,1fr));margin:0}
form.action h3{margin:0 0 .25rem;font-size:1rem}
pre.mono{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
@media (max-width:760px){
.shell{grid-template-columns:minmax(0,1fr)}
nav.side{border-right:0;border-bottom:1px solid var(--line);padding:.5rem}
nav.side ul{display:flex;gap:.25rem;overflow-x:auto}
nav.side h2{display:none}
nav.side a{white-space:nowrap}
nav.side a[aria-current="page"]{border-left:0;border-bottom:3px solid var(--accent)}
main{padding:.75rem}
.record{grid-template-columns:minmax(0,1fr)}
.column{flex-basis:80vw}
.field{max-width:100%}
.hide-sm{display:none}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;
}
