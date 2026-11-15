// McGrath Masters golf tracker
// Data lives in Supabase (public read, signed-in write). Handicaps use the
// USGA World Handicap System math on final scores (no hole-by-hole caps, no PCC),
// so they are unofficial "family" indexes.

const CFG = window.GOLF_CONFIG;
const PLAYERS = CFG.players;
const P = Object.fromEntries(PLAYERS.map(p => [p.slug, p]));
const DEMO = !CFG.supabaseUrl || !CFG.supabaseAnonKey;
const OGAPI = "https://api.opengolfapi.org";

let sb = null;
const state = { rounds: [], matches: [], courses: [], start: {}, user: null, tab: null };
// Starting handicaps are used until a player has this many full rounds posted.
const START_UNTIL = CFG.startingIndexRounds ?? 5;

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const r1 = n => Math.round(n * 10) / 10;
const fmtIdx = n => n == null ? "–" : (n < 0 ? "+" + Math.abs(n).toFixed(1) : n.toFixed(1));
const toPar = (score, par) => { const d = score - par; return d === 0 ? "E" : (d > 0 ? "+" + d : String(d)); };
const parseDate = s => new Date(s + "T12:00:00");
const fmtDate = s => parseDate(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const fmtShort = s => parseDate(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 864e5);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
const byDate = (a, b) => (a.played_on || a.scheduled_for).localeCompare(b.played_on || b.scheduled_for) || String(a.created_at || "").localeCompare(String(b.created_at || ""));
const dot = slug => `<span class="dot" style="background:${P[slug]?.color || "#888"}"></span>`;
const pname = slug => P[slug]?.name || slug;

// ---------- handicap math (USGA Rules of Handicapping 5.1 / 5.2) ----------
const diffOf = r => r1((113 / r.slope) * (r.score - r.rating));
const countsForIndex = r => r.holes === 18 && r.rating && r.slope && r.score;
const TABLE = n => n >= 20 ? [8, 0] : n === 19 ? [7, 0] : n >= 17 ? [6, 0] : n >= 15 ? [5, 0] : n >= 12 ? [4, 0]
  : n >= 9 ? [3, 0] : n >= 7 ? [2, 0] : n === 6 ? [2, -1] : n === 5 ? [1, 0] : n === 4 ? [1, -1] : n === 3 ? [1, -2] : null;

function indexFrom(rounds) {
  const elig = rounds.filter(countsForIndex).sort(byDate).slice(-20);
  const rule = TABLE(elig.length);
  if (!rule) return { index: null, used: [], count: elig.length };
  const [k, adj] = rule;
  const sorted = [...elig].sort((a, b) => diffOf(a) - diffOf(b)).slice(0, k);
  const avg = sorted.reduce((s, r) => s + diffOf(r), 0) / k;
  return { index: Math.min(54, r1(avg + adj)), used: sorted.map(r => r.id), count: elig.length, k };
}
// Uses the player's starting handicap until they have enough rounds of their own.
function effIndex(rounds, slug) {
  const h = indexFrom(rounds);
  const start = state.start[slug];
  if (start != null && h.count < START_UNTIL) return { ...h, index: start, used: [], starting: true };
  return h;
}
const playerRounds = slug => state.rounds.filter(r => r.player === slug).sort(byDate);
const currentIndex = slug => effIndex(playerRounds(slug), slug);
const courseHcp = (idx, c) => idx == null ? null : Math.round(idx * (c.slope / 113) + (c.rating - c.par));

function indexHistory(slug) {
  const rs = playerRounds(slug).filter(countsForIndex);
  const out = [];
  for (let i = 0; i < rs.length; i++) {
    const h = effIndex(rs.slice(0, i + 1), slug);
    if (h.index != null) out.push({ x: rs[i].played_on, y: h.index });
  }
  return out;
}

// ---------- matches, head to head, master champ ----------
function evalMatch(m) {
  const rs = state.rounds.filter(r => r.match_id === m.id);
  if (m.status !== "final" || rs.length < 2) return null;
  const rows = rs.map(r => {
    const prior = state.rounds.filter(x => x.player === r.player && x.match_id !== m.id && x.played_on <= m.scheduled_for);
    const idx = effIndex(prior, r.player).index;
    const ch = courseHcp(idx, r);
    const net = m.scoring === "gross" ? r.score : r.score - (ch ?? 0);
    return { player: r.player, gross: r.score, idx, ch, net, noHcp: idx == null };
  }).sort((a, b) => a.net - b.net);
  const best = rows[0].net;
  const winners = rows.filter(x => x.net === best).map(x => x.player);
  return { rows, winners, outright: winners.length === 1 ? winners[0] : null };
}

function h2hRecords() {
  const rec = {};
  const key = (a, b) => [a, b].sort().join("|");
  for (let i = 0; i < PLAYERS.length; i++) for (let j = i + 1; j < PLAYERS.length; j++)
    rec[key(PLAYERS[i].slug, PLAYERS[j].slug)] = { a: PLAYERS[i].slug, b: PLAYERS[j].slug, aw: 0, bw: 0, t: 0, last: [] };
  for (const m of state.matches.filter(m => m.status === "final").sort(byDate)) {
    const ev = evalMatch(m); if (!ev) continue;
    const by = Object.fromEntries(ev.rows.map(r => [r.player, r]));
    for (const k in rec) {
      const R = rec[k]; const A = by[R.a], B = by[R.b];
      if (!A || !B) continue;
      let res = "t";
      if (A.net < B.net) { R.aw++; res = R.a; } else if (B.net < A.net) { R.bw++; res = R.b; } else R.t++;
      R.last.push(res);
    }
  }
  return Object.values(rec);
}

function playerRecord(slug) {
  let w = 0, l = 0, t = 0;
  for (const R of h2hRecords()) {
    if (R.a === slug) { w += R.aw; l += R.bw; t += R.t; }
    if (R.b === slug) { w += R.bw; l += R.aw; t += R.t; }
  }
  return { w, l, t };
}

// Belt: the first title match winner takes it. The holder keeps it unless
// someone finishes outright ahead of everyone in a title match the holder plays.
function championship() {
  let holder = null, since = null, defenses = 0;
  const reigns = [];
  for (const m of state.matches.filter(m => m.status === "final" && m.title_match).sort(byDate)) {
    const ev = evalMatch(m); if (!ev) continue;
    if (!holder) {
      if (ev.outright) { holder = ev.outright; since = m.scheduled_for; defenses = 0; reigns.push({ player: holder, from: since, to: null, defenses: 0, won_at: m.course_name }); }
      continue;
    }
    if (!m.players.includes(holder) || !ev.rows.find(r => r.player === holder)) continue;
    if (ev.outright && ev.outright !== holder) {
      reigns[reigns.length - 1].to = m.scheduled_for;
      holder = ev.outright; since = m.scheduled_for; defenses = 0;
      reigns.push({ player: holder, from: since, to: null, defenses: 0, won_at: m.course_name });
    } else { defenses++; reigns[reigns.length - 1].defenses = defenses; }
  }
  return { holder, since, defenses, reigns };
}

// ---------- data ----------
async function loadData() {
  if (DEMO) {
    if (state._demoLoaded) return;
    state._demoLoaded = true;
    const d = JSON.parse(JSON.stringify(window.GOLF_DEMO));
    Object.assign(state, d);
    return;
  }
  const [r, m, c, pl] = await Promise.all([
    sb.from("rounds").select("*").order("played_on"),
    sb.from("matches").select("*").order("scheduled_for"),
    sb.from("courses").select("*").order("name"),
    sb.from("players").select("*")
  ]);
  for (const x of [r, m, c]) if (x.error) throw x.error;
  state.start = Object.fromEntries((pl.data || []).filter(x => x.starting_index != null).map(x => [x.slug, Number(x.starting_index)]));
  state.rounds = r.data.map(x => ({ ...x, rating: Number(x.rating), slope: Number(x.slope), par: Number(x.par) }));
  state.matches = m.data.map(x => ({ ...x, rating: x.rating == null ? null : Number(x.rating), slope: x.slope == null ? null : Number(x.slope), par: x.par == null ? null : Number(x.par) }));
  state.courses = c.data.map(x => ({ ...x, rating: Number(x.rating), slope: Number(x.slope), par: Number(x.par) }));
}

async function save(table, row, id) {
  if (DEMO) {
    const list = state[table];
    if (id) Object.assign(list.find(x => x.id === id), row);
    else { row.id = uid(); row.created_at = new Date().toISOString(); list.push(row); }
    return row.id || id;
  }
  const q = id ? sb.from(table).update(row).eq("id", id).select().single() : sb.from(table).insert(row).select().single();
  const { data, error } = await q;
  if (error) throw error;
  return data.id;
}
async function remove(table, id) {
  if (DEMO) { state[table] = state[table].filter(x => x.id !== id); return; }
  const { error } = await sb.from(table).delete().eq("id", id);
  if (error) throw error;
}
async function ensureCourse(c) {
  if (!c.name || !c.rating || !c.slope || !c.par) return null;
  const hit = state.courses.find(x => x.name.toLowerCase() === c.name.toLowerCase() && (x.tee_name || "").toLowerCase() === (c.tee_name || "").toLowerCase());
  if (hit) {
    if (hit.rating !== c.rating || hit.slope !== c.slope || hit.par !== c.par) await save("courses", { rating: c.rating, slope: c.slope, par: c.par }, hit.id);
    return hit.id;
  }
  return save("courses", { name: c.name, tee_name: c.tee_name || null, rating: c.rating, slope: c.slope, par: c.par, city: c.city || null, state: c.state || null, ogapi_id: c.ogapi_id || null });
}

// ---------- chart (single y axis, crosshair tooltip) ----------
function lineChart(series, { height = 220, label = "Handicap index" } = {}) {
  const pts = series.flatMap(s => s.points);
  if (pts.length < 2) return `<div class="empty">The chart shows up once there are at least 3 full rounds posted.</div>`;
  const W = Math.round(Math.max(300, Math.min(790, (document.querySelector("#main")?.clientWidth || 390) - 54))), H = height, L = 30, R = series.length > 1 ? 58 : 14, T = 12, B = 26;
  const xs = pts.map(p => parseDate(p.x).getTime());
  let x0 = Math.min(...xs), x1 = Math.max(...xs); if (x0 === x1) { x0 -= 864e5; x1 += 864e5; }
  let y0 = Math.min(...pts.map(p => p.y)), y1 = Math.max(...pts.map(p => p.y));
  y0 = Math.floor(y0 - 1); y1 = Math.ceil(y1 + 1);
  const X = t => L + (t - x0) / (x1 - x0) * (W - L - R);
  const Y = v => T + (y1 - v) / (y1 - y0) * (H - T - B);
  const step = Math.max(1, Math.ceil((y1 - y0) / 4));
  let grid = "";
  for (let v = Math.ceil(y0); v <= y1; v += step)
    grid += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${L - 6}" y="${Y(v) + 4}" class="axis" text-anchor="end">${v}</text>`;
  const months = [];
  const d = new Date(x0); d.setDate(1); d.setMonth(d.getMonth() + 1);
  while (d.getTime() <= x1) { months.push(d.getTime()); d.setMonth(d.getMonth() + (x1 - x0 > 300 * 864e5 ? 2 : 1)); }
  const xl = months.map(t => `<text x="${X(t)}" y="${H - 6}" class="axis" text-anchor="middle">${new Date(t).toLocaleDateString("en-US", { month: "short" })}</text>`).join("");
  // end labels, nudged apart so they don't collide
  const ends = series.filter(s => s.points.length).map(s => ({ s, y: Y(s.points[s.points.length - 1].y) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  const labY = new Map(ends.map(e => [e.s, e.y]));
  const lines = series.map(s => {
    if (!s.points.length) return "";
    const path = s.points.map((p, i) => `${i ? "L" : "M"}${X(parseDate(p.x).getTime()).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
    const last = s.points[s.points.length - 1];
    const lab = series.length > 1 ? `<text x="${X(parseDate(last.x).getTime()) + 8}" y="${labY.get(s) + 4}" class="dlabel">${esc(s.name)}</text>` : "";
    return `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${X(parseDate(last.x).getTime())}" cy="${Y(last.y)}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>${lab}`;
  }).join("");
  const id = "ch" + Math.random().toString(36).slice(2, 8);
  const data = encodeURIComponent(JSON.stringify({ series: series.map(s => ({ n: s.name, c: s.color, p: s.points.map(p => [parseDate(p.x).getTime(), p.y, p.x]) })), x0, x1, L, R, W, T, B, H, y0, y1 }));
  const legend = series.length > 1 ? `<div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>` : "";
  return `${legend}<div class="chart" id="${id}" data-c="${data}" role="img" aria-label="${esc(label)} over time">
    <svg viewBox="0 0 ${W} ${H}">${grid}${xl}${lines}<line class="xhair" x1="0" x2="0" y1="${T}" y2="${H - B}" style="display:none"/></svg>
    <div class="tip" style="display:none"></div></div>`;
}
function wireCharts(root) {
  root.querySelectorAll(".chart").forEach(el => {
    const c = JSON.parse(decodeURIComponent(el.dataset.c));
    const svg = el.querySelector("svg"), tip = el.querySelector(".tip"), xh = el.querySelector(".xhair");
    const move = ev => {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left) / rect.width * c.W;
      const t = c.x0 + (px - c.L) / (c.W - c.L - c.R) * (c.x1 - c.x0);
      let bestT = null;
      for (const s of c.series) for (const p of s.p) if (bestT == null || Math.abs(p[0] - t) < Math.abs(bestT - t)) bestT = p[0];
      if (bestT == null) return;
      const X = c.L + (bestT - c.x0) / (c.x1 - c.x0) * (c.W - c.L - c.R);
      xh.setAttribute("x1", X); xh.setAttribute("x2", X); xh.style.display = "";
      const rows = c.series.map(s => {
        let v = null; for (const p of s.p) if (p[0] <= bestT) v = p[1];
        return v == null ? "" : `<div><i style="background:${s.c}"></i>${esc(s.n)} <b>${fmtIdx(v)}</b></div>`;
      }).join("");
      tip.innerHTML = `<div class="tdate">${new Date(bestT).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>${rows}`;
      tip.style.display = "";
      const left = X / c.W * rect.width;
      tip.style.left = Math.min(Math.max(left - 70, 0), rect.width - 150) + "px";
    };
    const hide = () => { tip.style.display = "none"; xh.style.display = "none"; };
    el.addEventListener("mousemove", move); el.addEventListener("touchmove", move, { passive: true });
    el.addEventListener("touchstart", move, { passive: true });
    el.addEventListener("mouseleave", hide);
  });
}

// ---------- views ----------
function render() {
  const tab = state.tab;
  document.querySelectorAll(".tabs a").forEach(a => a.classList.toggle("on", a.dataset.tab === tab));
  const main = $("#main");
  main.innerHTML = tab === "h2h" ? viewH2H() : viewPlayer(tab);
  wireCharts(main);
  $("#authbtn").textContent = state.user ? "Sign out" : "Sign in";
  document.body.classList.toggle("editing", !!state.user);
}

function statTile(label, value, sub = "") {
  return `<div class="tile"><div class="tl">${label}</div><div class="tv">${value}</div>${sub ? `<div class="ts">${sub}</div>` : ""}</div>`;
}

function viewPlayer(slug) {
  const p = P[slug];
  const rs = playerRounds(slug);
  const full = rs.filter(r => r.holes === 18);
  const hc = effIndex(rs, slug);
  const best = [...full].sort((a, b) => (a.score - a.par) - (b.score - b.par) || a.score - b.score)[0];
  const last10 = full.slice(-10);
  const avg = last10.length ? r1(last10.reduce((s, r) => s + r.score, 0) / last10.length) : null;
  const rec = playerRecord(slug);
  const ch = championship();
  const champ = ch.holder === slug ? `<span class="belt">🏆 Master Champ</span>` : "";
  const idxSub = hc.starting ? `starting · ${hc.count}/${START_UNTIL} rounds to calculated` : hc.index == null ? `${hc.count}/3 rounds to get one` : `best ${hc.k} of last ${hc.count}`;

  const byCourse = {};
  for (const r of full) {
    const k = r.course_name + (r.tee_name ? ` (${r.tee_name})` : "");
    (byCourse[k] ||= { name: k, n: 0, best: null, sum: 0 });
    const b = byCourse[k]; b.n++; b.sum += r.score; if (!b.best || r.score < b.best.score) b.best = r;
  }
  const courseRows = Object.values(byCourse).sort((a, b) => b.n - a.n).map(b =>
    `<tr><td>${esc(b.name)}</td><td class="n">${b.n}</td><td class="n"><b>${b.best.score}</b></td><td class="n">${r1(b.sum / b.n)}</td></tr>`).join("");

  const logRows = [...rs].reverse().map(r => {
    const counts = hc.used.includes(r.id);
    const m = r.match_id ? state.matches.find(x => x.id === r.match_id) : null;
    return `<tr>
      <td>${fmtShort(r.played_on)}<div class="yr">${r.played_on.slice(0, 4)}</div></td>
      <td>${esc(r.course_name)}${r.tee_name ? `<span class="tee">${esc(r.tee_name)}</span>` : ""}${m ? `<span class="tag">match</span>` : ""}${r.holes === 9 ? `<span class="tag">9 holes</span>` : ""}${r.notes ? `<div class="note">${esc(r.notes)}</div>` : ""}</td>
      <td class="n"><b>${r.score}</b><div class="yr">${toPar(r.score, r.par)}</div></td>
      <td class="n">${countsForIndex(r) ? `<span class="${counts ? "counts" : ""}">${diffOf(r).toFixed(1)}</span>` : "–"}</td>
      <td class="ed"><button class="link" data-act="edit-round" data-id="${r.id}">Edit</button></td></tr>`;
  }).join("");

  return `
  <section class="hero" style="--pc:${p.color}">
    <div class="hname">${dot(slug)} ${esc(p.name)} ${champ}</div>
    <div class="hidx"><span class="big">${fmtIdx(hc.index)}</span><span class="hl">${hc.starting ? "starting handicap" : "handicap index"}</span>
      <button class="link ed" data-act="edit-start" data-id="${slug}">Edit starting</button></div>
  </section>
  <div class="tiles">
    ${statTile("Index", fmtIdx(hc.index), idxSub)}
    ${statTile("Best round", best ? best.score : "–", best ? `${toPar(best.score, best.par)} · ${esc(best.course_name)}` : "")}
    ${statTile("Avg (last 10)", avg ?? "–", `${full.length} full rounds`)}
    ${statTile("Match record", `${rec.w}-${rec.l}${rec.t ? "-" + rec.t : ""}`, "W-L-T vs both")}
  </div>
  <section class="card"><h3>Handicap index over time</h3>${lineChart([{ name: p.name, color: p.color, points: indexHistory(slug) }])}</section>
  <section class="card"><h3>Courses</h3>${courseRows ? `<table class="t"><thead><tr><th>Course</th><th class="n">Rds</th><th class="n">Best</th><th class="n">Avg</th></tr></thead><tbody>${courseRows}</tbody></table>` : `<div class="empty">No rounds yet.</div>`}</section>
  <section class="card"><h3>Round log</h3>
    <p class="hint">Diff = score differential. <span class="counts">Highlighted</span> ones count toward the index.${hc.starting ? ` Starting handicap is used until ${START_UNTIL} full rounds are posted.` : ""}</p>
    ${logRows ? `<table class="t log"><thead><tr><th>Date</th><th>Course</th><th class="n">Score</th><th class="n">Diff</th><th class="ed"></th></tr></thead><tbody>${logRows}</tbody></table>` : `<div class="empty">No rounds yet.</div>`}
  </section>`;
}

function strokesLine(c, slugs) {
  const chs = slugs.map(s => ({ s, ch: courseHcp(currentIndex(s).index, c) }));
  if (chs.some(x => x.ch == null)) return `<div class="strokes muted">Strokes show once everyone has a handicap.</div>`;
  const low = Math.min(...chs.map(x => x.ch));
  return `<div class="strokes">${chs.map(x => `<span>${dot(x.s)}${esc(pname(x.s))} <b>${x.ch}</b>${x.ch > low ? ` <em>gets ${x.ch - low}</em>` : ""}</span>`).join("")}</div>`;
}

function viewH2H() {
  const ch = championship();
  const holder = ch.holder ? P[ch.holder] : null;
  const champCard = `<section class="champ">
    <div class="cl">Master Champ</div>
    ${holder ? `<div class="cn">${dot(ch.holder)} ${esc(holder.name)}</div>
      <div class="cs">Holding since ${fmtDate(ch.since)} · ${daysBetween(ch.since, today())} days · ${ch.defenses} defense${ch.defenses === 1 ? "" : "s"}</div>`
      : `<div class="cn">Vacant</div><div class="cs">The first title match crowns the champ.</div>`}
    <details><summary>How the belt works</summary><p>Every match marked as a title match counts. The first outright winner takes the belt. After that, the champ keeps it unless someone finishes outright ahead of everyone (net, unless the match is set to gross) in a title match the champ plays. Ties go to the champ.</p></details>
    ${ch.reigns.length ? `<div class="reigns">${[...ch.reigns].reverse().map(r => `<div>${dot(r.player)}<b>${esc(pname(r.player))}</b> ${fmtShort(r.from)} – ${r.to ? fmtShort(r.to) : "now"} · ${r.defenses} def.</div>`).join("")}</div>` : ""}
  </section>`;

  const idxCards = PLAYERS.map(p => {
    const h = currentIndex(p.slug);
    return `<div class="tile" style="border-top:3px solid ${p.color}"><div class="tl">${esc(p.name)}</div><div class="tv">${fmtIdx(h.index)}</div><div class="ts">${h.starting ? "starting" : h.count + " rounds"}</div></div>`;
  }).join("");

  const recs = h2hRecords().map(R => {
    const n = R.aw + R.bw + R.t;
    const last = R.last.slice(-5).map(x => `<i style="background:${x === "t" ? "var(--muted)" : P[x].color}" title="${x === "t" ? "Tie" : esc(pname(x))}"></i>`).join("");
    const pa = n ? R.aw / n * 100 : 50, pb = n ? R.bw / n * 100 : 50;
    return `<div class="rec">
      <div class="rr"><span>${dot(R.a)}${esc(pname(R.a))} <b>${R.aw}</b></span><span class="muted">${R.t ? R.t + " tied" : ""}</span><span><b>${R.bw}</b> ${esc(pname(R.b))}${dot(R.b)}</span></div>
      <div class="bar"><span style="width:${pa}%;background:${P[R.a].color}"></span><span style="width:${100 - pa - pb}%;background:var(--line)"></span><span style="width:${pb}%;background:${P[R.b].color}"></span></div>
      ${n ? `<div class="form">Last ${Math.min(5, n)}: ${last}</div>` : `<div class="form muted">No matches yet</div>`}
    </div>`;
  }).join("");

  const upcoming = state.matches.filter(m => m.status === "scheduled").sort(byDate);
  const upRows = upcoming.map(m => {
    const d = daysBetween(today(), m.scheduled_for);
    const when = d > 1 ? `in ${d} days` : d === 1 ? "tomorrow" : d === 0 ? "today" : "needs results";
    const hasCourse = m.rating && m.slope && m.par;
    return `<div class="match ${d < 0 ? "due" : ""}">
      <div class="mh"><b>${fmtDate(m.scheduled_for)}</b>${m.tee_time ? ` · ${esc(m.tee_time)}` : ""}<span class="when">${when}</span></div>
      <div class="mc">${esc(m.course_name || "Course TBD")}${m.tee_name ? `<span class="tee">${esc(m.tee_name)}</span>` : ""}${m.title_match ? `<span class="tag gold">🏆 title match</span>` : ""}<span class="tag">${m.scoring}</span></div>
      <div class="mp">${m.players.map(s => `<span>${dot(s)}${esc(pname(s))}</span>`).join(" vs ")}</div>
      ${hasCourse && m.scoring === "net" ? strokesLine(m, m.players) : ""}
      ${m.notes ? `<div class="note">${esc(m.notes)}</div>` : ""}
      <div class="ed acts"><button data-act="results" data-id="${m.id}">Post results</button><button class="link" data-act="edit-match" data-id="${m.id}">Edit</button></div>
    </div>`;
  }).join("");

  const past = state.matches.filter(m => m.status === "final").sort(byDate).reverse();
  const pastRows = past.map(m => {
    const ev = evalMatch(m);
    if (!ev) return "";
    return `<div class="match">
      <div class="mh"><b>${fmtDate(m.scheduled_for)}</b> · ${esc(m.course_name)}${m.title_match ? `<span class="tag gold">🏆</span>` : ""}<span class="tag">${m.scoring}</span></div>
      <table class="t res"><thead><tr><th></th><th class="n">Gross</th>${m.scoring === "net" ? `<th class="n">Hcp</th><th class="n">Net</th>` : ""}</tr></thead><tbody>
      ${ev.rows.map(r => `<tr class="${ev.winners.includes(r.player) ? "win" : ""}"><td>${dot(r.player)}${esc(pname(r.player))}${ev.winners.includes(r.player) ? (ev.outright ? " 🏅" : " (tie)") : ""}</td><td class="n">${r.gross}</td>${m.scoring === "net" ? `<td class="n">${r.noHcp ? "–" : r.ch}</td><td class="n"><b>${r.net}</b></td>` : ""}</tr>`).join("")}
      </tbody></table>
      <div class="ed acts"><button class="link" data-act="edit-match" data-id="${m.id}">Edit</button><button class="link" data-act="results" data-id="${m.id}">Edit scores</button></div>
    </div>`;
  }).join("");

  const savedCourses = state.courses.filter(c => c.rating && c.slope && c.par);
  const calc = savedCourses.length ? `<section class="card"><h3>Strokes calculator</h3>
    <select id="calcCourse">${savedCourses.map(c => `<option value="${c.id}">${esc(c.name)}${c.tee_name ? " · " + esc(c.tee_name) : ""}</option>`).join("")}</select>
    <div id="calcOut">${strokesLine(savedCourses[0], PLAYERS.map(p => p.slug))}</div>
    <p class="hint">Course handicap = index × slope ÷ 113 + (rating − par).</p></section>` : "";

  return `${champCard}
  <section class="card"><h3>Upcoming matches</h3>${upRows || `<div class="empty">Nothing scheduled.</div>`}
    <button class="primary ed" data-act="new-match">+ Schedule a match</button></section>
  <div class="tiles three">${idxCards}</div>
  <section class="card"><h3>Handicap race</h3>${lineChart(PLAYERS.map(p => ({ name: p.name, color: p.color, points: indexHistory(p.slug) })))}</section>
  <section class="card"><h3>Head to head</h3><p class="hint">Every final match counts, scored the way it was set up (net or gross).</p>${recs}</section>
  ${calc}
  <section class="card"><h3>Results</h3>${pastRows || `<div class="empty">No results yet.</div>`}</section>`;
}

// ---------- modals & forms ----------
function openModal(html, onReady) {
  const m = $("#modal");
  m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><button class="x" data-close aria-label="Close">✕</button>${html}</div>`;
  m.hidden = false; document.body.classList.add("noscroll");
  m.onclick = e => { if (e.target === m || e.target.closest("[data-close]")) closeModal(); };
  onReady && onReady(m);
}
function closeModal() { const m = $("#modal"); m.hidden = true; m.innerHTML = ""; document.body.classList.remove("noscroll"); }
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 3000); }
const errMsg = e => (e && (e.message || e.error_description)) || String(e);

function courseFields(v = {}) {
  return `<label>Course<input name="course_name" id="cq" autocomplete="off" value="${esc(v.course_name || "")}" placeholder="Search saved or online courses"></label>
  <div id="cres" class="cres"></div>
  <div class="row4">
    <label>Tee<input name="tee_name" value="${esc(v.tee_name || "")}"></label>
    <label>Rating<input name="rating" inputmode="decimal" value="${v.rating ?? ""}"></label>
    <label>Slope<input name="slope" inputmode="numeric" value="${v.slope ?? ""}"></label>
    <label>Par<input name="par" inputmode="numeric" value="${v.par ?? ""}"></label>
  </div>
  <input type="hidden" name="ogapi_id" value="${esc(v.ogapi_id || "")}"><input type="hidden" name="city"><input type="hidden" name="state">
  <p class="hint">Pick a course to fill rating, slope, and par. They're on the scorecard if the lookup doesn't have your tees.</p>`;
}

function wireCoursePicker(form) {
  const q = $("#cq", form), box = $("#cres", form);
  let timer = null, seq = 0;
  const fill = c => {
    form.course_name.value = c.name; form.tee_name.value = c.tee_name || "";
    form.rating.value = c.rating ?? ""; form.slope.value = c.slope ?? ""; form.par.value = c.par ?? "";
    form.ogapi_id.value = c.ogapi_id || ""; form.city.value = c.city || ""; form.state.value = c.state || "";
    box.innerHTML = "";
  };
  q.addEventListener("input", () => {
    clearTimeout(timer);
    const term = q.value.trim().toLowerCase();
    if (term.length < 3) { box.innerHTML = ""; return; }
    const saved = state.courses.filter(c => c.name.toLowerCase().includes(term)).slice(0, 6);
    const savedHtml = saved.map(c => `<button type="button" class="opt" data-saved="${c.id}"><b>${esc(c.name)}</b> ${c.tee_name ? esc(c.tee_name) + " · " : ""}${c.rating}/${c.slope} · par ${c.par}<span class="tag">saved</span></button>`).join("");
    box.innerHTML = savedHtml + `<div class="muted small">Searching online…</div>`;
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const res = await fetch(`${OGAPI}/v1/courses/search?q=${encodeURIComponent(term)}`);
        const js = await res.json();
        if (my !== seq) return;
        const online = (js.courses || []).slice(0, 8).map(c => `<button type="button" class="opt" data-og="${esc(c.id)}" data-name="${esc(c.name)}" data-city="${esc(c.city || "")}" data-state="${esc(c.state || "")}"><b>${esc(c.name)}</b> ${esc([c.city, c.state].filter(Boolean).join(", "))}</button>`).join("");
        box.innerHTML = savedHtml + (online || `<div class="muted small">No online matches. Type the course and enter rating, slope, and par yourself.</div>`);
      } catch (e) { if (my === seq) box.innerHTML = savedHtml + `<div class="muted small">Online lookup unavailable right now. Enter rating, slope, and par yourself.</div>`; }
    }, 350);
  });
  box.addEventListener("click", async e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.saved) return fill(state.courses.find(c => c.id === b.dataset.saved));
    if (b.dataset.tee) return fill(JSON.parse(decodeURIComponent(b.dataset.tee)));
    if (b.dataset.og) {
      box.innerHTML = `<div class="muted small">Loading tees…</div>`;
      try {
        const res = await fetch(`${OGAPI}/api/v1/courses/${encodeURIComponent(b.dataset.og)}`);
        const c = await res.json();
        const name = b.dataset.name, city = b.dataset.city, st = b.dataset.state;
        const tees = (c.tees || []).filter(t => t.course_rating && t.slope);
        if (!tees.length) { fill({ name, par: c.par, ogapi_id: b.dataset.og, city, state: st }); toast("No tee ratings online for this course. Add them from the scorecard."); return; }
        box.innerHTML = `<div class="muted small">Pick your tees:</div>` + tees.map(t => {
          const v = { name, tee_name: t.tee_name + (t.gender && t.gender !== "Male" ? ` (${t.gender[0]})` : ""), rating: t.course_rating, slope: t.slope, par: t.par || c.par, ogapi_id: b.dataset.og, city, state: st };
          return `<button type="button" class="opt" data-tee="${encodeURIComponent(JSON.stringify(v))}"><b>${esc(v.tee_name)}</b> ${t.yardage ? t.yardage + " yds · " : ""}${t.course_rating}/${t.slope} · par ${v.par}</button>`;
        }).join("");
      } catch (err) { box.innerHTML = `<div class="muted small">Couldn't load tees. Enter them yourself.</div>`; }
    }
  });
}

function readCourse(f) {
  return { course_name: f.course_name.value.trim(), tee_name: f.tee_name.value.trim() || null,
    rating: f.rating.value ? Number(f.rating.value) : null, slope: f.slope.value ? Number(f.slope.value) : null,
    par: f.par.value ? Number(f.par.value) : null, ogapi_id: f.ogapi_id.value || null, city: f.city.value || null, state: f.state.value || null };
}

function roundForm(r) {
  const editing = !!r;
  r = r || { player: localStorage.getItem("golf_me") || (state.tab !== "h2h" ? state.tab : PLAYERS[0].slug), played_on: today(), holes: 18 };
  openModal(`<h2>${editing ? "Edit round" : "Post a round"}</h2>
    <form id="rf">
      <label>Player<select name="player">${PLAYERS.map(p => `<option value="${p.slug}" ${p.slug === r.player ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
      <div class="row2"><label>Date<input type="date" name="played_on" value="${r.played_on}" required></label>
      <label>Holes<select name="holes"><option ${r.holes === 18 ? "selected" : ""}>18</option><option ${r.holes === 9 ? "selected" : ""}>9</option></select></label></div>
      ${courseFields(r)}
      <label>Final score<input name="score" inputmode="numeric" required value="${r.score ?? ""}"></label>
      <label>Notes<input name="notes" value="${esc(r.notes || "")}" placeholder="optional"></label>
      <p class="hint">9-hole rounds are saved but don't count toward the handicap.</p>
      <div class="acts"><button class="primary" type="submit">Save</button>${editing ? `<button type="button" class="danger" id="del">Delete</button>` : ""}</div>
    </form>`, m => {
    const f = $("#rf", m); wireCoursePicker(f);
    f.onsubmit = async e => {
      e.preventDefault();
      const c = readCourse(f);
      const row = { player: f.player.value, played_on: f.played_on.value, holes: Number(f.holes.value), score: Number(f.score.value),
        notes: f.notes.value.trim() || null, course_name: c.course_name, tee_name: c.tee_name, rating: c.rating, slope: c.slope, par: c.par };
      if (!row.course_name || !row.score) return toast("Course and score are required.");
      if (!row.rating || !row.slope || !row.par) return toast("Rating, slope, and par are needed for the handicap.");
      if (row.score < 18 || row.score > 200) return toast("That score looks off.");
      try {
        localStorage.setItem("golf_me", row.player);
        row.course_id = await ensureCourse({ ...c, name: c.course_name });
        await save("rounds", row, editing ? r.id : null);
        closeModal(); await refresh(); toast("Round saved.");
      } catch (err) { toast("Couldn't save: " + errMsg(err)); }
    };
    if (editing) $("#del", m).onclick = async () => {
      if (!confirm("Delete this round?")) return;
      try { await remove("rounds", r.id); closeModal(); await refresh(); toast("Deleted."); } catch (err) { toast(errMsg(err)); }
    };
  });
}

function matchForm(mt) {
  const editing = !!mt;
  mt = mt || { scheduled_for: today(), players: PLAYERS.map(p => p.slug), scoring: "net", title_match: true, status: "scheduled" };
  openModal(`<h2>${editing ? "Edit match" : "Schedule a match"}</h2>
    <form id="mf">
      <div class="row2"><label>Date<input type="date" name="scheduled_for" value="${mt.scheduled_for}" required></label>
      <label>Tee time<input name="tee_time" value="${esc(mt.tee_time || "")}" placeholder="optional"></label></div>
      ${courseFields(mt)}
      <fieldset><legend>Players</legend>${PLAYERS.map(p => `<label class="chk"><input type="checkbox" name="pl" value="${p.slug}" ${mt.players.includes(p.slug) ? "checked" : ""}> ${dot(p.slug)}${esc(p.name)}</label>`).join("")}</fieldset>
      <div class="row2"><label>Scoring<select name="scoring"><option value="net" ${mt.scoring === "net" ? "selected" : ""}>Net (handicaps)</option><option value="gross" ${mt.scoring === "gross" ? "selected" : ""}>Gross</option></select></label>
      <label class="chk tm"><input type="checkbox" name="title_match" ${mt.title_match ? "checked" : ""}> 🏆 Title match</label></div>
      <label>Notes<input name="notes" value="${esc(mt.notes || "")}" placeholder="optional"></label>
      <div class="acts"><button class="primary" type="submit">Save</button>${editing ? `<button type="button" class="danger" id="del">Delete</button>` : ""}</div>
    </form>`, m => {
    const f = $("#mf", m); wireCoursePicker(f);
    f.onsubmit = async e => {
      e.preventDefault();
      const c = readCourse(f);
      const players = [...f.querySelectorAll("[name=pl]:checked")].map(x => x.value);
      if (players.length < 2) return toast("Pick at least 2 players.");
      const row = { scheduled_for: f.scheduled_for.value, tee_time: f.tee_time.value.trim() || null, players, scoring: f.scoring.value,
        title_match: f.title_match.checked, notes: f.notes.value.trim() || null, course_name: c.course_name || null, tee_name: c.tee_name,
        rating: c.rating, slope: c.slope, par: c.par, status: mt.status || "scheduled" };
      try {
        if (c.course_name && c.rating && c.slope && c.par) row.course_id = await ensureCourse({ ...c, name: c.course_name });
        await save("matches", row, editing ? mt.id : null);
        closeModal(); await refresh(); toast("Match saved.");
      } catch (err) { toast("Couldn't save: " + errMsg(err)); }
    };
    if (editing) $("#del", m).onclick = async () => {
      if (!confirm("Delete this match? Rounds posted from it stay on each player's log.")) return;
      try {
        for (const r of state.rounds.filter(r => r.match_id === mt.id)) await save("rounds", { match_id: null }, r.id);
        await remove("matches", mt.id); closeModal(); await refresh(); toast("Deleted.");
      } catch (err) { toast(errMsg(err)); }
    };
  });
}

function resultsForm(mt) {
  const existing = Object.fromEntries(state.rounds.filter(r => r.match_id === mt.id).map(r => [r.player, r]));
  openModal(`<h2>Results</h2><p class="hint">${fmtDate(mt.scheduled_for)}${mt.course_name ? " · " + esc(mt.course_name) : ""}</p>
    <form id="xf">
      ${courseFields(mt)}
      ${mt.players.map(s => `<label>${dot(s)}${esc(pname(s))} final score<input name="s_${s}" inputmode="numeric" value="${existing[s]?.score ?? ""}"></label>`).join("")}
      <p class="hint">Each score is also added to that player's round log. Leave someone blank if they didn't finish.</p>
      <div class="acts"><button class="primary" type="submit">Save results</button></div>
    </form>`, m => {
    const f = $("#xf", m); wireCoursePicker(f);
    f.onsubmit = async e => {
      e.preventDefault();
      const c = readCourse(f);
      if (!c.course_name || !c.rating || !c.slope || !c.par) return toast("Course rating, slope, and par are needed.");
      const scores = mt.players.map(s => [s, Number(f["s_" + s].value)]).filter(([, v]) => v > 0);
      if (scores.length < 2) return toast("Enter at least 2 scores.");
      try {
        const course_id = await ensureCourse({ ...c, name: c.course_name });
        for (const [s, v] of scores) {
          const row = { player: s, played_on: mt.scheduled_for, holes: 18, score: v, course_name: c.course_name, tee_name: c.tee_name,
            rating: c.rating, slope: c.slope, par: c.par, course_id, match_id: mt.id };
          await save("rounds", row, existing[s]?.id || null);
        }
        await save("matches", { status: "final", course_name: c.course_name, tee_name: c.tee_name, rating: c.rating, slope: c.slope, par: c.par, course_id }, mt.id);
        closeModal(); await refresh(); toast("Results saved.");
      } catch (err) { toast("Couldn't save: " + errMsg(err)); }
    };
  });
}

function startForm(slug) {
  openModal(`<h2>${esc(pname(slug))}'s starting handicap</h2>
    <form id="hf"><label>Starting handicap<input name="v" inputmode="decimal" value="${state.start[slug] ?? ""}" placeholder="blank = none"></label>
    <p class="hint">Used until ${START_UNTIL} full rounds are posted, then the calculated index takes over.</p>
    <div class="acts"><button class="primary" type="submit">Save</button></div></form>`, m => {
    $("#hf", m).onsubmit = async e => {
      e.preventDefault();
      const raw = e.target.v.value.trim();
      const v = raw === "" ? null : Number(raw);
      if (raw !== "" && (isNaN(v) || v < -10 || v > 54)) return toast("Enter a handicap between -10 and 54.");
      try {
        if (!DEMO) { const { error } = await sb.from("players").upsert({ slug, starting_index: v, updated_at: new Date().toISOString() }); if (error) throw error; }
        if (v == null) delete state.start[slug]; else state.start[slug] = v;
        closeModal(); await refresh(); toast("Saved.");
      } catch (err) { toast("Couldn't save: " + errMsg(err)); }
    };
  });
}

function signInForm() {
  openModal(`<h2>Sign in</h2><p class="hint">Only Trent, Dad, and Logan have logins.</p>
    <form id="sf"><label>Email<input type="email" name="email" autocomplete="username" required></label>
    <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
    <div class="acts"><button class="primary" type="submit">Sign in</button></div></form>`, m => {
    $("#sf", m).onsubmit = async e => {
      e.preventDefault();
      const f = e.target;
      if (DEMO) { state.user = { email: "demo" }; closeModal(); render(); toast("Demo mode: edits aren't saved."); return; }
      const { data, error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
      if (error) return toast(error.message);
      state.user = data.user; closeModal(); render(); toast("Signed in.");
    };
  });
}

function addMenu() {
  openModal(`<h2>Add</h2><div class="acts col"><button class="primary" data-go="round">Post a round</button><button data-go="match">Schedule a match</button></div>`, m => {
    m.querySelector("[data-go=round]").onclick = () => roundForm();
    m.querySelector("[data-go=match]").onclick = () => matchForm();
  });
}

// ---------- boot ----------
async function refresh() {
  try { await loadData(); } catch (e) { toast("Couldn't load data: " + errMsg(e)); }
  render();
}

function route() {
  const h = location.hash.slice(1);
  state.tab = P[h] || h === "h2h" ? h : "h2h";
  render();
  window.scrollTo(0, 0);
}

document.addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const id = b.dataset.id, act = b.dataset.act;
  if (act === "edit-round") roundForm(state.rounds.find(r => r.id === id));
  if (act === "edit-match") matchForm(state.matches.find(m => m.id === id));
  if (act === "results") resultsForm(state.matches.find(m => m.id === id));
  if (act === "new-match") matchForm();
  if (act === "edit-start") startForm(id);
});
document.addEventListener("change", e => {
  if (e.target.id === "calcCourse") {
    const c = state.courses.find(x => x.id === e.target.value);
    $("#calcOut").innerHTML = strokesLine(c, PLAYERS.map(p => p.slug));
  }
});

(async function init() {
  document.title = CFG.siteTitle;
  $("#title").textContent = CFG.siteTitle;
  $("#tagline").textContent = CFG.tagline || "";
  $(".tabs").innerHTML = PLAYERS.map(p => `<a href="#${p.slug}" data-tab="${p.slug}">${dot(p.slug)}${esc(p.name)}</a>`).join("") + `<a href="#h2h" data-tab="h2h">Head to Head</a>`;
  if (DEMO) $("#demo").hidden = false;
  else {
    const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
    sb = createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
    const { data } = await sb.auth.getSession();
    state.user = data.session?.user || null;
    sb.auth.onAuthStateChange((_e, s) => { state.user = s?.user || null; render(); });
  }
  $("#authbtn").onclick = async () => {
    if (state.user) { if (!DEMO) await sb.auth.signOut(); state.user = null; render(); toast("Signed out."); }
    else signInForm();
  };
  $("#fab").onclick = addMenu;
  window.addEventListener("hashchange", route);
  let rz = null, lastW = innerWidth;
  window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (Math.abs(innerWidth - lastW) > 40) { lastW = innerWidth; render(); } }, 250); });
  await loadData().catch(e => toast("Couldn't load data: " + errMsg(e)));
  route();
})();
