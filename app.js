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
const state = { rounds: [], matches: [], courses: [], cards: [], start: {}, phrase: localStorage.getItem("golf_phrase"), tab: null, cardId: null };
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
// Reads are public. Every write goes through a database function that checks
// the family security phrase on the server, so the phrase is never in this code.
async function loadData() {
  if (DEMO) {
    if (state._demoLoaded) return;
    state._demoLoaded = true;
    const d = JSON.parse(JSON.stringify(window.GOLF_DEMO));
    Object.assign(state, d);
    state.cards = state.cards || [];
    return;
  }
  const [r, m, c, pl, cd] = await Promise.all([
    sb.from("rounds").select("*").order("played_on"),
    sb.from("matches").select("*").order("scheduled_for"),
    sb.from("courses").select("*").order("name"),
    sb.from("players").select("*"),
    sb.from("cards").select("*").eq("status", "live").order("created_at")
  ]);
  for (const x of [r, m, c]) if (x.error) throw x.error;
  state.start = Object.fromEntries((pl.data || []).filter(x => x.starting_index != null).map(x => [x.slug, Number(x.starting_index)]));
  state.rounds = r.data.map(x => ({ ...x, rating: Number(x.rating), slope: Number(x.slope), par: Number(x.par) }));
  state.matches = m.data.map(x => ({ ...x, rating: x.rating == null ? null : Number(x.rating), slope: x.slope == null ? null : Number(x.slope), par: x.par == null ? null : Number(x.par) }));
  state.courses = c.data.map(x => ({ ...x, rating: Number(x.rating), slope: Number(x.slope), par: Number(x.par) }));
  state.cards = (cd.data || []).map(x => ({ ...x, rating: x.rating == null ? null : Number(x.rating) }));
}

async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, { p: state.phrase || "", ...args });
  if (error) {
    if (/security phrase/i.test(error.message)) lock(true);
    throw error;
  }
  return data;
}
async function save(table, row, id) {
  if (DEMO) {
    const list = state[table] ||= [];
    if (id) Object.assign(list.find(x => x.id === id), row);
    else { row.id = uid(); row.created_at = new Date().toISOString(); list.push(row); }
    return row.id || id;
  }
  return rpc("gt_save", { tbl: table, data: row, rid: id || null });
}
async function remove(table, id) {
  if (DEMO) { state[table] = state[table].filter(x => x.id !== id); return; }
  await rpc("gt_delete", { tbl: table, rid: id });
}
async function ensureCourse(c) {
  if (!c.name || !c.rating || !c.slope || !c.par) return null;
  const hit = state.courses.find(x => x.name.toLowerCase() === c.name.toLowerCase() && (x.tee_name || "").toLowerCase() === (c.tee_name || "").toLowerCase());
  const extra = {};
  if (c.pars?.length) extra.pars = c.pars;
  if (c.lat != null) { extra.lat = c.lat; extra.lng = c.lng; }
  if (hit) {
    const upd = { ...extra };
    if (hit.rating !== c.rating || hit.slope !== c.slope || hit.par !== c.par) Object.assign(upd, { rating: c.rating, slope: c.slope, par: c.par });
    if (hit.pars?.length && upd.pars) delete upd.pars;
    if (hit.lat != null) { delete upd.lat; delete upd.lng; }
    if (Object.keys(upd).length) { await save("courses", upd, hit.id); Object.assign(hit, upd); }
    return hit.id;
  }
  return save("courses", { name: c.name, tee_name: c.tee_name || null, rating: c.rating, slope: c.slope, par: c.par, city: c.city || null, state: c.state || null, ogapi_id: c.ogapi_id || null, ...extra });
}

// ---------- security phrase ----------
const editing = () => !!state.phrase;
function lock(wrong) {
  state.phrase = null;
  localStorage.removeItem("golf_phrase");
  render();
  if (wrong) toast("Security phrase changed or wrong. Enter it again.");
}
function phraseForm(then) {
  openModal(`<h2>Enter scores</h2><p class="hint">Type the family security phrase. This phone remembers it until you lock it.</p>
    <form id="pf"><label>Security phrase<input name="p" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" required></label>
    <div class="acts"><button class="primary" type="submit">Unlock</button></div></form>`, m => {
    const f = $("#pf", m); setTimeout(() => f.p.focus(), 50);
    f.onsubmit = async e => {
      e.preventDefault();
      const p = f.p.value.trim();
      const btn = f.querySelector("button"); btn.disabled = true;
      try {
        let ok = true;
        if (!DEMO) { const r = await sb.rpc("gt_check", { p }); if (r.error) throw r.error; ok = r.data; }
        if (!ok) { btn.disabled = false; f.p.select(); return toast("That's not it."); }
        state.phrase = p; localStorage.setItem("golf_phrase", p);
        closeModal(); render(); toast("Unlocked. Tap + to add.");
        then && then();
      } catch (err) { btn.disabled = false; toast(errMsg(err)); }
    };
  });
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
  if (!tab) return;
  document.querySelectorAll(".tabs a").forEach(a => a.classList.toggle("on", a.dataset.tab === tab));
  const main = $("#main");
  main.innerHTML = tab === "card" ? viewCard(state.cardId) : liveStrip() + (tab === "h2h" ? viewH2H() : viewPlayer(tab));
  wireCharts(main);
  $("#authbtn").textContent = editing() ? "Lock" : "Enter scores";
  document.body.classList.toggle("editing", editing());
  document.body.classList.toggle("oncard", tab === "card");
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
      <td>${esc(r.course_name)}${r.tee_name ? `<span class="tee">${esc(r.tee_name)}</span>` : ""}${m ? `<span class="tag">match</span>` : ""}${r.holes === 9 ? `<span class="tag">9 holes</span>` : ""}${r.hole_scores ? `<span class="tag">hole by hole</span>` : ""}${r.notes ? `<div class="note">${esc(r.notes)}</div>` : ""}</td>
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
      <div class="ed acts"><button class="primary" data-act="start-card" data-id="${m.id}">Start scorecard</button><button data-act="results" data-id="${m.id}">Post results</button><button class="link" data-act="edit-match" data-id="${m.id}">Edit</button></div>
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

// ---------- course finder ----------
// Near me: saved courses + OpenGolfAPI (has tee ratings) + OpenStreetMap golf
// courses (names and locations only). Tee rating/slope come from OpenGolfAPI
// when it has them; otherwise they're typed once from the scorecard and saved.
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
const miles = (a, b, c, d) => { const R = 3958.8, t = Math.PI / 180, x = (c - a) * t, y = (d - b) * t;
  const h = Math.sin(x / 2) ** 2 + Math.cos(a * t) * Math.cos(c * t) * Math.sin(y / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const normName = s => String(s || "").toLowerCase().replace(/golf|country|club|course|links|the|&|and|[^a-z0-9]/g, "");
function timed(url, opts = {}, ms = 9000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}
function myLocation() {
  return new Promise((ok, no) => {
    if (!navigator.geolocation) return no(new Error("This browser can't share location."));
    navigator.geolocation.getCurrentPosition(p => ok({ lat: p.coords.latitude, lng: p.coords.longitude }),
      e => no(new Error(e.code === 1 ? "Location is blocked. Allow it for this site in your browser settings." : "Couldn't get your location.")),
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
  });
}
async function osmNear({ lat, lng }) {
  const q = `[out:json][timeout:15];nwr["leisure"="golf_course"]["name"](around:40000,${lat},${lng});out center tags 40;`;
  for (const host of OVERPASS) {
    try {
      const r = await timed(host + "?data=" + encodeURIComponent(q), {}, 12000);
      if (!r.ok) continue;
      const j = await r.json();
      return j.elements.map(e => {
        const la = e.center?.lat ?? e.lat, lo = e.center?.lon ?? e.lon;
        return { src: "osm", name: e.tags.name, city: e.tags["addr:city"] || "", state: e.tags["addr:state"] || "", lat: la, lng: lo, mi: miles(lat, lng, la, lo) };
      });
    } catch (e) { /* try next mirror */ }
  }
  return [];
}
async function ogNear({ lat, lng }) {
  try {
    const r = await timed(`${OGAPI}/v1/courses/search?lat=${lat}&lng=${lng}&radius_mi=25&limit=25`, {}, 9000);
    const j = await r.json();
    return (j.courses || []).filter(c => c.latitude != null).map(c => ({ src: "og", id: c.id, name: c.course_name || c.name, city: c.city || "", state: c.state || "",
      lat: c.latitude, lng: c.longitude, mi: c.distance_mi ?? miles(lat, lng, c.latitude, c.longitude) }));
  } catch (e) { return []; }
}
async function ogByName(term) {
  const r = await timed(`${OGAPI}/v1/courses/search?q=${encodeURIComponent(term)}&limit=10`, {}, 9000);
  const j = await r.json();
  return (j.courses || []).map(c => ({ src: "og", id: c.id, name: c.course_name || c.name, city: c.city || "", state: c.state || "", lat: c.latitude, lng: c.longitude }));
}
// Course detail: tee ratings and, when listed, the par for each hole.
async function ogDetail(id) {
  let c = null;
  for (const u of [`${OGAPI}/api/v1/courses/${encodeURIComponent(id)}`, `${OGAPI}/v1/courses/${encodeURIComponent(id)}`]) {
    try { const r = await timed(u, {}, 9000); if (r.ok) { c = await r.json(); if (c && (c.tees || c.holes)) break; } } catch (e) { /* next */ }
  }
  if (!c) throw new Error("no detail");
  const holes = (c.holes || []).map(h => ({ n: Number(h.hole_number ?? h.number ?? h.hole), par: Number(h.par) })).filter(h => h.n && h.par >= 3 && h.par <= 6).sort((a, b) => a.n - b.n);
  const pars = (holes.length === 18 || holes.length === 9) ? holes.map(h => h.par) : null;
  const tees = (c.tees || []).map(t => ({ name: t.tee_name || t.name || t.color || "Tee", gender: t.gender, rating: Number(t.course_rating ?? t.rating), slope: Number(t.slope ?? t.slope_rating), par: Number(t.par) || null, yards: t.yardage || t.total_yardage || null }))
    .filter(t => t.rating > 50 && t.slope >= 55 && t.slope <= 155);
  return { par: c.par_total || c.par || (pars ? pars.reduce((a, b) => a + b, 0) : null), pars, tees };
}

function courseFields(v = {}) {
  return `<label>Course<input name="course_name" id="cq" autocomplete="off" value="${esc(v.course_name || "")}" placeholder="Type a name, or use Near me"></label>
  <button type="button" class="near" id="near">📍 Courses near me</button>
  <div id="cres" class="cres"></div>
  <div class="row4">
    <label>Tee<input name="tee_name" value="${esc(v.tee_name || "")}"></label>
    <label>Rating<input name="rating" inputmode="decimal" value="${v.rating ?? ""}"></label>
    <label>Slope<input name="slope" inputmode="numeric" value="${v.slope ?? ""}"></label>
    <label>Par<input name="par" inputmode="numeric" value="${v.par ?? ""}"></label>
  </div>
  <input type="hidden" name="ogapi_id" value="${esc(v.ogapi_id || "")}"><input type="hidden" name="city"><input type="hidden" name="state">
  <input type="hidden" name="lat" value="${v.lat ?? ""}"><input type="hidden" name="lng" value="${v.lng ?? ""}"><input type="hidden" name="pars" value="${esc(v.pars ? JSON.stringify(v.pars) : "")}">
  <p class="hint">Rating and slope are printed on the scorecard next to each tee. You only type them once per course.</p>`;
}

function wireCoursePicker(form) {
  const q = $("#cq", form), box = $("#cres", form);
  let timer = null, seq = 0;
  const fill = c => {
    form.course_name.value = c.name; form.tee_name.value = c.tee_name || "";
    form.rating.value = c.rating ?? ""; form.slope.value = c.slope ?? ""; form.par.value = c.par ?? "";
    form.ogapi_id.value = c.ogapi_id || ""; form.city.value = c.city || ""; form.state.value = c.state || "";
    form.lat.value = c.lat ?? ""; form.lng.value = c.lng ?? ""; form.pars.value = c.pars?.length ? JSON.stringify(c.pars) : "";
    box.innerHTML = "";
    form.dispatchEvent(new CustomEvent("coursepicked", { detail: c }));
    if (!c.rating || !c.slope) { toast("Add the tee, rating, and slope from the scorecard."); setTimeout(() => (c.tee_name ? form.rating : form.tee_name).focus(), 50); }
  };
  const savedBtn = (c, mi) => `<button type="button" class="opt" data-saved="${c.id}"><b>${esc(c.name)}</b> ${c.tee_name ? esc(c.tee_name) + " · " : ""}${c.rating}/${c.slope} · par ${c.par}${mi != null ? ` · ${mi.toFixed(1)} mi` : ""}<span class="tag">saved</span></button>`;
  const onlineBtn = c => `<button type="button" class="opt" data-pick="${encodeURIComponent(JSON.stringify(c))}"><b>${esc(c.name)}</b> <span class="muted">${esc([c.city, c.state].filter(Boolean).join(", "))}${c.mi != null ? ` · ${c.mi.toFixed(1)} mi` : ""}</span></button>`;

  q.addEventListener("input", () => {
    clearTimeout(timer);
    const term = q.value.trim().toLowerCase();
    form.ogapi_id.value = ""; form.lat.value = ""; form.lng.value = ""; form.pars.value = "";
    if (term.length < 3) { box.innerHTML = ""; return; }
    const saved = state.courses.filter(c => c.name.toLowerCase().includes(term)).slice(0, 6);
    const savedHtml = saved.map(c => savedBtn(c)).join("");
    box.innerHTML = savedHtml + `<div class="muted small">Searching online…</div>`;
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const online = (await ogByName(term)).slice(0, 8);
        if (my !== seq) return;
        box.innerHTML = savedHtml + (online.map(onlineBtn).join("") || `<div class="muted small">No online matches. Keep the name and fill in the tee details.</div>`);
      } catch (e) { if (my === seq) box.innerHTML = savedHtml + `<div class="muted small">Online search isn't answering. Try Near me, or type the details.</div>`; }
    }, 400);
  });

  $("#near", form).onclick = async () => {
    const my = ++seq;
    box.innerHTML = `<div class="muted small">Finding you…</div>`;
    let loc;
    try { loc = await myLocation(); } catch (e) { box.innerHTML = `<div class="muted small">${esc(e.message)}</div>`; return; }
    const savedNear = state.courses.filter(c => c.lat != null).map(c => ({ c, mi: miles(loc.lat, loc.lng, c.lat, c.lng) })).filter(x => x.mi < 30).sort((a, b) => a.mi - b.mi);
    const savedHtml = savedNear.slice(0, 6).map(x => savedBtn(x.c, x.mi)).join("");
    box.innerHTML = savedHtml + `<div class="muted small">Looking for courses nearby…</div>`;
    const [og, osm] = await Promise.all([ogNear(loc), osmNear(loc)]);
    if (my !== seq) return;
    const seen = new Set(savedNear.map(x => normName(x.c.name)));
    const list = [];
    for (const c of [...og, ...osm].sort((a, b) => a.mi - b.mi)) {
      const k = normName(c.name); if (!k || seen.has(k)) continue;
      seen.add(k); list.push(c);
    }
    box.innerHTML = savedHtml + (list.slice(0, 12).map(onlineBtn).join("") || (savedHtml ? "" : `<div class="muted small">Couldn't find courses nearby right now. Type the course name instead.</div>`));
  };

  box.addEventListener("click", async e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.saved) { const c = state.courses.find(c => c.id === b.dataset.saved); return fill({ ...c, pars: c.pars }); }
    if (b.dataset.tee) return fill(JSON.parse(decodeURIComponent(b.dataset.tee)));
    if (!b.dataset.pick) return;
    let c = JSON.parse(decodeURIComponent(b.dataset.pick));
    box.innerHTML = `<div class="muted small">Loading tees…</div>`;
    const base = { name: c.name, city: c.city, state: c.state, lat: c.lat, lng: c.lng };
    let id = c.id;
    if (!id) { // OpenStreetMap only: look for the same course in OpenGolfAPI
      try {
        const hits = await ogByName(c.name);
        const best = hits.find(h => normName(h.name) === normName(c.name) && (h.lat == null || miles(c.lat, c.lng, h.lat, h.lng) < 5));
        if (best) id = best.id;
      } catch (err) { /* fall through to manual */ }
    }
    if (!id) return fill(base);
    try {
      const d = await ogDetail(id);
      const one = { ...base, ogapi_id: id, par: d.par, pars: d.pars };
      if (!d.tees.length) return fill(one);
      box.innerHTML = `<div class="muted small">Pick your tees:</div>` + d.tees.map(t => {
        const v = { ...one, tee_name: t.name + (t.gender && !/^m/i.test(t.gender) ? ` (${t.gender[0]})` : ""), rating: t.rating, slope: t.slope, par: t.par || d.par };
        return `<button type="button" class="opt" data-tee="${encodeURIComponent(JSON.stringify(v))}"><b>${esc(v.tee_name)}</b> ${t.yards ? t.yards + " yds · " : ""}${t.rating}/${t.slope}${v.par ? " · par " + v.par : ""}</button>`;
      }).join("") + `<button type="button" class="opt" data-tee="${encodeURIComponent(JSON.stringify(one))}"><b>Other tees</b> <span class="muted">type them in</span></button>`;
    } catch (err) { fill(base); }
  });
}

function readCourse(f) {
  let pars = null; try { pars = f.pars.value ? JSON.parse(f.pars.value) : null; } catch (e) { /* ignore */ }
  return { course_name: f.course_name.value.trim(), tee_name: f.tee_name.value.trim() || null,
    rating: f.rating.value ? Number(f.rating.value) : null, slope: f.slope.value ? Number(f.slope.value) : null,
    par: f.par.value ? Number(f.par.value) : null, ogapi_id: f.ogapi_id.value || null, city: f.city.value || null, state: f.state.value || null,
    lat: f.lat.value ? Number(f.lat.value) : null, lng: f.lng.value ? Number(f.lng.value) : null, pars };
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
        if (!DEMO) await rpc("gt_set_start", { slug, v });
        if (v == null) delete state.start[slug]; else state.start[slug] = v;
        closeModal(); await refresh(); toast("Saved.");
      } catch (err) { toast("Couldn't save: " + errMsg(err)); }
    };
  });
}

// ---------- live scorecard ----------
// A card is saved hole by hole while you play. Each phone only writes the
// players it changed, so two people can keep score on the same card.
const cardById = id => state.cards.find(c => c.id === id);
const holeVals = (card, s) => { const a = card.scores?.[s] || []; return card.pars.map((_, i) => a[i] ?? null); };
function cardTotals(card, s) {
  const v = holeVals(card, s); let gross = 0, par = 0, thru = 0;
  v.forEach((x, i) => { if (x != null) { gross += x; par += card.pars[i]; thru++; } });
  return { gross, toPar: gross - par, thru, done: thru === card.pars.length };
}
const fmtToPar = d => d === 0 ? "E" : d > 0 ? "+" + d : String(d);
function liveStrip() {
  if (!state.cards.length) return "";
  return state.cards.map(c => {
    const lead = c.players.map(s => ({ s, t: cardTotals(c, s) })).filter(x => x.t.thru).sort((a, b) => a.t.toPar - b.t.toPar)[0];
    const thru = Math.max(0, ...c.players.map(s => cardTotals(c, s).thru));
    return `<a class="live" href="#card/${c.id}"><span class="pulse"></span><span class="lt"><b>Live</b> · ${esc(c.course_name)}<span class="ls">${thru ? `thru ${thru}` : "not started"}${lead ? ` · ${esc(pname(lead.s))} ${fmtToPar(lead.t.toPar)}` : ""}</span></span><span class="go">Open ›</span></a>`;
  }).join("");
}

const pending = {}; // cardId -> Set of player slugs (or "__pars") waiting to save
let saveTimer = null, pollTimer = null;
function setSaveState(txt, cls = "") { const el = $("#savestate"); if (el) { el.textContent = txt; el.className = "savestate " + cls; } }
function queueSave(card, slug) {
  (pending[card.id] ||= new Set()).add(slug);
  try { localStorage.setItem("golf_card_" + card.id, JSON.stringify({ scores: card.scores, pars: card.pars })); } catch (e) { /* full */ }
  setSaveState("Saving…");
  clearTimeout(saveTimer); saveTimer = setTimeout(flushSaves, 500);
}
async function flushSaves() {
  for (const id of Object.keys(pending)) {
    const card = cardById(id); const set = pending[id];
    if (!card || !set.size) continue;
    try {
      for (const s of [...set]) {
        if (DEMO) { set.delete(s); continue; }
        const parsOnly = s === "__pars";
        const { error } = await sb.rpc("gt_card_score", { p: state.phrase || "", cid: id, slug: parsOnly ? null : s, vals: parsOnly ? null : holeVals(card, s), pars: card.pars });
        if (error) throw error;
        set.delete(s);
      }
      if (!set.size) { delete pending[id]; localStorage.removeItem("golf_card_" + id); }
      setSaveState("Saved ✓", "ok");
    } catch (e) {
      if (/security phrase/i.test(e.message || "")) { lock(true); return; }
      setSaveState("No signal. Scores are kept on this phone and will save.", "warn");
      clearTimeout(saveTimer); saveTimer = setTimeout(flushSaves, 8000);
      return;
    }
  }
}
// Pull the latest card from the server but keep anything this phone hasn't saved yet.
async function pullCard(id) {
  if (DEMO) return;
  const { data } = await sb.from("cards").select("*").eq("id", id).maybeSingle();
  if (!data) return;
  const mine = pending[id] || new Set();
  const local = cardById(id);
  if (local) {
    for (const s of mine) if (s !== "__pars") data.scores[s] = local.scores[s];
    if (mine.has("__pars")) data.pars = local.pars;
    Object.assign(local, data);
  } else if (data.status === "live") state.cards.push(data);
}

function viewCard(id) {
  const card = cardById(id);
  if (!card) return `<section class="card"><a href="#h2h" class="back">‹ Back</a><div class="empty">This scorecard is finished or was deleted.</div></section>`;
  const n = card.pars.length;
  const hole = Math.min(n - 1, Math.max(0, Number(localStorage.getItem("golf_hole_" + id) ?? firstOpenHole(card))));
  const ed = editing();
  const board = card.players.map(s => ({ s, t: cardTotals(card, s) })).sort((a, b) => (b.t.thru ? 1 : 0) - (a.t.thru ? 1 : 0) || a.t.toPar - b.t.toPar);

  const entry = ed ? `<section class="card hole">
      <div class="hhead">
        <button class="nav" data-act="hole" data-v="${hole - 1}" ${hole === 0 ? "disabled" : ""} aria-label="Previous hole">‹</button>
        <div class="hnum"><div class="hn">Hole ${hole + 1}</div><button class="parbtn" data-act="par" data-v="${hole}">Par ${card.pars[hole]} <span class="muted">change</span></button></div>
        <button class="nav" data-act="hole" data-v="${hole + 1}" ${hole === n - 1 ? "disabled" : ""} aria-label="Next hole">›</button>
      </div>
      ${card.players.map(s => {
        const v = holeVals(card, s)[hole]; const t = cardTotals(card, s);
        return `<div class="prow">
          <div class="pn">${dot(s)}${esc(pname(s))}<div class="ps">${t.thru ? `${t.gross} · ${fmtToPar(t.toPar)} thru ${t.thru}` : "no score yet"}</div></div>
          <button class="step" data-act="sc" data-s="${s}" data-d="-1" aria-label="${esc(pname(s))} one less">−</button>
          <button class="val ${v == null ? "empty" : scoreCls(v, card.pars[hole])}" data-act="sc" data-s="${s}" data-d="0" aria-label="${esc(pname(s))} score">${v ?? card.pars[hole]}</button>
          <button class="step" data-act="sc" data-s="${s}" data-d="1" aria-label="${esc(pname(s))} one more">+</button>
        </div>`;
      }).join("")}
      <div class="hfoot"><span id="savestate" class="savestate"></span>${hole < n - 1 ? `<button class="primary" data-act="hole" data-v="${hole + 1}">Next hole ›</button>` : `<button class="primary" data-act="finish" data-id="${id}">Finish round</button>`}</div>
      <p class="hint">Tap the number to give par. Use − and + for anything else.</p>
    </section>` : `<p class="hint">Scores update by themselves. Tap Enter scores up top to keep score.</p>`;

  const grid = half => {
    const idx = half === 0 ? [...Array(Math.min(9, n)).keys()] : [...Array(n - 9).keys()].map(i => i + 9);
    if (!idx.length) return "";
    const sum = arr => arr.reduce((a, b) => a + b, 0);
    return `<table class="sc"><thead><tr><th>${half === 0 ? "Out" : "In"}</th>${idx.map(i => `<th class="${ed && i === hole ? "cur" : ""}" ${ed ? `data-act="hole" data-v="${i}"` : ""}>${i + 1}</th>`).join("")}<th>Tot</th></tr>
      <tr class="par"><td>Par</td>${idx.map(i => `<td>${card.pars[i]}</td>`).join("")}<td>${sum(idx.map(i => card.pars[i]))}</td></tr></thead>
      <tbody>${card.players.map(s => { const v = holeVals(card, s); const got = idx.filter(i => v[i] != null);
        return `<tr><td>${dot(s)}${esc(pname(s).slice(0, 5))}</td>${idx.map(i => `<td><span class="${v[i] == null ? "" : scoreCls(v[i], card.pars[i])}">${v[i] ?? ""}</span></td>`).join("")}<td><b>${got.length ? sum(got.map(i => v[i])) : ""}</b></td></tr>`; }).join("")}</tbody></table>`;
  };

  return `<a href="#h2h" class="back">‹ Back</a>
  <section class="card cardtop">
    <div class="ct"><span class="pulse"></span>Live scorecard</div>
    <div class="cc">${esc(card.course_name)}${card.tee_name ? `<span class="tee">${esc(card.tee_name)}</span>` : ""}</div>
    <div class="muted small">${fmtDate(card.played_on)} · ${n} holes${card.match_id ? " · match" : ""}</div>
    <div class="board">${board.map((x, i) => `<div class="br"><span>${x.t.thru && i === 0 ? "🥇 " : ""}${dot(x.s)}${esc(pname(x.s))}</span><span class="n">${x.t.thru ? `<b>${fmtToPar(x.t.toPar)}</b> <span class="muted">${x.t.gross} · thru ${x.t.thru}</span>` : `<span class="muted">–</span>`}</span></div>`).join("")}</div>
  </section>
  ${entry}
  <section class="card"><h3>Scorecard</h3>${grid(0)}${grid(1)}
    <div class="legend2"><span><i class="sc-b"></i>birdie or better</span><span><i class="sc-o"></i>bogey or worse</span></div></section>
  <div class="ed acts"><button class="link" data-act="card-del" data-id="${id}">Delete this scorecard</button></div>`;
}
const scoreCls = (v, par) => v < par - 1 ? "sc-e" : v === par - 1 ? "sc-b" : v === par ? "sc-p" : v === par + 1 ? "sc-o" : "sc-d";
function firstOpenHole(card) {
  const n = card.pars.length;
  for (let i = 0; i < n; i++) if (card.players.some(s => holeVals(card, s)[i] == null)) return i;
  return n - 1;
}

function cardAction(act, b) {
  const id = state.cardId; const card = cardById(id); if (!card) return;
  if (act === "hole") { localStorage.setItem("golf_hole_" + id, b.dataset.v); render(); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
  if (!editing()) return phraseForm();
  if (act === "sc") {
    const s = b.dataset.s, d = Number(b.dataset.d);
    const hole = Number(localStorage.getItem("golf_hole_" + id) ?? firstOpenHole(card));
    const arr = holeVals(card, s); const par = card.pars[hole];
    let v = arr[hole];
    if (d === 0) v = v == null ? par : v; else v = Math.min(15, Math.max(1, (v ?? par) + d));
    arr[hole] = v; card.scores = { ...card.scores, [s]: arr };
    render(); queueSave(card, s);
  }
  if (act === "par") {
    const h = Number(b.dataset.v); const p = card.pars[h];
    card.pars = card.pars.map((x, i) => i === h ? (p >= 5 ? 3 : p + 1) : x);
    render(); queueSave(card, "__pars");
  }
}

function cardForm(fromMatch) {
  if (!editing()) return phraseForm(() => cardForm(fromMatch));
  const todays = state.matches.filter(m => m.status === "scheduled" && Math.abs(daysBetween(today(), m.scheduled_for)) <= 1);
  const m0 = fromMatch || (todays.length === 1 ? todays[0] : null);
  const v = m0 ? { ...m0, ...(state.courses.find(c => c.id === m0.course_id) || {}), course_name: m0.course_name } : {};
  openModal(`<h2>Start a scorecard</h2>
    <form id="cf">
      ${todays.length || fromMatch ? `<label>Match<select name="match"><option value="">Not a match</option>${[...new Set([...(fromMatch ? [fromMatch] : []), ...todays])].map(m => `<option value="${m.id}" ${m0 && m.id === m0.id ? "selected" : ""}>${fmtShort(m.scheduled_for)} · ${esc(m.course_name || "match")} · ${m.players.map(pname).join(", ")}</option>`).join("")}</select></label>` : ""}
      <fieldset><legend>Who's playing</legend>${PLAYERS.map(p => `<label class="chk"><input type="checkbox" name="pl" value="${p.slug}" ${(m0 ? m0.players : PLAYERS.map(x => x.slug)).includes(p.slug) ? "checked" : ""}> ${dot(p.slug)}${esc(p.name)}</label>`).join("")}</fieldset>
      <div class="row2"><label>Date<input type="date" name="played_on" value="${today()}" required></label>
      <label>Holes<select name="holes"><option>18</option><option>9</option></select></label></div>
      ${courseFields(v)}
      <div class="acts"><button class="primary" type="submit">Start</button></div>
    </form>`, m => {
    const f = $("#cf", m); wireCoursePicker(f);
    if (f.match) f.match.onchange = () => {
      const mt = state.matches.find(x => x.id === f.match.value); if (!mt) return;
      f.querySelectorAll("[name=pl]").forEach(x => x.checked = mt.players.includes(x.value));
      if (mt.course_name) { const c = state.courses.find(c => c.id === mt.course_id) || mt;
        f.course_name.value = mt.course_name; f.tee_name.value = mt.tee_name || ""; f.rating.value = mt.rating ?? ""; f.slope.value = mt.slope ?? ""; f.par.value = mt.par ?? "";
        f.pars.value = c.pars ? JSON.stringify(c.pars) : ""; }
    };
    f.onsubmit = async e => {
      e.preventDefault();
      const c = readCourse(f); const n = Number(f.holes.value);
      const players = [...f.querySelectorAll("[name=pl]:checked")].map(x => x.value);
      if (!players.length) return toast("Pick who's playing.");
      if (!c.course_name) return toast("Pick or type the course.");
      let pars = c.pars?.length === 18 ? (n === 9 ? c.pars.slice(0, 9) : c.pars) : c.pars?.length === 9 && n === 9 ? c.pars : Array(n).fill(4);
      const btn = f.querySelector("[type=submit]"); btn.disabled = true;
      try {
        const course_id = c.rating && c.slope && c.par ? await ensureCourse({ ...c, name: c.course_name }) : null;
        const row = { played_on: f.played_on.value, course_id, course_name: c.course_name, tee_name: c.tee_name, rating: c.rating, slope: c.slope,
          par: c.par, pars, players, scores: {}, match_id: f.match?.value || null, status: "live" };
        const id = await save("cards", row);
        localStorage.setItem("golf_hole_" + id, "0");
        closeModal(); await loadData(); location.hash = "card/" + id;
        if (!c.pars?.length) toast("Hole pars start at 4. Tap Par to change a hole.");
      } catch (err) { btn.disabled = false; toast("Couldn't start: " + errMsg(err)); }
    };
  });
}

function finishForm(id) {
  const card = cardById(id); if (!card) return;
  const n = card.pars.length; const parSum = card.pars.reduce((a, b) => a + b, 0);
  const rows = card.players.map(s => ({ s, t: cardTotals(card, s) }));
  openModal(`<h2>Finish round</h2><p class="hint">${esc(card.course_name)} · ${fmtDate(card.played_on)}</p>
    <form id="ff">
      ${courseFields({ ...card, par: n === 18 ? parSum : card.par || parSum })}
      <div class="board">${rows.map(x => `<div class="br"><span>${dot(x.s)}${esc(pname(x.s))}</span><span class="n">${x.t.done ? `<b>${x.t.gross}</b> ${fmtToPar(x.t.toPar)}` : `<span class="warnt">${x.t.thru}/${n} holes, won't be posted</span>`}</span></div>`).join("")}</div>
      <p class="hint">Each finished score goes on that player's round log${card.match_id ? " and the match gets its result" : ""}.${n === 9 ? " 9-hole rounds don't count toward handicaps." : ""}</p>
      <div class="acts"><button class="primary" type="submit">Post scores</button><button type="button" data-close>Keep playing</button></div>
    </form>`, m => {
    const f = $("#ff", m); wireCoursePicker(f);
    f.onsubmit = async e => {
      e.preventDefault();
      const c = readCourse(f);
      if (!c.rating || !c.slope || !c.par) return toast("Rating, slope, and par are needed for handicaps.");
      const done = rows.filter(x => x.t.done);
      if (!done.length) return toast("Nobody has all holes scored yet.");
      const btn = f.querySelector("[type=submit]"); btn.disabled = true;
      try {
        await flushSaves();
        const course_id = await ensureCourse({ ...c, name: c.course_name, pars: n === 18 ? card.pars : null });
        for (const x of done) {
          await save("rounds", { player: x.s, played_on: card.played_on, holes: n, score: x.t.gross, hole_scores: holeVals(card, x.s),
            course_name: c.course_name, tee_name: c.tee_name, rating: c.rating, slope: c.slope, par: c.par, course_id, match_id: card.match_id || null });
        }
        if (card.match_id && done.length >= 2) await save("matches", { status: "final", course_name: c.course_name, tee_name: c.tee_name, rating: c.rating, slope: c.slope, par: c.par, course_id }, card.match_id);
        await save("cards", { status: "done" }, id);
        closeModal(); await loadData(); location.hash = "h2h"; toast("Round posted.");
      } catch (err) { btn.disabled = false; toast("Couldn't post: " + errMsg(err)); }
    };
  });
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (document.hidden || !$("#modal").hidden) return;
    if (state.tab === "card") { await pullCard(state.cardId).catch(() => {}); render(); }
    else if (!DEMO) { await loadData().catch(() => {}); render(); }
  }, state.tab === "card" ? 15000 : 60000);
}

function addMenu() {
  openModal(`<h2>Add</h2><div class="acts col"><button class="primary" data-go="card">Start a live scorecard</button><button data-go="round">Post a final score</button><button data-go="match">Schedule a match</button></div>`, m => {
    m.querySelector("[data-go=card]").onclick = () => cardForm();
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
  if (h.startsWith("card/")) { state.tab = "card"; state.cardId = h.slice(5); }
  else state.tab = P[h] || h === "h2h" ? h : "h2h";
  render();
  startPolling();
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
  if (act === "start-card") cardForm(state.matches.find(m => m.id === id));
  if (act === "finish") finishForm(id);
  if (act === "card-del") { if (confirm("Delete this scorecard? Scores on it are lost.")) remove("cards", id).then(async () => { await loadData(); location.hash = "h2h"; toast("Deleted."); }).catch(err => toast(errMsg(err))); }
  if (["hole", "sc", "par"].includes(act)) cardAction(act, b);
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
    sb = createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  $("#authbtn").onclick = () => {
    if (editing()) { lock(); toast("Locked on this phone."); }
    else phraseForm();
  };
  $("#fab").onclick = addMenu;
  window.addEventListener("hashchange", route);
  let rz = null, lastW = innerWidth;
  window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (Math.abs(innerWidth - lastW) > 40) { lastW = innerWidth; render(); } }, 250); });
  await loadData().catch(e => toast("Couldn't load data: " + errMsg(e)));
  // Scores typed with no signal are kept on the phone; send them now.
  for (const c of state.cards) {
    try { const saved = JSON.parse(localStorage.getItem("golf_card_" + c.id) || "null");
      if (saved && editing()) { c.scores = { ...c.scores, ...saved.scores }; c.pars = saved.pars || c.pars; Object.keys(saved.scores || {}).forEach(s => queueSave(c, s)); queueSave(c, "__pars"); } } catch (e) { /* ignore */ }
  }
  route();
})();
