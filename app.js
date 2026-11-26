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
const state = { rounds: [], guestRounds: [], guests: [], matches: [], courses: [], cards: [], start: {}, phrase: localStorage.getItem("golf_phrase"), tab: null, cardId: null };

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
// Guests: saved in the "guests" table, on a card as "g_" + their id. They score on the live card and show
// on scorecards, but stay out of head to head, Master Champ, handicaps and money totals.
const isGuest = s => typeof s === "string" && s.startsWith("g_");
const GUESTS = {}; // slug -> { name, hcp }
const GUEST_COLOR = "#8a8f98";
const guestName = g => [g.first_name, g.last_name].filter(Boolean).join(" ");
const noteGuests = map => { for (const [s, g] of Object.entries(map || {})) if (isGuest(s) && g?.name) GUESTS[s] = { ...GUESTS[s], ...g }; };
const pcolor = slug => P[slug]?.color || GUEST_COLOR;
const dot = slug => `<span class="dot${isGuest(slug) ? " gdot" : ""}" style="background:${pcolor(slug)}"></span>`;
const pname = slug => P[slug]?.name || GUESTS[slug]?.name || (isGuest(slug) ? "Guest" : slug);
// Guests on a card: card.scores.__meta.guests = { slug: { name, hcp, money } }. Every guest plays the
// game on the card (strokes, holes, skins); only guests with "In the money" ticked are in the bets.
const cardGuests = card => card?.scores?.__meta?.guests || {};
const inMoney = (card, s) => !isGuest(s) || !!cardGuests(card)[s]?.money;
const bettors = card => card.players.filter(s => inMoney(card, s));
// Solo rounds: one player, started from their tab (card.scores.__meta.solo). A posted round counts as solo
// when it has no match and nobody else (family or guest) posted a round that day at that course and tee.
// Solo rounds count toward the handicap like any round; head to head, Master Champ and money only read matches.
const cardSolo = card => card?.scores?.__meta?.solo ? card.players[0] : null;
const roundKey = r => `${r.played_on}|${r.course_name}|${r.tee_name || ""}`;
const isSoloRound = r => !r.match_id && ![...state.rounds, ...state.guestRounds].some(x => x.id !== r.id && roundKey(x) === roundKey(r));

// ---------- handicap math (USGA Rules of Handicapping 5.1 / 5.2) ----------
const diffOf = r => r1((113 / r.slope) * (r.score - r.rating));
const countsForIndex = r => r.holes === 18 && r.rating && r.slope && r.score;
// Moving handicap: starts at the player's starting handicap and moves after every
// 18-hole round, a set share of the way toward that round's score differential
// (differential = (score - course rating) x 113 / slope). Good rounds pull it down,
// bad rounds push it up. Unofficial: this is not the USGA best-8-of-20 index.
const STEP = CFG.handicapStep ?? 0.25;
function effIndex(rounds, slug) {
  const elig = rounds.filter(countsForIndex).sort(byDate);
  const start = state.start[slug] ?? null;
  let idx = start, last = null;
  const after = {};
  for (const r of elig) {
    const d = diffOf(r);
    const prev = idx;
    idx = idx == null ? d : idx + STEP * (d - idx);
    idx = Math.max(-10, Math.min(54, idx));
    after[r.id] = r1(idx);
    last = prev == null ? null : r1(idx) - r1(prev);
  }
  return { index: idx == null ? null : r1(idx), count: elig.length, starting: elig.length === 0 && start != null, last: last == null ? null : r1(last), after, start };
}
const playerRounds = slug => state.rounds.filter(r => r.player === slug).sort(byDate);
const currentIndex = slug => isGuest(slug)
  ? { index: GUESTS[slug]?.hcp ?? null, count: 0, starting: false, last: null, after: {}, start: null }
  : effIndex(playerRounds(slug), slug);
const courseHcp = (idx, c) => idx == null ? null : Math.round(idx * (c.slope / 113) + (c.rating - c.par));

function indexHistory(slug) {
  const rs = playerRounds(slug).filter(countsForIndex);
  if (!rs.length) return [];
  const h = effIndex(rs, slug);
  const startDay = new Date(parseDate(rs[0].played_on).getTime() - 7 * 864e5).toISOString().slice(0, 10);
  const out = h.start != null ? [{ x: startDay, y: h.start }] : [];
  for (const r of rs) out.push({ x: r.played_on, y: h.after[r.id] });
  return out;
}

// ---------- hole-by-hole scoring: strokes, Stableford, match play ----------
// Stroke index = hole handicap ranking (1 = hardest). If a course has none saved,
// the usual fallback is used: odd numbers on the front nine, even on the back.
function strokeIndex(pars, sis) {
  const n = pars.length;
  if (sis?.length === n && sis.every(x => x >= 1 && x <= n)) return sis;
  if (n === 18) return pars.map((_, i) => i < 9 ? 2 * i + 1 : 2 * (i - 9) + 2);
  return pars.map((_, i) => i + 1);
}
// Strokes a player gets on a hole from a course handicap (plus handicaps give strokes back).
function strokesOn(ch, si, n) {
  if (!ch) return 0;
  if (ch > 0) return Math.floor(ch / n) + (si <= ch % n ? 1 : 0);
  const p = -ch; return -(Math.floor(p / n) + (si > n - (p % n) ? 1 : 0));
}
// Course handicap for this round (9-hole rounds get half).
function roundCh(idx, c, n) {
  if (idx == null || !c.rating || !c.slope || !c.par) return null;
  // A 9-hole round on an 18-hole course keeps the 18-hole rating but has a 9-hole par: use the 18-hole par here.
  let par = c.par;
  if (n === 9 && c.rating >= 50 && c.par < 50) { const cp = state.courses.find(x => x.id === c.course_id)?.par; par = cp >= 50 ? cp : c.par * 2; }
  const full = courseHcp(idx, { ...c, par });
  return n === 9 ? Math.round(full / 2) : full;
}
// Stableford: net double bogey or worse 0, net bogey 1, net par 2, net birdie 3, net eagle 4...
// Group strokes: the lowest course handicap in the group plays at zero; everyone
// else gets the difference, on the hardest holes. Used for match play and Stableford.
function groupPops(chs, pars, sis) {
  const n = pars.length, si = strokeIndex(pars, sis), vals = Object.values(chs).map(x => x ?? 0);
  const low = Math.min(...vals);
  return Object.fromEntries(Object.entries(chs).map(([s, ch]) => [s, pars.map((_, i) => vals.length > 1 ? strokesOn((ch ?? 0) - low, si[i], n) : 0)]));
}
function stableford(vals, pars, sis, ch, pops) {
  const si = strokeIndex(pars, sis); let pts = 0; const per = [];
  vals.forEach((v, i) => {
    if (v == null) { per.push(null); return; }
    const p = Math.max(0, 2 + pars[i] - (v - (pops ? pops[i] : strokesOn(ch ?? 0, si[i], pars.length))));
    per.push(p); pts += p;
  });
  return { pts, per };
}
// Match play between two players. With group strokes (pa/pb) each player's net is
// gross minus their group strokes; otherwise strokes off the lower of the two.
function matchPlay(a, b, va, vb, cha, chb, pars, sis, pa, pb) {
  const n = pars.length, si = strokeIndex(pars, sis);
  const diff = pa && pb ? pa.reduce((x, y) => x + y, 0) - pb.reduce((x, y) => x + y, 0) : (cha ?? 0) - (chb ?? 0);
  let up = 0, thru = 0, closed = null; const res = [];
  for (let i = 0; i < n; i++) {
    if (va[i] == null || vb[i] == null) { res.push(null); continue; }
    const na = va[i] - (pa ? pa[i] : diff > 0 ? strokesOn(diff, si[i], n) : 0);
    const nb = vb[i] - (pb ? pb[i] : diff < 0 ? strokesOn(-diff, si[i], n) : 0);
    const r = na < nb ? 1 : nb < na ? -1 : 0;
    res.push(r); thru++;
    if (closed == null) { up += r; const left = n - (i + 1); if (Math.abs(up) > left) closed = { up, left }; }
  }
  const lead = up > 0 ? a : up < 0 ? b : null;
  const left = n - thru;
  let text, winner = null, done = false;
  if (closed && closed.left > 0) { winner = closed.up > 0 ? a : b; done = true; text = `${pname(winner)} wins ${Math.abs(closed.up)}&${closed.left}`; }
  else if (thru === n) { done = true; winner = lead; text = lead ? `${pname(lead)} wins ${Math.abs(up)} up` : "Halved"; }
  else if (!thru) text = "Not started";
  else if (!lead) text = `All square thru ${thru}`;
  else text = `${pname(lead)} ${Math.abs(up)} up${Math.abs(up) === left ? " (dormie)" : ""} thru ${thru}`;
  return { a, b, up, thru, done, winner, text, strokes: Math.abs(diff), getter: diff > 0 ? a : diff < 0 ? b : null, res };
}
const pairsOf = players => { const out = []; for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) out.push([players[i], players[j]]); return out; };
const SCORING_LABEL = { match: "match play", stroke: "stroke play", gross: "stroke play", net: "net", skins: "skins", stableford: "stableford" };
const GAME_OPTIONS = [
  ["match", "Match play"],
  ["stroke", "Stroke play (gross)"],
  ["net", "Net stroke play"],
  ["skins", "Skins"],
  ["stableford", "Stableford"]
];
const dbScoring = gm => (gm === "stroke" || gm === "gross") ? "gross" : gm === "match" ? "match" : "net";
const gameSelectHtml = cur => `<label class="gpick"><span class="laylbl">Game &amp; scoring</span><select name="game">${GAME_OPTIONS.map(([v, l]) => `<option value="${v}" ${(cur === v || (cur === "gross" && v === "stroke")) ? "selected" : ""}>${l}</option>`).join("")}</select></label>`;

// ---------- matches, head to head, master champ ----------
function evalMatch(m) {
  const rs = state.rounds.filter(r => r.match_id === m.id);
  if (m.status !== "final" || rs.length < 2) return null;
  const rows = rs.map(r => {
    const prior = state.rounds.filter(x => x.player === r.player && x.match_id !== m.id && x.played_on <= m.scheduled_for);
    const idx = effIndex(prior, r.player).index;
    const ch = roundCh(idx, r, r.holes);
    const net = m.scoring === "gross" ? r.score : r.score - (ch ?? 0);
    return { player: r.player, gross: r.score, idx, ch, net, noHcp: idx == null, points: r.points, holes: r.hole_scores, r };
  }).sort((a, b) => a.net - b.net);
  // Match play needs hole-by-hole scores from everyone; otherwise fall back to net totals.
  if (m.scoring === "match" && rows.every(x => x.holes?.length)) {
    const c = state.courses.find(c => c.id === m.course_id) || {};
    const pars = c.pars?.length === rows[0].holes.length ? c.pars : rows[0].holes.map(() => 4);
    const n = pars.length;
    const gp = groupPops(Object.fromEntries(rows.map(x => [x.player, roundCh(x.idx, x.r, n)])), pars, c.sis);
    const pairs = pairsOf(rows.map(x => x.player)).map(([a, b]) => {
      const A = rows.find(x => x.player === a), B = rows.find(x => x.player === b);
      return matchPlay(a, b, A.holes, B.holes, roundCh(A.idx, A.r, n), roundCh(B.idx, B.r, n), pars, c.sis, gp[a], gp[b]);
    });
    const wins = Object.fromEntries(rows.map(x => [x.player, pairs.filter(p => p.winner === x.player).length]));
    const top = Math.max(...Object.values(wins));
    const winners = top ? rows.filter(x => wins[x.player] === top).map(x => x.player) : rows.map(x => x.player);
    const outright = rows.find(x => wins[x.player] === rows.length - 1)?.player || null;
    rows.sort((a, b) => wins[b.player] - wins[a.player] || (b.points ?? 0) - (a.points ?? 0));
    return { rows, winners, outright, pairs, wins };
  }
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
      const pr = ev.pairs?.find(p => (p.a === R.a && p.b === R.b) || (p.a === R.b && p.b === R.a));
      const w = pr ? pr.winner : A.net < B.net ? R.a : B.net < A.net ? R.b : null;
      if (w === R.a) { R.aw++; res = R.a; } else if (w === R.b) { R.bw++; res = R.b; } else R.t++;
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
const isTitle = m => !!m.title_match && PLAYERS.every(p => m.players.includes(p.slug));
function championship() {
  let holder = null, since = null, defenses = 0;
  const reigns = [];
  for (const m of state.matches.filter(m => m.status === "final" && isTitle(m)).sort(byDate)) {
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
    if (state._demoLoaded) { splitGuests(); return; }
    state._demoLoaded = true;
    const d = JSON.parse(JSON.stringify(window.GOLF_DEMO));
    Object.assign(state, d);
    state.cards = state.cards || [];
    state.guests = state.guests || [];
    splitGuests();
    stampUpd();
    return;
  }
  const [r, m, c, pl, cd, gs] = await Promise.all([
    sb.from("rounds").select("*").order("played_on"),
    sb.from("matches").select("*").order("scheduled_for"),
    sb.from("courses").select("*").order("name"),
    sb.from("players").select("*"),
    sb.from("cards").select("*").eq("status", "live").order("created_at"),
    sb.from("guests").select("*"),
    loadPhotos().catch(() => {})
  ]);
  for (const x of [r, m, c]) if (x.error) throw x.error;
  state.start = Object.fromEntries((pl.data || []).filter(x => x.starting_index != null).map(x => [x.slug, Number(x.starting_index)]));
  state.guestRounds = [];
  state.rounds = r.data.map(x => ({ ...x, rating: Number(x.rating), slope: Number(x.slope), par: Number(x.par) }));
  state.matches = m.data.map(x => ({ ...x, rating: x.rating == null ? null : Number(x.rating), slope: x.slope == null ? null : Number(x.slope), par: x.par == null ? null : Number(x.par) }));
  state.courses = c.data.map(x => ({ ...x, rating: Number(x.rating), slope: Number(x.slope), par: Number(x.par) }));
  state.cards = (cd.data || []).map(x => ({ ...x, rating: x.rating == null ? null : Number(x.rating) }));
  state.guests = gs.error ? [] : (gs.data || []).map(x => ({ ...x, handicap: x.handicap == null ? null : Number(x.handicap) }));
  splitGuests();
  stampUpd();
}
// Guest rounds live in the same table (player "g_<id>") but never count in stats: keep them apart.
// Names come from the saved guest, else the name saved with the card, round or money result.
function splitGuests() {
  const all = [...state.rounds, ...state.guestRounds];
  state.rounds = all.filter(r => !isGuest(r.player));
  state.guestRounds = all.filter(r => isGuest(r.player));
  for (const r of state.guestRounds) { const m = /^Guest: (.+)$/.exec(r.notes || ""); if (m && !GUESTS[r.player]) GUESTS[r.player] = { name: m[1] }; }
  for (const m of state.matches) noteGuests(m.bets?.result?.guests);
  for (const c of state.cards) noteGuests(cardGuests(c));
  for (const g of state.guests) GUESTS["g_" + g.id] = { name: guestName(g), hcp: g.handicap };
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
  if (c.sis?.length) extra.sis = c.sis;
  if (c.lat != null) { extra.lat = c.lat; extra.lng = c.lng; }
  if (hit) {
    const upd = { ...extra };
    if (hit.rating !== c.rating || hit.slope !== c.slope || hit.par !== c.par) Object.assign(upd, { rating: c.rating, slope: c.slope, par: c.par });
    if (hit.pars?.length && upd.pars) delete upd.pars;
    if (hit.sis?.length && upd.sis) delete upd.sis;
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
  document.documentElement.classList.add("locked");
  $("#gmsg").textContent = wrong ? "The phrase changed. Enter the new one." : "";
  render();
}
// The whole site sits behind the family phrase (checked by the database). Once in, this phone can view and score.
async function unlock(p) {
  let ok = true;
  if (!DEMO) { const r = await sb.rpc("gt_check", { p }); if (r.error) throw r.error; ok = r.data; }
  if (!ok) return false;
  state.phrase = p; localStorage.setItem("golf_phrase", p);
  const root = document.documentElement;
  root.classList.add("unlocking");
  root.classList.remove("locked");
  render();
  setTimeout(() => root.classList.remove("unlocking"), 760);
  return true;
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
  if (pts.length < 2) return `<div class="empty">The chart shows up after the first 18-hole round.</div>`;
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
function renderTabs() {
  const live = state.cards.length ? `<a href="#live" data-tab="card" class="livetab"><span class="pulse"></span>Live</a>` : "";
  const html = live + `<a href="#h2h" data-tab="h2h">Head to Head</a>` + PLAYERS.map(p => `<a href="#${p.slug}" data-tab="${p.slug}">${dot(p.slug)}${esc(p.name)}</a>`).join("") + `<a href="#gallery" data-tab="gallery">Gallery</a>`;
  const el = $(".tabs"); if (el.innerHTML !== html) el.innerHTML = html;
}
function render() {
  // A live card that was ended or deleted (often on another phone) can't be shown, and the
  // full-screen Live view hides the header and + button, so fall back instead of stranding the page.
  if (state.tab === "card" && !cardById(state.cardId)) {
    if (state.cards.length) state.cardId = state.cards[0].id;
    else {
      state.tab = "h2h";
      history.replaceState(null, "", "#h2h");
      toast("That round isn't live anymore.");
      startPolling();
    }
  }
  const tab = state.tab;
  if (!tab) return;
  renderTabs();
  document.body.dataset.tab = tab; // style.css hides the crest on the Live and Gallery tabs
  document.querySelectorAll(".tabs a").forEach(a => a.classList.toggle("on", a.dataset.tab === tab));
  const main = $("#main");
  main.innerHTML = tab === "card" ? viewCard(state.cardId) : tab === "gallery" ? viewGallery() : liveStrip() + (tab === "h2h" ? viewH2H() : viewPlayer(tab));
  wireCharts(main);
  document.body.classList.toggle("editing", editing());
  document.body.classList.toggle("oncard", tab === "card");
  ydSync();
  satPaint();
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
  const ptsR = full.filter(r => r.points != null);
  const ch = championship();
  const champ = ch.holder === slug ? `<span class="belt">🏆 Master Champ</span>` : "";
  const idxSub = hc.index == null ? "posts after the first round" : hc.count === 0 ? "starting · moves every round" : hc.last == null ? `${hc.count} round${hc.count === 1 ? "" : "s"}` : `${hc.last > 0 ? "▲ " + hc.last.toFixed(1) : hc.last < 0 ? "▼ " + Math.abs(hc.last).toFixed(1) : "no change"} last round`;

  const byCourse = {};
  for (const r of full) {
    const k = r.course_name + (r.tee_name ? ` (${r.tee_name})` : "");
    (byCourse[k] ||= { name: k, n: 0, best: null, sum: 0 });
    const b = byCourse[k]; b.n++; b.sum += r.score; if (!b.best || r.score < b.best.score) b.best = r;
  }
  const courseRows = Object.values(byCourse).sort((a, b) => b.n - a.n).map(b =>
    `<tr><td>${esc(b.name)}</td><td class="n">${b.n}</td><td class="n"><b>${b.best.score}</b></td><td class="n">${r1(b.sum / b.n)}</td></tr>`).join("");

  const logRows = [...rs].reverse().map(r => {
    const m = r.match_id ? state.matches.find(x => x.id === r.match_id) : null;
    return `<tr>
      <td>${fmtShort(r.played_on)}<div class="yr">${r.played_on.slice(0, 4)}</div></td>
      <td>${esc(r.course_name)}${r.tee_name ? `<span class="tee">${esc(r.tee_name)}</span>` : ""}${m ? `<span class="tag">match</span>` : isSoloRound(r) ? `<span class="tag">solo</span>` : ""}${r.holes === 9 ? `<span class="tag">9 holes</span>` : ""}${r.hole_scores?.length ? `<button type="button" class="tag tagbtn" data-act="rsc" data-id="${r.id}">hole by hole ›</button>` : ""}${r.notes ? `<div class="note">${esc(r.notes)}</div>` : ""}</td>
      <td class="n"><b>${r.score}</b><div class="yr">${toPar(r.score, r.par)}${r.points != null ? ` · ${r.points} pts` : ""}</div></td>
      <td class="n">${countsForIndex(r) ? `${diffOf(r).toFixed(1)}<div class="yr">hcp ${fmtIdx(hc.after[r.id])}</div>` : "–"}</td>
      <td class="ed"><button class="link" data-act="edit-round" data-id="${r.id}">Edit</button></td></tr>`;
  }).join("");

  return `
  <section class="hero" style="--pc:${p.color}">
    <div class="hname">${dot(slug)} ${esc(p.name)} ${champ}</div>
    <div class="hidx"><span class="big">${fmtIdx(hc.index)}</span><span class="hl">${hc.starting ? "starting handicap" : "handicap"}</span>
      <button class="link ed" data-act="edit-start" data-id="${slug}">Edit starting</button></div>
  </section>
  ${state.cards.some(c => c.players.includes(slug)) ? "" : `<div class="acts solostart"><button class="primary" data-act="solo-start" data-id="${slug}">⛳ Start a solo round</button></div>`}
  <div class="tiles">
    ${statTile("Index", fmtIdx(hc.index), idxSub)}
    ${statTile("Best round", best ? best.score : "–", best ? `${toPar(best.score, best.par)} · ${esc(best.course_name)}` : "")}
    ${statTile("Avg (last 10)", avg ?? "–", `${full.length} full rounds`)}
    ${statTile("Match record", `${rec.w}-${rec.l}${rec.t ? "-" + rec.t : ""}`, "W-L-T vs both")}
    ${statTile("Stableford best", ptsR.length ? Math.max(...ptsR.map(r => r.points)) : "–", ptsR.length ? `avg ${r1(ptsR.reduce((a, r) => a + r.points, 0) / ptsR.length)} · last ${ptsR[ptsR.length - 1].points}` : "from live scorecards")}
    ${(() => { const L = moneyLedger(); const v = L.net[slug] ?? 0; return statTile("Money", `<span class="${moneyCls(v)}">${moneySigned(v)}</span>`, L.games ? "all time" : "no bets yet"); })()}
  </div>
  <section class="card"><h3>Handicap over time</h3>${lineChart([{ name: p.name, color: p.color, points: indexHistory(slug) }])}</section>
  <section class="card"><h3>Courses</h3>${courseRows ? `<table class="t"><thead><tr><th>Course</th><th class="n">Rds</th><th class="n">Best</th><th class="n">Avg</th></tr></thead><tbody>${courseRows}</tbody></table>` : `<div class="empty">No rounds yet.</div>`}</section>
  ${roundScorecardsSection(slug)}
  <section class="card"><h3>Round log</h3>
    <p class="hint">Diff = how the round played against the course (score minus rating, adjusted for slope). After every 18-hole round the handicap moves ${Math.round(STEP * 100)}% of the way toward it.</p>
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

  const L = moneyLedger();
  const moneyCard = L.games ? `<section class="card"><h3>Money <span class="muted small">all time · ${L.games} round${L.games === 1 ? "" : "s"}</span></h3>
    <div class="tiles three mtiles">${PLAYERS.map(p => `<div class="tile" style="border-top:3px solid ${p.color}"><div class="tl">${esc(p.name)}</div><div class="tv ${moneyCls(L.net[p.slug])}">${moneySigned(L.net[p.slug])}</div></div>`).join("")}</div>
    <div class="mpl">${Object.entries(L.pair).filter(([, v]) => v).map(([k, v]) => { const [s1, s2] = k.split("|"), up = v > 0 ? s1 : s2, dn = up === s1 ? s2 : s1;
      return `<div class="mpr"><span>${dot(up)}${esc(pname(up))} is up on ${esc(pname(dn))}</span><b>${money(Math.abs(v))}</b></div>`; }).join("") || `<div class="muted small">Everyone's even.</div>`}</div></section>` : "";

  const upcoming = state.matches.filter(m => m.status === "scheduled").sort(byDate);
  const upRows = upcoming.map(m => {
    const d = daysBetween(today(), m.scheduled_for);
    const live = cardForMatch(m.id);
    const when = live ? "in progress" : d > 1 ? (d < 7 ? dayName(m.scheduled_for) : `in ${d} days`) : d === 1 ? "tomorrow" : d === 0 ? "today" : "needs results";
    const hasCourse = m.rating && m.slope && m.par;
    return `<div class="match ${d < 0 ? "due" : ""}">
      <div class="mh"><b>${fmtDate(m.scheduled_for)}</b>${m.tee_time ? ` · ${esc(m.tee_time)}` : ""}<span class="when">${when}</span></div>
      <div class="mc">${esc(m.course_name || "Course TBD")}${m.tee_name ? `<span class="tee">${esc(m.tee_name)}</span>` : ""}${isTitle(m) ? `<span class="tag gold">🏆 title match</span>` : ""}<span class="tag">${SCORING_LABEL[m.scoring] || m.scoring}</span></div>
      <div class="mp">${m.players.map(s => `<span>${dot(s)}${esc(pname(s))}</span>`).join(" vs ")}</div>
      ${hasCourse && m.scoring !== "gross" ? strokesLine(m, m.players) : ""}
      ${m.notes ? `<div class="note">${esc(m.notes)}</div>` : ""}
      ${m.bets && !live ? `<div class="note">Bets ${stakesText(m.bets, 18)}</div>` : ""}
      ${live ? `<div class="acts"><a class="btnlink" href="#card/${live.id}">Open scorecard ›</a></div>` : `<div class="ed acts"><button class="primary" data-act="start-match" data-id="${m.id}">Start match</button><button data-act="results" data-id="${m.id}">Post results</button><button class="link" data-act="edit-match" data-id="${m.id}">Edit</button></div>`}
    </div>`;
  }).join("");

  const past = state.matches.filter(m => m.status === "final").sort(byDate).reverse();
  const pastRows = past.map(m => {
    const ev = evalMatch(m);
    if (!ev) return "";
    return `<div class="match">
      <div class="mh"><b>${fmtDate(m.scheduled_for)}</b> · ${esc(m.course_name)}${isTitle(m) ? `<span class="tag gold">🏆</span>` : ""}<span class="tag">${SCORING_LABEL[m.scoring] || m.scoring}</span></div>
      ${(() => { const showNet = m.scoring !== "gross" && !ev.pairs, showPts = ev.rows.some(r => r.points != null);
        return `<table class="t res"><thead><tr><th></th><th class="n">Gross</th>${showNet ? `<th class="n">Hcp</th><th class="n">Net</th>` : ""}${showPts ? `<th class="n">Pts</th>` : ""}</tr></thead><tbody>
      ${ev.rows.map(r => `<tr class="${ev.winners.includes(r.player) ? "win" : ""}"><td>${dot(r.player)}${esc(pname(r.player))}${ev.winners.includes(r.player) ? (ev.outright ? " 🏅" : " (tie)") : ""}</td><td class="n">${r.gross}</td>${showNet ? `<td class="n">${r.noHcp ? "–" : r.ch}</td><td class="n"><b>${r.net}</b></td>` : ""}${showPts ? `<td class="n">${r.points ?? "–"}</td>` : ""}</tr>`).join("")}
      </tbody></table>${ev.pairs ? `<div class="mpl">${ev.pairs.map(pr => `<div class="mpr"><span>${esc(pname(pr.a))} v ${esc(pname(pr.b))}</span><b>${esc(pr.text)}</b></div>`).join("")}</div>` : ""}`; })()}
      ${m.bets?.result ? `<div class="cbets"><span>Money</span><b>${m.bets.result.pays.length ? paysText(m.bets.result.pays, true) : "Nobody paid"}</b></div>${m.bets.note ? `<div class="note">${esc(m.bets.note)}</div>` : ""}` : ""}
      <div class="ed acts"><button class="link" data-act="edit-match" data-id="${m.id}">Edit</button><button class="link" data-act="results" data-id="${m.id}">Edit scores</button>${m.players.length > 1 ? `<button class="link" data-act="money" data-id="${m.id}">Money</button>` : ""}</div>
    </div>`;
  }).join("");

  const savedCourses = state.courses.filter(c => c.rating && c.slope && c.par);
  const calc = savedCourses.length ? `<section class="card"><h3>Strokes calculator</h3>
    <select id="calcCourse">${savedCourses.map(c => `<option value="${c.id}">${esc(c.name)}${c.tee_name ? " · " + esc(c.tee_name) : ""}</option>`).join("")}</select>
    <div id="calcOut">${strokesLine(savedCourses[0], PLAYERS.map(p => p.slug))}</div>
    <p class="hint">Course handicap = index × slope ÷ 113 + (rating − par).</p></section>` : "";

  return `${champCard}
  <section class="card"><h3>Upcoming rounds</h3>${upRows || `<div class="empty">Nothing scheduled.</div>`}
    <button class="primary ed" data-act="new-match">+ Schedule a round</button></section>
  <div class="tiles three">${idxCards}</div>
  ${moneyCard}
  <section class="card"><h3>Handicap race</h3>${lineChart(PLAYERS.map(p => ({ name: p.name, color: p.color, points: indexHistory(p.slug) })))}</section>
  <section class="card"><h3>Head to head</h3><p class="hint">Every final match counts, scored the way it was set up (net or gross).</p>${recs}</section>
  ${calc}
  <section class="card"><h3>Results</h3>${pastRows || `<div class="empty">No results yet.</div>`}</section>
  ${roundScorecardsSection()}
  ${guestsSection()}`;
}

// ---------- gallery ----------
// Photos live in the public "photos" storage bucket. Anyone with the family phrase
// can add: the "gallery" edge function checks the phrase and hands out signed
// upload slots. Photos are shrunk on the phone first (full 1600px + 480px thumb).
const photoUrl = path => DEMO ? path : `${CFG.supabaseUrl}/storage/v1/object/public/photos/${path}`;
async function loadPhotos() {
  if (DEMO) { state.photos = state.photos || []; return; }
  const { data, error } = await sb.from("photos").select("*").order("taken_on", { ascending: false }).order("created_at", { ascending: false });
  if (error) throw error;
  state.photos = data || [];
}
async function galleryFn(body) {
  const res = await timed(`${CFG.supabaseUrl}/functions/v1/gallery`, { method: "POST",
    headers: { "Content-Type": "application/json", apikey: CFG.supabaseAnonKey },
    body: JSON.stringify({ p: state.phrase || "", ...body }) }, 20000);
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { if (res.status === 403) lock(true); throw new Error(out.error || "Gallery is down right now."); }
  return out;
}
// Shrink to fit max px on the long side, JPEG.
async function shrink(file, max, q) {
  let img;
  try { img = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch (e) { img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("Couldn't read that photo.")); i.src = URL.createObjectURL(file); }); }
  const w = img.width, h = img.height, k = Math.min(1, max / Math.max(w, h));
  const cv = document.createElement("canvas"); cv.width = Math.round(w * k); cv.height = Math.round(h * k);
  cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
  const blob = await new Promise(ok => cv.toBlob(ok, "image/jpeg", q));
  if (!blob) throw new Error("Couldn't read that photo.");
  return { blob, w: cv.width, h: cv.height };
}
const fileDay = f => { const d = f.lastModified ? new Date(f.lastModified) : new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
function photoForm(matchId) {
  if (!editing()) return phraseForm(() => photoForm(matchId));
  const recent = state.matches.filter(m => daysBetween(m.scheduled_for, today()) >= 0).sort(byDate).reverse().slice(0, 12);
  openModal(`<h2>Add photos</h2>
    <form id="phf">
      <label class="pickbtn">Choose photos<input type="file" name="files" accept="image/*" multiple></label>
      <div id="phprev" class="phprev"></div>
      ${photoCourseField(matchId ? state.matches.find(x => x.id === matchId)?.course_name : "")}
      <label>Round (optional)<select name="match"><option value="">None</option>${recent.map(m => `<option value="${m.id}" ${m.id === matchId ? "selected" : ""}>${fmtShort(m.scheduled_for)} · ${esc(splitName(m.course_name || "").base || "round")}</option>`).join("")}</select></label>
      <p class="hint">Up to 20 at a time. Photos are shrunk before upload, so it's quick on data.</p>
      <div class="acts"><button class="primary" type="submit" disabled>Upload</button></div>
    </form>`, m => {
    const f = $("#phf", m), btn = f.querySelector("[type=submit]");
    wirePhotoCourse(f);
    f.files.onchange = () => {
      const list = [...f.files.files].slice(0, 20);
      $("#phprev", m).innerHTML = list.map(x => `<img src="${URL.createObjectURL(x)}" alt="">`).join("");
      btn.disabled = !list.length; btn.textContent = list.length > 1 ? `Upload ${list.length} photos` : "Upload";
    };
    f.onsubmit = async e => {
      e.preventDefault();
      const list = [...f.files.files].slice(0, 20); if (!list.length) return;
      btn.disabled = true;
      const match_id = f.match.value || null, course_name = f.course.value.trim() || null;
      const mt = state.matches.find(x => x.id === match_id);
      let done = 0;
      try {
        const { slots } = DEMO ? { slots: list.map(() => ({})) } : await galleryFn({ action: "upload", count: list.length });
        for (let i = 0; i < list.length; i++) {
          btn.textContent = `Uploading ${i + 1} of ${list.length}…`;
          const full = await shrink(list[i], 1600, 0.82), th = await shrink(list[i], 480, 0.75);
          const s = slots[i];
          let row;
          if (DEMO) row = { path: URL.createObjectURL(full.blob), thumb: URL.createObjectURL(th.blob) };
          else {
            const a = await sb.storage.from("photos").uploadToSignedUrl(s.path, s.token, full.blob, { contentType: "image/jpeg" });
            if (a.error) throw a.error;
            const b = await sb.storage.from("photos").uploadToSignedUrl(s.thumb, s.thumbToken, th.blob, { contentType: "image/jpeg" });
            if (b.error) throw b.error;
            row = { path: s.path, thumb: s.thumb };
          }
          await save("photos", { ...row, match_id, course_name, taken_on: mt ? mt.scheduled_for : fileDay(list[i]), width: full.w, height: full.h });
          done++;
        }
        closeModal(); await loadPhotos(); if (state.tab === "gallery") render(); else location.hash = "gallery";
        toast(done === 1 ? "Photo added." : `${done} photos added.`);
      } catch (err) {
        btn.disabled = false; btn.textContent = "Try again";
        toast((done ? `${done} uploaded, then: ` : "Couldn't upload: ") + errMsg(err));
        if (done) loadPhotos().catch(() => {});
      }
    };
  });
}
// Short course name for labels: the course inside a club, or the club without "Golf Course" etc.
const courseTag = n => { const s = splitName(n || ""); return s.layout || s.base.replace(/\s+(golf\s+(course|club|links)|country club|golf)$/i, "").trim() || s.base; };
function viewGallery() {
  const all = state.photos || [];
  // Course chips: every course with photos, most photos first; tap one to see just those.
  const counts = {}; all.forEach(p => { const c = photoCourse(p); if (c) counts[c] = (counts[c] || 0) + 1; });
  const tags = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  if (viewGallery.course && !counts[viewGallery.course]) viewGallery.course = null;
  const ph = viewGallery.course ? all.filter(p => photoCourse(p) === viewGallery.course) : all;
  const months = {};
  for (const p of ph) (months[p.taken_on.slice(0, 7)] ||= []).push(p);
  const mName = k => parseDate(k + "-01").toLocaleDateString("en-US", { month: "long", year: "numeric" });
  return `<section class="card gallery">
    <div class="ghead"><h3>Gallery</h3><button class="primary ed" data-act="add-photo">+ Add photos</button></div>
    ${tags.length ? `<div class="gcourses"><button class="${viewGallery.course ? "" : "on"}" data-act="gcourse" data-v="">All <span>${all.length}</span></button>${tags.map(t => `<button class="${viewGallery.course === t ? "on" : ""}" data-act="gcourse" data-v="${esc(t)}">⛳ ${esc(courseTag(t))} <span>${counts[t]}</span></button>`).join("")}</div>` : ""}
    ${ph.length ? Object.entries(months).map(([k, list]) => `<div class="gmonth">${mName(k)}</div>
      <div class="ggrid">${list.map(p => { const c = photoCourse(p); return `<button class="gph" data-act="photo" data-id="${p.id}" aria-label="${esc(c ? courseTag(c) : "Photo")}"><img src="${esc(photoUrl(p.thumb || p.path))}" loading="lazy" alt="">${c ? `<span class="gtag">${esc(courseTag(c))}</span>` : ""}</button>`; }).join("")}</div>`).join("")
      : `<div class="empty">No photos yet.</div>`}
    <p class="hint ed">Anyone with the family phrase can add photos. Tap a photo, then Add the course, to tag where it was.</p>
  </section>`;
}
// Course on a photo: tap a saved course, search any course (saved + OpenGolfAPI + OpenStreetMap), or "Near me".
const courseNames = () => {
  const n = {}; state.rounds.forEach(r => { if (r.course_name) n[r.course_name] = (n[r.course_name] || 0) + 1; });
  return [...new Set(state.courses.map(c => c.name))].sort((a, b) => (n[b] || 0) - (n[a] || 0) || a.localeCompare(b));
};
const courseLabel = n => { const s = splitName(n); return s.layout ? `${s.layout} · ${s.base}` : s.base; };
const photoCourse = p => p.course_name || (p.match_id && state.matches.find(m => m.id === p.match_id)?.course_name) || "";
const US_STATES = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming" };
const NOMI = "https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&";
const tidyName = n => n.replace(/\b([A-Z])([A-Z]+)([a-z]+)/g, (m, a, b, c) => a + b.toLowerCase() + c); // "Country HIlls" -> "Country Hills"
const nomPlace = a => ({ city: a?.city || a?.town || a?.village || a?.hamlet || a?.county || "", state: a?.state || "" });
function photoCourseField(v) {
  let town = {}; try { town = JSON.parse(localStorage.getItem("golf_town") || "{}"); } catch (e) { /* ignore */ }
  const st = town.st || "TN";
  return `<div class="pcpick"><div class="altl">Course</div><input type="hidden" name="course" value="${esc(v || "")}">
    <div class="pcsel"></div>
    <div class="chips pcchips">${courseNames().slice(0, 8).map(n => `<button type="button" data-pc="${esc(n)}">${esc(courseLabel(n))}</button>`).join("")}<button type="button" class="pcnear">📍 Near me</button></div>
    <div class="pctown"><input class="pctownin" placeholder="Town, e.g. Hendersonville" autocomplete="off" autocapitalize="words" spellcheck="false" value="${esc(town.city || "")}">
      <select class="pcst" aria-label="State">${Object.keys(US_STATES).map(k => `<option ${k === st ? "selected" : ""}>${k}</option>`).join("")}</select>
      <button type="button" class="pcgo">Courses</button></div>
    <input class="pcsearch" type="search" placeholder="Or search a course name" autocomplete="off" autocapitalize="words" spellcheck="false">
    <div class="pcres"></div></div>`;
}
function wirePhotoCourse(f) {
  const box = $(".pcpick", f), hid = f.course, res = $(".pcres", box), q = $(".pcsearch", box);
  let manual = !!hid.value, timer = null, seq = 0;
  const paint = () => {
    $(".pcsel", box).innerHTML = hid.value ? `<span class="pcchip">⛳ ${esc(courseLabel(hid.value))}<button type="button" class="pcx" aria-label="Clear course">✕</button></span>` : `<span class="muted small">No course yet. Pick one below.</span>`;
    box.querySelectorAll("[data-pc]").forEach(b => b.classList.toggle("on", b.dataset.pc === hid.value));
    const x = $(".pcx", box); if (x) x.onclick = () => { hid.value = ""; manual = true; paint(); };
  };
  const pick = name => { hid.value = name; manual = true; res.innerHTML = ""; q.value = ""; paint(); };
  const rows = (list, note) => {
    res.innerHTML = (list.length ? list.map(c => `<button type="button" class="pcrow" data-name="${esc(c.name)}"><b>${esc(c.label || c.name)}</b><span>${esc([[c.city, c.state].filter(Boolean).join(", "), c.mi != null ? c.mi.toFixed(1) + " mi" : "", c.saved ? "saved" : ""].filter(Boolean).join(" · "))}</span></button>`).join("") : "") + (note ? `<div class="muted small pcnote">${esc(note)}</div>` : "");
    res.querySelectorAll(".pcrow").forEach(b => b.onclick = () => pick(b.dataset.name));
  };
  const dedupe = list => { const seen = new Set(); return list.filter(c => { const k = c.name.toLowerCase(); return !seen.has(k) && seen.add(k); }); };
  box.querySelectorAll("[data-pc]").forEach(b => b.onclick = () => pick(b.dataset.pc));
  // Name search: saved courses at once, then OpenStreetMap as soon as it answers (OpenGolfAPI joins if it's quick).
  q.oninput = () => {
    clearTimeout(timer); const term = q.value.trim(), my = ++seq;
    if (term.length < 2) { res.innerHTML = ""; return; }
    let list = courseNames().filter(n => n.toLowerCase().includes(term.toLowerCase())).map(n => ({ name: n, label: courseLabel(n), saved: true }));
    rows(list, "Searching…");
    timer = setTimeout(() => {
      let pending = 3;
      const add = more => { if (my !== seq) return; list = dedupe([...list, ...more]); pending--; rows(list.slice(0, 15), pending ? "Searching…" : list.length ? "" : "No courses found. Try the town and state above."); };
      const nom = qq => timed(NOMI + "limit=10&countrycodes=us&q=" + encodeURIComponent(qq), {}, 6000).then(r => r.json())
        .then(j => j.filter(e => e.type === "golf_course" && e.name).map(e => ({ name: tidyName(e.name), ...nomPlace(e.address) }))).catch(() => []);
      nom(term).then(add); nom(term + " golf").then(add);
      Promise.race([ogByName(term).catch(() => []), new Promise(r => setTimeout(() => r([]), 4000))]).then(og => add(og.map(c => ({ name: c.name, city: c.city, state: c.state }))));
    }, 300);
  };
  // Town + state: every golf course in and around that town (OpenStreetMap), A to Z.
  const town = async () => {
    const city = $(".pctownin", box).value.trim(), st = $(".pcst", box).value, my = ++seq;
    if (!city) { $(".pctownin", box).focus(); return; }
    try { localStorage.setItem("golf_town", JSON.stringify({ city, st })); } catch (e) { /* ignore */ }
    rows([], `Finding courses around ${city}, ${st}…`);
    try {
      const g = await (await timed(NOMI + "limit=1&countrycodes=us&city=" + encodeURIComponent(city) + "&state=" + encodeURIComponent(US_STATES[st]), {}, 7000)).json();
      if (my !== seq) return;
      if (!g.length) return rows([], `Couldn't find ${city}, ${st}. Check the spelling.`);
      const [s1, n1, w1, e1] = g[0].boundingbox.map(Number), pad = 0.08;
      const vb = `${w1 - pad},${n1 + pad},${e1 + pad},${s1 - pad}`;
      const near = async qq => (await (await timed(NOMI + `limit=50&bounded=1&viewbox=${vb}&q=` + encodeURIComponent(qq), {}, 8000)).json()).filter(e => e.type === "golf_course" && e.name);
      const [a, b] = await Promise.all([near("golf course"), near("country club").catch(() => [])]);
      if (my !== seq) return;
      const lat = Number(g[0].lat), lng = Number(g[0].lon);
      const saved = state.courses.filter(c => c.lat != null).map(c => ({ name: c.name, label: courseLabel(c.name), saved: true, mi: miles(lat, lng, c.lat, c.lng) })).filter(c => c.mi < 15);
      const list = dedupe([...saved, ...[...a, ...b].map(e => ({ name: tidyName(e.name), ...nomPlace(e.address), mi: miles(lat, lng, Number(e.lat), Number(e.lon)) }))]).sort((x, y) => x.mi - y.mi);
      rows(list.slice(0, 30), list.length ? "" : `No golf courses found around ${city}, ${st}.`);
    } catch (err) { if (my === seq) rows([], "Couldn't reach the course map. Try again."); }
  };
  $(".pcgo", box).onclick = town;
  $(".pctownin", box).onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); town(); } };
  $(".pcnear", box).onclick = async () => {
    const my = ++seq; rows([], "Finding courses near you…");
    try {
      const loc = await myLocation();
      const saved = state.courses.filter(c => c.lat != null).map(c => ({ name: c.name, label: courseLabel(c.name), saved: true, mi: miles(loc.lat, loc.lng, c.lat, c.lng) })).filter(c => c.mi < 30);
      const near = await nominatimNear(loc);
      if (my !== seq) return;
      const all = dedupe([...saved, ...near]).filter(c => c.mi < 30).sort((a, b) => a.mi - b.mi).slice(0, 15);
      rows(all, all.length ? "" : "No courses found near you.");
    } catch (err) { rows([], errMsg(err)); }
  };
  if (f.match) f.match.addEventListener("change", () => { const mt = state.matches.find(x => x.id === f.match.value); if (mt?.course_name && !manual) { hid.value = mt.course_name; paint(); } });
  paint();
}
function photoView(id, only = viewGallery.course) {
  const ph = (state.photos || []).filter(p => !only || photoCourse(p) === only), i = ph.findIndex(p => p.id === id); if (i < 0) return photoView(id, null);
  const p = ph[i], where = photoCourse(p);
  const newer = ph[i - 1]?.id, older = ph[i + 1]?.id;
  openModal(`<div class="lbox">
    <div class="lpic"><img src="${esc(photoUrl(p.path))}" alt="${esc(p.caption || where || "")}" draggable="false"><span class="lcount">${i + 1} / ${ph.length}</span></div>
    <div class="lwhere">${where ? `<span class="lcourse">⛳ ${esc(courseLabel(where))}</span>` : `<button class="lcourse add" id="phaddc">⛳ Add the course</button>`}<span class="ldate">${fmtDate(p.taken_on)}</span></div>
    ${p.caption ? `<div class="lcap">${esc(p.caption)}</div>` : ""}
    <div class="acts">${newer ? `<button data-pv="${newer}">‹ Newer</button>` : ""}${older ? `<button data-pv="${older}">Older ›</button>` : ""}
      <button id="phedit">Edit</button><button class="link" id="phdel">Delete</button></div>
    <p class="hint lswipe">Swipe for the next one.</p></div>`, m => {
    m.querySelectorAll("[data-pv]").forEach(b => b.onclick = () => photoView(b.dataset.pv));
    // Swipe left = older, right = newer (ignores mostly-vertical moves so the sheet still scrolls)
    const pic = $(".lpic", m); let x0 = null, y0 = 0;
    pic.addEventListener("touchstart", e => { if (e.touches.length === 1) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; } }, { passive: true });
    pic.addEventListener("touchend", e => {
      if (x0 == null) return; const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0; x0 = null;
      if (Math.abs(dx) < 45 || Math.abs(dy) > Math.abs(dx)) return;
      const to = dx < 0 ? older : newer; if (to) photoView(to);
    });
    m.onkeydown = e => { if (e.key === "ArrowLeft" && newer) photoView(newer); if (e.key === "ArrowRight" && older) photoView(older); };
    $("#phedit", m).onclick = () => photoEdit(id);
    const addc = $("#phaddc", m); if (addc) addc.onclick = () => photoEdit(id);
    $("#phdel", m).onclick = async () => {
      if (!editing()) return phraseForm(() => photoView(id));
      if (!confirm("Delete this photo for everyone?")) return;
      try { if (DEMO) state.photos = ph.filter(x => x.id !== id); else { await galleryFn({ action: "delete", id }); await loadPhotos(); }
        closeModal(); render(); toast("Deleted."); } catch (err) { toast("Couldn't delete: " + errMsg(err)); }
    };
  });
}
// Edit course and round on a photo already in the gallery. "Save & next" walks to the next older photo.
function photoEdit(id) {
  if (!editing()) return phraseForm(() => photoEdit(id));
  const ph = state.photos || [], i = ph.findIndex(p => p.id === id); if (i < 0) return;
  const p = ph[i], older = ph[i + 1]?.id;
  const rounds = state.matches.filter(m => daysBetween(m.scheduled_for, today()) >= 0).sort(byDate).reverse().slice(0, 30);
  openModal(`<h2>Where was this?</h2>
    <form id="pef">
      <img class="peimg" src="${esc(photoUrl(p.thumb || p.path))}" alt="">
      ${photoCourseField(p.course_name || "")}
      <label>Round (optional)<select name="match"><option value="">None</option>${rounds.map(m => `<option value="${m.id}" ${m.id === p.match_id ? "selected" : ""}>${fmtShort(m.scheduled_for)} · ${esc(splitName(m.course_name || "").base || "round")}</option>`).join("")}</select></label>
      <p class="hint">${fmtDate(p.taken_on)} · ${i + 1} of ${ph.length}</p>
      <div class="acts"><button class="primary" type="submit">Save</button>${older ? `<button type="button" id="penext">Save & next ›</button>` : ""}<button type="button" data-back>Back</button></div>
    </form>`, m => {
    const f = $("#pef", m); wirePhotoCourse(f);
    m.querySelector("[data-back]").onclick = () => photoView(id);
    const go = async next => {
      const mt = state.matches.find(x => x.id === f.match.value);
      const row = { course_name: f.course.value.trim() || null, match_id: f.match.value || null };
      if (mt && mt.id !== p.match_id) row.taken_on = mt.scheduled_for;
      m.querySelectorAll("button").forEach(b => b.disabled = true);
      try {
        await save("photos", row, id);
        if (DEMO) Object.assign(p, row); else await loadPhotos();
        if (state.tab === "gallery") render();
        next ? photoEdit(next) : photoView(id);
        toast("Saved.");
      } catch (err) { m.querySelectorAll("button").forEach(b => b.disabled = false); toast("Couldn't save: " + errMsg(err)); }
    };
    f.onsubmit = e => { e.preventDefault(); go(null); };
    const nx = $("#penext", m); if (nx) nx.onclick = () => go(older);
  });
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
const normName = s => String(s || "").toLowerCase().replace(/golf|country|club|course|links|municipal|the|&|and|[^a-z0-9]/g, "");
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
const box25 = ({ lat, lng }) => { const dy = 0.36, dx = 0.36 / Math.cos(lat * Math.PI / 180); return { s: lat - dy, n: lat + dy, w: lng - dx, e: lng + dx }; };
// Fast: OpenStreetMap name search inside a ~25 mile box.
async function nominatimNear(loc) {
  const b = box25(loc);
  try {
    const r = await timed(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=40&bounded=1&viewbox=${b.w},${b.n},${b.e},${b.s}&q=golf`, {}, 8000);
    const j = await r.json();
    return j.filter(e => e.type === "golf_course" && e.name).map(e => ({ src: "osm", name: e.name, city: "", state: "", lat: Number(e.lat), lng: Number(e.lon), mi: miles(loc.lat, loc.lng, Number(e.lat), Number(e.lon)) }));
  } catch (e) { return []; }
}
// Slower but catches courses without "golf" in the name (country clubs).
async function osmNear(loc) {
  const b = box25(loc), bb = `${b.s},${b.w},${b.n},${b.e}`;
  const q = `[out:json][timeout:12];(way["leisure"="golf_course"]["name"](${bb});relation["leisure"="golf_course"]["name"](${bb}););out center tags;`;
  for (const host of OVERPASS.slice(0, 2)) {
    try {
      const r = await timed(host, { method: "POST", body: new URLSearchParams({ data: q }) }, 14000);
      if (!r.ok) continue;
      const j = await r.json();
      return j.elements.map(e => {
        const la = e.center?.lat ?? e.lat, lo = e.center?.lon ?? e.lon;
        return { src: "osm", name: e.tags.name, city: e.tags["addr:city"] || "", state: e.tags["addr:state"] || "", lat: la, lng: lo, mi: miles(loc.lat, loc.lng, la, lo) };
      });
    } catch (e) { /* try next mirror */ }
  }
  return [];
}
async function ogByName(term) {
  const r = await timed(`${OGAPI}/v1/courses/search?q=${encodeURIComponent(term)}&limit=10`, {}, 7000);
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

// Clubs with more than one course: stored as "Club Name (Course Name)".
const splitName = n => { const m = /^(.*\S) \(([^()]+)\)$/.exec(String(n || "")); return m ? { base: m[1], layout: m[2] } : { base: String(n || ""), layout: "" }; };
const joinName = (base, layout) => layout ? `${base} (${layout})` : base;
const sameBase = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
function layoutsFor(base) {
  if (!base.trim()) return [];
  return [...new Set(state.courses.map(c => splitName(c.name)).filter(x => x.layout && sameBase(x.base, base)).map(x => x.layout))].sort();
}
// Default course at a club: config.js defaultCourses, else the one you play most.
function defaultLayout(base) {
  const map = CFG.defaultCourses || {};
  const k = Object.keys(map).find(x => sameBase(x, base));
  if (k) return map[k];
  const counts = {};
  for (const r of [...state.rounds, ...state.matches]) { const nm = splitName(r.course_name); if (nm.layout && sameBase(nm.base, base)) counts[nm.layout] = (counts[nm.layout] || 0) + 1; }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}
function renderLayouts(form) {
  const box = $("#lay", form); if (!box) return;
  const base = form.course_name.value;
  const def = defaultLayout(base);
  const known = layoutsFor(base).sort((a, b) => (b === def) - (a === def));
  // Pick the club's usual course once when the club is chosen; the user can still tap another.
  const key = base.trim().toLowerCase();
  if (!form.layout.value.trim() && form.dataset.layOther !== "1" && def && known.includes(def) && form.dataset.autoLay !== key) {
    form.dataset.autoLay = key; form.layout.value = def;
    if (form._showTees && !form.rating.value) setTimeout(() => form._showTees(joinName(base.trim(), def)), 0);
  }
  const cur = form.layout.value.trim();
  const showInput = form.dataset.layOther === "1" || (cur && !known.includes(cur));
  if (!base.trim()) { box.innerHTML = ""; form.layout.hidden = true; return; }
  form.layout.hidden = !showInput;
  box.innerHTML = known.length
    ? `<div class="laylbl">Which course?</div><div class="chips">${known.map(l => `<button type="button" class="chip ${l === cur ? "on" : ""}" data-lay="${esc(l)}">${esc(l)}</button>`).join("")}<button type="button" class="chip ${showInput ? "on" : ""}" data-lay="__other">Another one</button></div>`
    : `<button type="button" class="link" data-lay="__other">${showInput ? "Course name at this club:" : "More than one course here?"}</button>`;
}
function wireLayouts(form, showTees) {
  form._showTees = showTees;
  $("#lay", form).addEventListener("click", e => {
    const b = e.target.closest("[data-lay]"); if (!b) return;
    if (b.dataset.lay === "__other") { form.dataset.layOther = "1"; form.layout.value = ""; renderLayouts(form); form.layout.focus(); return; }
    form.dataset.layOther = ""; form.layout.value = b.dataset.lay; renderLayouts(form);
    showTees(joinName(form.course_name.value.trim(), b.dataset.lay));
  });
  let t = null;
  form.course_name.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { form.dataset.layOther = ""; form.layout.value = ""; renderLayouts(form); }, 250); });
  renderLayouts(form);
}

function courseFields(v = {}) {
  const nm = splitName(v.course_name || v.name || "");
  return `<label>Course<input name="course_name" id="cq" autocomplete="off" value="${esc(nm.base)}" placeholder="Type a name, or use Near me"></label>
  <div id="lay" class="lay"></div><input name="layout" class="layin" value="${esc(nm.layout)}" placeholder="e.g. President's Reserve" hidden>
  <button type="button" class="near" id="near">📍 Courses near me</button>
  <div id="cres" class="cres"></div>
  <div class="row4">
    <label>Tee<input name="tee_name" value="${esc(v.tee_name || "")}"></label>
    <label>Rating<input name="rating" inputmode="decimal" value="${v.rating ?? ""}"></label>
    <label>Slope<input name="slope" inputmode="numeric" value="${v.slope ?? ""}"></label>
    <label>Par<input name="par" inputmode="numeric" value="${v.par ?? ""}"></label>
  </div>
  <input type="hidden" name="ogapi_id" value="${esc(v.ogapi_id || "")}"><input type="hidden" name="city"><input type="hidden" name="state">
  <input type="hidden" name="lat" value="${v.lat ?? ""}"><input type="hidden" name="lng" value="${v.lng ?? ""}"><input type="hidden" name="pars" value="${esc(v.pars ? JSON.stringify(v.pars) : "")}"><input type="hidden" name="sis" value="${esc(v.sis ? JSON.stringify(v.sis) : "")}">
  <p class="hint">Rating and slope are printed on the scorecard next to each tee. You only type them once per course.</p>`;
}

function wireCoursePicker(form) {
  const q = $("#cq", form), box = $("#cres", form);
  let timer = null, seq = 0;
  const fill = c => {
    const nm = splitName(c.name); form.course_name.value = nm.base; form.layout.value = nm.layout; form.dataset.layOther = "";
    form.tee_name.value = c.tee_name || "";
    form.rating.value = c.rating ?? ""; form.slope.value = c.slope ?? ""; form.par.value = c.par ?? "";
    form.ogapi_id.value = c.ogapi_id || ""; form.city.value = c.city || ""; form.state.value = c.state || "";
    form.lat.value = c.lat ?? ""; form.lng.value = c.lng ?? ""; form.pars.value = c.pars?.length ? JSON.stringify(c.pars) : ""; form.sis.value = c.sis?.length ? JSON.stringify(c.sis) : "";
    box.innerHTML = ""; renderLayouts(form);
    form.dispatchEvent(new CustomEvent("coursepicked", { detail: c }));
    if (!nm.layout && !c.rating && layoutsFor(nm.base).length) { toast(form.layout.value ? `${form.layout.value}. Pick your tees.` : "Pick which course at this club."); return; }
    if ((!c.rating || !c.slope) && !layoutsFor(nm.base).length) { toast("Add the tee, rating, and slope from the scorecard."); setTimeout(() => (c.tee_name ? form.rating : form.tee_name).focus(), 50); }
  };
  const savedBtn = (c, mi, teeOnly) => `<button type="button" class="opt" data-saved="${c.id}"><b>${teeOnly ? esc(c.tee_name || "Tees") : esc(c.name)}</b> ${!teeOnly && c.tee_name ? esc(c.tee_name) + " · " : ""}${c.rating}/${c.slope} · par ${c.par}${mi != null ? ` · ${mi.toFixed(1)} mi` : ""}<span class="tag">saved</span></button>`;
  const onlineBtn = c => `<button type="button" class="opt" data-pick="${encodeURIComponent(JSON.stringify(c))}"><b>${esc(c.name)}</b> <span class="muted">${esc([c.city, c.state].filter(Boolean).join(", "))}${c.mi != null ? ` · ${c.mi.toFixed(1)} mi` : ""}</span></button>`;

  wireLayouts(form, full => {
    const rows = state.courses.filter(c => sameBase(c.name, full)).sort((x, y) => y.rating - x.rating);
    box.innerHTML = rows.length ? `<div class="muted small">Pick your tees:</div>` + rows.map(c => savedBtn(c, null, true)).join("") : "";
  });
  q.addEventListener("input", () => {
    clearTimeout(timer);
    const term = q.value.trim().toLowerCase();
    form.ogapi_id.value = ""; form.lat.value = ""; form.lng.value = ""; form.pars.value = ""; form.sis.value = "";
    if (term.length < 3) { box.innerHTML = ""; return; }
    if (layoutsFor(q.value.trim()).length) { seq++; box.innerHTML = ""; return; } // a known club: its courses and tees show instead
    const names = [...new Set(state.courses.filter(c => c.name.toLowerCase().includes(term)).map(c => c.name))].slice(0, 6);
    const savedHtml = names.map(n => { const k = state.courses.filter(c => c.name === n).length;
      return `<button type="button" class="opt" data-savedname="${esc(n)}"><b>${esc(n)}</b> <span class="muted">${k} tee${k === 1 ? "" : "s"}</span><span class="tag">saved</span></button>`; }).join("");
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
    const seen = new Set(savedNear.map(x => normName(x.c.name)));
    const found = [];
    const show = done => {
      if (my !== seq) return;
      const list = found.filter(c => c.mi < 30).sort((a, b) => a.mi - b.mi).slice(0, 12);
      box.innerHTML = savedHtml + list.map(onlineBtn).join("") + (done ? (list.length || savedHtml ? "" : `<div class="muted small">Couldn't find courses nearby right now. Type the course name instead.</div>`) : `<div class="muted small">Looking for more…</div>`);
    };
    const add = arr => { for (const c of arr) { const k = normName(c.name); if (!k || seen.has(k)) continue; seen.add(k); found.push(c); } };
    const quick = nominatimNear(loc).then(arr => { add(arr); show(false); });
    const slow = osmNear(loc).then(add);
    await Promise.allSettled([quick, slow]);
    show(true);
  };

  box.addEventListener("click", async e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.saved) { const c = state.courses.find(c => c.id === b.dataset.saved); return fill({ ...c }); }
    if (b.dataset.savedname) {
      const rows = state.courses.filter(c => c.name === b.dataset.savedname);
      if (rows.length === 1) return fill({ ...rows[0] });
      const nm = splitName(b.dataset.savedname); form.course_name.value = nm.base; form.layout.value = nm.layout; renderLayouts(form);
      box.innerHTML = `<div class="muted small">Pick your tees:</div>` + rows.sort((x, y) => y.rating - x.rating).map(c => savedBtn(c, null, true)).join("");
      return;
    }
    if (b.dataset.tee) return fill(JSON.parse(decodeURIComponent(b.dataset.tee)));
    if (!b.dataset.pick) return;
    let c = JSON.parse(decodeURIComponent(b.dataset.pick));
    box.innerHTML = `<div class="muted small">Checking for tee ratings…</div>`;
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
        return `<button type="button" class="opt" data-tee="${encodeURIComponent(JSON.stringify(v))}"><b>${esc(v.tee_name)}</b> ${t.yards ? esc(t.yards) + " yds · " : ""}${t.rating}/${t.slope}${v.par ? " · par " + v.par : ""}</button>`;
      }).join("") + `<button type="button" class="opt" data-tee="${encodeURIComponent(JSON.stringify(one))}"><b>Other tees</b> <span class="muted">type them in</span></button>`;
    } catch (err) { fill(base); }
  });
}

function readCourse(f) {
  let pars = null, sis = null; try { pars = f.pars.value ? JSON.parse(f.pars.value) : null; sis = f.sis.value ? JSON.parse(f.sis.value) : null; } catch (e) { /* ignore */ }
  return { course_name: joinName(f.course_name.value.trim(), f.layout.value.trim()), tee_name: f.tee_name.value.trim() || null,
    rating: f.rating.value ? Number(f.rating.value) : null, slope: f.slope.value ? Number(f.slope.value) : null,
    par: f.par.value ? Number(f.par.value) : null, ogapi_id: f.ogapi_id.value || null, city: f.city.value || null, state: f.state.value || null,
    lat: f.lat.value ? Number(f.lat.value) : null, lng: f.lng.value ? Number(f.lng.value) : null, pars, sis };
}

function roundForm(r) {
  const editing = !!r;
  r = r || { player: localStorage.getItem("golf_me") || (state.tab !== "h2h" ? state.tab : PLAYERS[0].slug), played_on: today(), holes: 18 };
  // Up to 3 most recently played courses (course + tee) for one-tap fill.
  const recent = [];
  for (const x of [...state.rounds].sort(byDate).reverse()) {
    const k = (x.course_name + "|" + (x.tee_name || "")).toLowerCase();
    if (!x.course_name || recent.some(y => y.k === k)) continue;
    recent.push({ k, x }); if (recent.length === 3) break;
  }
  openModal(`<h2>${editing ? "Edit round" : "Post a round"}</h2>
    <form id="rf">
      ${recent.length ? `<div class="laylbl">Recent courses</div><div class="chips recent">${recent.map(({ x }, i) => { const nm = splitName(x.course_name);
        return `<button type="button" class="chip" data-recent="${i}">${esc(nm.layout || nm.base)}${x.tee_name ? " · " + esc(x.tee_name) : ""}</button>`; }).join("")}</div>` : ""}
      <label>Player<select name="player">${PLAYERS.map(p => `<option value="${p.slug}" ${p.slug === r.player ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
      <div class="row2"><label>Date<input type="date" name="played_on" value="${r.played_on}" required></label>
      <label>Holes<select name="holes"><option ${r.holes === 18 ? "selected" : ""}>18</option><option ${r.holes === 9 ? "selected" : ""}>9</option></select></label></div>
      ${courseFields(r)}
      <label>Final score<input name="score" class="bigscore" inputmode="numeric" required value="${r.score ?? ""}"></label>
      <label>Notes<input name="notes" value="${esc(r.notes || "")}" placeholder="optional"></label>
      <p class="hint">9-hole rounds are saved but don't count toward the handicap.</p>
      <div class="acts"><button class="primary" type="submit">Save</button>${editing ? `<button type="button" class="danger" id="del">Delete</button>` : ""}</div>
    </form>`, m => {
    const f = $("#rf", m); wireCoursePicker(f);
    // Tee details from a saved course hide behind a link; tap it to see or change them.
    const teeRow = $(".row4", f), teeHint = f.querySelector(".row4 ~ p.hint");
    teeRow.insertAdjacentHTML("beforebegin", `<button type="button" class="link teelink" hidden></button>`);
    const teeLink = $(".teelink", f);
    const savedTee = () => { const name = joinName(f.course_name.value.trim(), f.layout.value.trim()).toLowerCase(), tee = f.tee_name.value.trim().toLowerCase();
      return state.courses.find(c => c.name.toLowerCase() === name && (c.tee_name || "").toLowerCase() === tee && c.rating === Number(f.rating.value) && c.slope === Number(f.slope.value) && c.par === Number(f.par.value)); };
    const syncTee = () => {
      const c = savedTee(), hide = !!c && !f.dataset.showTee;
      teeRow.hidden = hide; if (teeHint) teeHint.hidden = hide; teeLink.hidden = !hide;
      if (c) teeLink.textContent = `Tee details: ${c.tee_name || "Tees"} ${c.rating}/${c.slope} · par ${c.par}`;
    };
    teeLink.onclick = () => { f.dataset.showTee = "1"; syncTee(); };
    f.addEventListener("coursepicked", () => setTimeout(syncTee, 0));
    f.addEventListener("input", e => { if (e.target.closest(".row4")) return; syncTee(); });
    f.querySelector(".recent")?.addEventListener("click", e => {
      const b = e.target.closest("[data-recent]"); if (!b) return;
      const x = recent[+b.dataset.recent].x;
      const c = state.courses.find(c => c.id === x.course_id) || state.courses.find(c => c.name === x.course_name && (c.tee_name || "") === (x.tee_name || "")) || { ...x, name: x.course_name };
      const nm = splitName(c.name); f.course_name.value = nm.base; f.layout.value = nm.layout; f.dataset.layOther = "";
      f.tee_name.value = c.tee_name || ""; f.rating.value = c.rating ?? ""; f.slope.value = c.slope ?? ""; f.par.value = c.par ?? "";
      f.ogapi_id.value = c.ogapi_id || ""; f.city.value = c.city || ""; f.state.value = c.state || "";
      f.lat.value = c.lat ?? ""; f.lng.value = c.lng ?? ""; f.pars.value = c.pars?.length ? JSON.stringify(c.pars) : ""; f.sis.value = c.sis?.length ? JSON.stringify(c.sis) : "";
      $("#cres", f).innerHTML = ""; renderLayouts(f);
      f.querySelectorAll(".recent .chip").forEach(y => y.classList.toggle("on", y === b));
      f.dataset.showTee = ""; syncTee(); f.score.focus();
    });
    syncTee();
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
  mt = mt || { scheduled_for: today(), players: PLAYERS.map(p => p.slug), scoring: "match", title_match: true, status: "scheduled" };
  openModal(`<h2>${editing ? "Edit round" : "Schedule a round"}</h2>
    <form id="mf">
      <div class="row2"><label>Date<input type="date" name="scheduled_for" value="${mt.scheduled_for}" required></label>
      <label>Tee time<input name="tee_time" value="${esc(mt.tee_time || "")}" placeholder="optional"></label></div>
      ${courseFields(mt)}
      <fieldset><legend>Players</legend>${PLAYERS.map(p => `<label class="chk"><input type="checkbox" name="pl" value="${p.slug}" ${mt.players.includes(p.slug) ? "checked" : ""}> ${dot(p.slug)}${esc(p.name)}</label>`).join("")}</fieldset>
      <div class="row2"><label>Scoring<select name="scoring"><option value="match" ${mt.scoring === "match" ? "selected" : ""}>Match play</option><option value="net" ${mt.scoring === "net" ? "selected" : ""}>Net stroke play</option><option value="gross" ${mt.scoring === "gross" ? "selected" : ""}>Gross</option></select></label>
      <label class="chk tm"><input type="checkbox" name="title_match" ${isTitle(mt) ? "checked" : ""}> 🏆 Title match</label></div>
      <p class="hint" id="tmhint">Title matches need all three of you.</p>
      <label>Notes<input name="notes" value="${esc(mt.notes || "")}" placeholder="optional"></label>
      <div class="acts"><button class="primary" type="submit">Save</button>${editing ? `<button type="button" class="danger" id="del">Delete</button>` : ""}</div>
    </form>`, m => {
    const f = $("#mf", m); wireCoursePicker(f);
    const syncTitle = () => { const all = f.querySelectorAll("[name=pl]:checked").length === PLAYERS.length;
      f.title_match.disabled = !all; if (!all) f.title_match.checked = false; $("#tmhint", m).hidden = all; };
    f.querySelectorAll("[name=pl]").forEach(x => x.addEventListener("change", syncTitle)); syncTitle();
    f.onsubmit = async e => {
      e.preventDefault();
      const c = readCourse(f);
      const players = [...f.querySelectorAll("[name=pl]:checked")].map(x => x.value);
      if (players.length < 2) return toast("Pick at least 2 players.");
      const row = { scheduled_for: f.scheduled_for.value, tee_time: f.tee_time.value.trim() || null, players, scoring: f.scoring.value,
        title_match: f.title_match.checked && players.length === PLAYERS.length, notes: f.notes.value.trim() || null, course_name: c.course_name || null, tee_name: c.tee_name,
        rating: c.rating, slope: c.slope, par: c.par, status: mt.status || "scheduled" };
      try {
        if (c.course_name && c.rating && c.slope && c.par) row.course_id = await ensureCourse({ ...c, name: c.course_name });
        await save("matches", row, editing ? mt.id : null);
        if (row.course_name) { ydLoadFile(); ydFetchLive({ course_name: row.course_name, course_id: row.course_id, pars: state.courses.find(x => x.id === row.course_id)?.pars || Array(18).fill(4) }).catch(() => {}); }
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
  const nineHoles = c => c?.pars?.length === 9 || (c?.par > 0 && c.par < 50);
  const holes0 = Object.values(existing)[0]?.holes || (nineHoles(state.courses.find(c => c.id === mt.course_id) || mt) ? 9 : 18);
  openModal(`<h2>Results</h2><p class="hint">${fmtDate(mt.scheduled_for)}${mt.course_name ? " · " + esc(mt.course_name) : ""}</p>
    <form id="xf">
      ${courseFields(mt)}
      <label>Holes<select name="holes"><option ${holes0 === 18 ? "selected" : ""}>18</option><option ${holes0 === 9 ? "selected" : ""}>9</option></select></label>
      ${mt.players.map(s => `<label>${dot(s)}${esc(pname(s))} final score<input name="s_${s}" inputmode="numeric" value="${existing[s]?.score ?? ""}"></label>`).join("")}
      <p class="hint">Each score is also added to that player's round log. Leave someone blank if they didn't finish.</p>
      <div class="acts"><button class="primary" type="submit">Save results</button></div>
    </form>`, m => {
    const f = $("#xf", m); wireCoursePicker(f);
    f.holes.onchange = () => { f.dataset.holesSet = "1"; };
    f.addEventListener("coursepicked", e => { if (!f.dataset.holesSet) f.holes.value = nineHoles(e.detail) ? "9" : "18"; });
    f.onsubmit = async e => {
      e.preventDefault();
      const c = readCourse(f);
      if (!c.course_name || !c.rating || !c.slope || !c.par) return toast("Course rating, slope, and par are needed.");
      const scores = mt.players.map(s => [s, Number(f["s_" + s].value)]).filter(([, v]) => v > 0);
      if (scores.length < 2) return toast("Enter at least 2 scores.");
      try {
        const course_id = await ensureCourse({ ...c, name: c.course_name });
        for (const [s, v] of scores) {
          const row = { player: s, played_on: mt.scheduled_for, holes: Number(f.holes.value), score: v, course_name: c.course_name, tee_name: c.tee_name,
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
    <p class="hint">The handicap starts here, then moves after every 18-hole round.</p>
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
// Active game mode and per-match course handicap overrides (stored in card.scores.__meta so it syncs with zero schema changes).
const cardGame = card => card?.scores?.__meta?.game || (card?.scoring === "gross" ? "stroke" : card?.scoring) || "match";
// Course handicap for each player on this card (uses pre-match override if edited before teeing off).
const cardCh = (card, s) => {
  const ov = card?.scores?.__meta?.hcp?.[s];
  if (ov != null && ov !== "" && !isNaN(Number(ov))) return Number(ov);
  const gh = isGuest(s) ? cardGuests(card)[s]?.hcp : undefined;
  return roundCh(gh != null ? Number(gh) : currentIndex(s).index, { rating: card.rating, slope: card.slope, par: card.par || card.pars.reduce((a, b) => a + b, 0) }, card.pars.length);
};
const cardPts = (card, s) => stableford(holeVals(card, s), card.pars, card.sis, null, matchPops(card)[s]);
// Match strokes ("pops"): strokes off the lowest handicap in the group, on the hardest holes (none in gross stroke play).
function matchPops(card, gm = cardGame(card)) {
  if (gm === "stroke" || gm === "gross") return Object.fromEntries(card.players.map(s => [s, card.pars.map(() => 0)]));
  return groupPops(Object.fromEntries(card.players.map(s => [s, cardCh(card, s)])), card.pars, card.sis);
}
// Skins with carryover: outright lowest net score wins the hole plus any carried skins.
function cardSkins(card, pops) {
  const wins = holeWinners(card, pops);
  const skins = Object.fromEntries(card.players.map(s => [s, 0]));
  let pot = 1;
  const per = card.pars.map((_, i) => {
    const w = wins[i];
    if (w === undefined) return null;
    if (w) { skins[w] += pot; const got = { w, v: pot }; pot = 1; return got; }
    const tie = { w: null, v: pot }; pot++; return tie;
  });
  return { skins, per, pot };
}
// Who won each hole: lowest net score with match strokes, outright (ties = halved).
function holeWinners(card, pops) {
  return card.pars.map((_, i) => {
    if (card.players.length < 2 || card.players.some(p => holeVals(card, p)[i] == null)) return undefined;
    const nets = card.players.map(p => [p, holeVals(card, p)[i] - pops[p][i]]);
    const best = Math.min(...nets.map(x => x[1])); const w = nets.filter(x => x[1] === best);
    return w.length === 1 ? w[0][0] : null;
  });
}
const cardPairs = card => { const pp = matchPops(card);
  return pairsOf(card.players).map(([a, b]) => matchPlay(a, b, holeVals(card, a), holeVals(card, b), cardCh(card, a), cardCh(card, b), card.pars, card.sis, pp[a], pp[b])); };
// ---------- bets: front 9, back 9, game, presses ----------
// Each pair plays its own bets (with 3 players that's three side games).
// A leg is scored the same way as the round: match play holes won with group
// strokes, or net/gross strokes for stroke play. Ties push. A press is a new bet
// from a hole to the end of that nine (or the game).
const BET_DEFAULT = CFG.bets || { front: 5, back: 5, game: 10 };
// The money can be scored its own way (bets.scoring); left blank it follows the round's game.
const moneyGame = card => card.bets?.scoring || cardGame(card);
const moneyPops = card => matchPops(card, moneyGame(card));
const money = n => (n < 0 ? "-" : "") + "$" + (Math.abs(n) % 1 ? Math.abs(n).toFixed(2) : Math.abs(n));
const SEG_NAME = { front: "Front 9", back: "Back 9", game: "Game" };
const segRange = (seg, n) => seg === "front" ? [0, 9] : seg === "back" ? [9, 18] : [0, n];
function betLeg(card, pops, a, b, from, to) {
  const va = holeVals(card, a), vb = holeVals(card, b), gm = moneyGame(card);
  const gross = gm === "stroke" || gm === "gross", mp = gm === "match", sk = gm === "skins", sf = gm === "stableford";
  let d = 0, thru = 0, pot = 1;
  for (let i = from; i < to; i++) {
    if (va[i] == null || vb[i] == null) continue;
    thru++;
    const na = va[i] - (gross ? 0 : pops[a][i]), nb = vb[i] - (gross ? 0 : pops[b][i]);
    if (mp) d += na < nb ? 1 : nb < na ? -1 : 0;
    else if (sk) {
      if (na < nb) { d += pot; pot = 1; }
      else if (nb < na) { d -= pot; pot = 1; }
      else pot++;
    } else if (sf) {
      const pa = Math.max(0, 2 + card.pars[i] - na), pb = Math.max(0, 2 + card.pars[i] - nb);
      d += pa - pb;
    } else d += nb - na;
  }
  const left = to - from - thru, done = left === 0 || (mp && Math.abs(d) > left);
  const lead = d > 0 ? a : d < 0 ? b : null, u = Math.abs(d);
  const unit = mp ? `${u} up` : sk ? `${u} skin${u === 1 ? "" : "s"}` : sf ? `${u} pt${u === 1 ? "" : "s"}` : `by ${u}`;
  const text = !thru ? "Not started" : done ? (lead ? `${pname(lead)} wins` : "Push")
    : !lead ? `All square · ${left} left` : `${pname(lead)} ${unit} · ${left} left`;
  return { d, thru, done, lead, winner: done ? lead : null, text };
}
function settleBets(card) {
  const b = card.bets;
  if (!b || bettors(card).length < 2) return null;
  if (b.type === "pot") return settlePot(card);
  const n = card.pars.length, pops = moneyPops(card);
  const segs = n === 18 ? ["front", "back", "game"] : ["game"];
  const pairs = pairsOf(bettors(card)).map(([a, c]) => {
    const legs = segs.filter(k => +b[k] > 0).map(k => { const [f, t] = segRange(k, n);
      return { k, label: n === 9 ? "9 holes" : SEG_NAME[k], amt: +b[k], ...betLeg(card, pops, a, c, f, t) }; });
    (b.presses || []).forEach((p, pi) => {
      if (!((p.a === a && p.b === c) || (p.a === c && p.b === a))) return;
      const [, t] = segRange(p.seg, n);
      legs.push({ k: "press", pi, label: `Press from ${p.from + 1}`, sub: `${pname(p.by)} · ${SEG_NAME[p.seg].toLowerCase()}`, amt: +p.amt, ...betLeg(card, pops, a, c, p.from, t) });
    });
    let bal = 0;
    legs.forEach(l => { if (l.winner) bal += l.winner === a ? l.amt : -l.amt; });
    return { a, b: c, legs, bal };
  });
  const net = Object.fromEntries(bettors(card).map(s => [s, 0])), pays = [];
  pairs.forEach(p => {
    if (!p.bal) return;
    const to = p.bal > 0 ? p.a : p.b, from = to === p.a ? p.b : p.a, amt = Math.abs(p.bal);
    net[to] += amt; net[from] -= amt; pays.push({ from, to, amt });
  });
  return { pairs, net, pays, done: pairs.every(p => p.legs.every(l => l.done)) };
}
// ---------- pot: everyone in the money buys in once; the best result in the round's game takes it ----------
// Scored by the money's own scoring (moneyGame). Stroke play: lowest gross. Net: lowest net. Stableford: most points. Skins: most skins.
// Match play: most matches won across the pairings, then most holes up overall.
// Ties split the pot. It only pays once everyone in it has finished every hole.
const POT_DEFAULT = (CFG.bets && CFG.bets.pot) || 10;
function potRows(card) {
  const P = bettors(card), gm = moneyGame(card), pops = moneyPops(card);
  if (gm === "stableford") return P.map(s => { const v = stableford(holeVals(card, s), card.pars, card.sis, null, pops[s]).pts; return { s, k: [v], show: `${v} pt${v === 1 ? "" : "s"}` }; });
  if (gm === "skins") { const sk = cardSkins(card, pops); return P.map(s => { const v = sk.skins[s] || 0; return { s, k: [v], show: `${v} skin${v === 1 ? "" : "s"}` }; }); }
  if (gm === "match") {
    const w = Object.fromEntries(P.map(s => [s, 0])), up = { ...w };
    pairsOf(P).forEach(([a, b]) => { const pr = matchPlay(a, b, holeVals(card, a), holeVals(card, b), cardCh(card, a), cardCh(card, b), card.pars, card.sis, pops[a], pops[b]);
      up[a] += pr.up; up[b] -= pr.up; if (pr.up > 0) w[a]++; else if (pr.up < 0) w[b]++; });
    return P.map(s => ({ s, k: [w[s], up[s]], show: `${w[s]} won · ${up[s] > 0 ? "+" : ""}${up[s]}` }));
  }
  // Stroke (gross) has no strokes in matchPops; net takes the group strokes off.
  return P.map(s => { let t = 0; holeVals(card, s).forEach((v, i) => { if (v != null) t += v - pops[s][i] - card.pars[i]; });
    return { s, k: [-t], show: fmtToPar(t) + (gm === "net" ? " net" : "") }; });
}
function settlePot(card) {
  const buy = +card.bets.pot || 0, P = bettors(card), total = buy * P.length;
  const cmp = (x, y) => { for (let i = 0; i < x.k.length; i++) if (x.k[i] !== y.k[i]) return y.k[i] - x.k[i]; return 0; };
  // Players who haven't scored a hole yet sit at the bottom and can't lead.
  const rows = potRows(card).map(r => ({ ...r, thru: cardTotals(card, r.s).thru })).sort((x, y) => (y.thru ? 1 : 0) - (x.thru ? 1 : 0) || cmp(x, y));
  const winners = rows[0]?.thru ? rows.filter(r => r.thru && cmp(r, rows[0]) === 0).map(r => r.s) : [];
  const done = P.every(s => cardTotals(card, s).done);
  const net = Object.fromEntries(P.map(s => [s, 0])), pays = [];
  if (done && winners.length < P.length) {
    // Each player who didn't win pays the buy-in, split evenly (to the cent) among the winners.
    const cents = Math.round(buy * 100), share = Math.floor(cents / winners.length), rem = cents - share * winners.length;
    P.filter(s => !winners.includes(s)).forEach((from, li) => winners.forEach((to, wi) => {
      const amt = (share + ((wi - li % winners.length + winners.length) % winners.length < rem ? 1 : 0)) / 100;
      if (amt > 0) { pays.push({ from, to, amt }); net[to] += amt; net[from] -= amt; }
    }));
    for (const s of P) net[s] = Math.round(net[s] * 100) / 100;
  }
  return { pot: true, buy, total, rows, winners, net, pays, done };
}
const stakesText = (b, n) => b.type === "pot" ? `Pot · ${money(+b.pot || 0)} each`
  : (n === 18 ? [b.front, b.back, b.game] : [b.game]).map(x => money(+x || 0)).join(" · ");
const paysText = (pays, past) => pays.map(x => `${esc(pname(x.from))} ${past ? "paid" : "pays"} ${esc(pname(x.to))} <b>${money(x.amt)}</b>`).join("<br>");
function betsBox(card) {
  const r = settleBets(card), ed = editing();
  if (!r) return bettors(card).length > 1 && ed ? `<div class="ed acts center"><button class="link" data-act="bets" data-id="${card.id}">Add bets</button></div>` : "";
  const n = card.pars.length;
  if (r.pot) {
    const share = r.winners.length ? r.total / r.winners.length : 0, gm = moneyGame(card);
    const lead = r.winners.map(s => esc(pname(s))).join(" & ");
    const sum = r.done ? (r.pays.length ? paysText(r.pays) : "Everyone tied, nobody pays.")
      : r.winners.length ? `${lead} ${r.winners.length > 1 ? "would split" : "would take"} the ${money(r.total)} pot <span class="muted">so far</span>` : "Nobody owes anything yet.";
    return `<section class="card bets"><h3>Pot <span class="muted small">${money(r.buy)} each · ${money(r.total)} · ${esc(SCORING_LABEL[gm] || gm)}</span></h3>
      ${r.rows.map(x => `<div class="brow ${r.done ? "fin" : ""}"><span>${dot(x.s)}${esc(pname(x.s))}</span>
        <b style="${r.winners.includes(x.s) ? `color:${pcolor(x.s)}` : ""}">${x.thru ? esc(x.show) : `<span class="muted">–</span>`}${r.done && r.winners.includes(x.s) && r.winners.length < r.rows.length ? ` · ${money(Math.round(share * 100) / 100)}` : ""}</b></div>`).join("")}
      <div class="bsum">${sum}</div>
      ${ed ? `<div class="acts"><button class="link" data-act="bets" data-id="${card.id}">Change bets</button></div>` : ""}
    </section>`;
  }
  const own = card.bets.scoring && card.bets.scoring !== cardGame(card) ? ` · ${esc(SCORING_LABEL[card.bets.scoring] || card.bets.scoring)}` : "";
  return `<section class="card bets"><h3>Bets <span class="muted small">${stakesText(card.bets, n)}${own}</span></h3>
    ${r.pairs.map(p => `${r.pairs.length > 1 ? `<div class="bpair">${dot(p.a)}${esc(pname(p.a))} v ${dot(p.b)}${esc(pname(p.b))}</div>` : ""}
      ${p.legs.map(l => `<div class="brow ${l.done ? "fin" : ""}"><span>${esc(l.label)}${l.sub ? ` <small>${esc(l.sub)}</small>` : ""} <small>${money(l.amt)}</small>${l.k === "press" && ed ? ` <button class="link xs" data-act="unpress" data-id="${card.id}" data-v="${l.pi}" aria-label="Remove press">✕</button>` : ""}</span>
        <b style="${l.lead ? `color:${pcolor(l.lead)}` : ""}">${esc(l.text)}</b></div>`).join("")}`).join("")}
    <div class="bsum">${r.pays.length ? paysText(r.pays) + (r.done ? "" : ` <span class="muted">so far</span>`) : r.done ? "All square, nobody pays." : "Nobody owes anything yet."}</div>
    ${ed ? `<div class="acts"><button data-act="press" data-id="${card.id}">Press</button><button class="link" data-act="bets" data-id="${card.id}">Change bets</button></div>` : ""}
  </section>`;
}
// Stake inputs used on Start match, Start a scorecard, and Change bets.
// Two games: Nassau (each pair plays front, back and game, with presses) or a Pot (one buy-in each).
const BET_NOTE = { nassau: "Each pair plays its own bets. Ties push. Press anytime from the Live tab.",
  pot: "Everyone in the money buys in once. Best score takes the pot, ties split. Most you can lose is the buy-in." };
function betFields(b, holes) {
  const on = b !== null && b !== undefined ? !!b : true; b = b || BET_DEFAULT;
  const type = b.type === "pot" ? "pot" : "nassau", nb = type === "pot" ? BET_DEFAULT : b;
  const inp = (k, lbl) => `<label data-seg="${k}"><span class="blbl">${lbl}</span><span class="dollar"><input name="b_${k}" inputmode="decimal" value="${nb[k] ?? BET_DEFAULT[k]}" aria-label="${lbl} bet in dollars"></span></label>`;
  return `<div class="betbox" data-type="${type}"><label class="chk"><input type="checkbox" name="beton" ${on ? "checked" : ""}> Playing for money</label>
    <div class="betwrap" ${on ? "" : "hidden"}><div class="row2 betsel">
      <label>Bet<select name="b_type">${[["nassau", "Nassau"], ["pot", "Pot"]].map(([k, l]) => `<option value="${k}" ${k === type ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label>Scored by<select name="b_scoring"><option value="">Same as the round</option>${GAME_OPTIONS.map(([v, l]) => `<option value="${v}" ${b.scoring === v ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
    <div class="betin">${inp("front", "Front 9")}${inp("back", "Back 9")}${inp("game", holes === 9 ? "9 holes" : "Game")}
      <label data-seg="pot"><span class="blbl">Buy-in each</span><span class="dollar"><input name="b_pot" inputmode="decimal" value="${b.pot ?? POT_DEFAULT}" aria-label="Pot buy-in in dollars"></span></label></div></div>
    <p class="hint betnote" ${on ? "" : "hidden"}>${BET_NOTE[type]}</p></div>`;
}
function wireBets(root, holes) {
  const box = root.querySelector(".betbox"); if (!box) return;
  const sync = h => {
    const on = box.querySelector("[name=beton]").checked, pot = box.dataset.type === "pot";
    box.querySelector(".betwrap").hidden = !on; box.querySelector(".betnote").hidden = !on;
    box.querySelector(".betnote").textContent = BET_NOTE[pot ? "pot" : "nassau"];
    box.querySelectorAll("[data-seg=front],[data-seg=back]").forEach(x => x.hidden = pot || h === 9);
    box.querySelector("[data-seg=game]").hidden = pot;
    box.querySelector("[data-seg=pot]").hidden = !pot;
    box.querySelector("[data-seg=game] .blbl").textContent = h === 9 ? "9 holes" : "Game";
    box.dataset.holes = h;
  };
  box.querySelector("[name=beton]").onchange = () => sync(Number(box.dataset.holes));
  box.querySelector("[name=b_type]").onchange = e => { box.dataset.type = e.target.value; sync(Number(box.dataset.holes)); };
  sync(holes);
  return sync;
}
// null = no money; false = bad input (toast already shown).
function readBets(root, holes, presses = []) {
  const box = root.querySelector(".betbox");
  if (!box || !box.querySelector("[name=beton]").checked) return null;
  const v = k => { const s = box.querySelector(`[name=b_${k}]`).value.replace(/[$\s]/g, ""); return s === "" ? 0 : Number(s); };
  const sc = box.querySelector("[name=b_scoring]").value, scoring = sc ? { scoring: sc } : {};
  if (box.dataset.type === "pot") {
    const pot = v("pot");
    if (isNaN(pot) || pot < 0 || pot > 10000) { toast("The buy-in is a dollar amount."); return false; }
    return pot ? { type: "pot", pot, ...scoring } : null;
  }
  const b = { front: holes === 18 ? v("front") : 0, back: holes === 18 ? v("back") : 0, game: v("game") };
  if (Object.values(b).some(x => isNaN(x) || x < 0 || x > 10000)) { toast("Bets are dollar amounts."); return false; }
  if (!b.front && !b.back && !b.game) return null;
  return { ...b, presses, ...scoring };
}
async function saveBets(card, bets) {
  if (!DEMO) await save("cards", { bets }, card.id);
  card.bets = bets; render();
}
function betsForm(id) {
  const card = cardById(id); if (!card) return;
  if (!editing()) return phraseForm(() => betsForm(id));
  const n = card.pars.length;
  openModal(`<h2>Bets</h2><p class="hint">${bettors(card).map(pname).map(esc).join(" vs ")}</p>
    <form id="bf">${betFields(card.bets ?? (card.bets === null ? BET_DEFAULT : null), n)}
    <div class="acts"><button class="primary" type="submit">Save bets</button></div></form>`, m => {
    const f = $("#bf", m); wireBets(f, n);
    f.onsubmit = async e => {
      e.preventDefault();
      const b = readBets(f, n, card.bets?.presses || []); if (b === false) return;
      try { await saveBets(card, b); closeModal(); toast(b ? "Bets saved." : "No money on this one."); } catch (err) { toast("Couldn't save: " + errMsg(err)); }
    };
  });
}
function pressForm(id) {
  const card = cardById(id); if (!card || !card.bets || card.bets.type === "pot") return;
  if (!editing()) return phraseForm(() => pressForm(id));
  const n = card.pars.length, pops = moneyPops(card);
  const hole = Math.min(n - 1, Number(localStorage.getItem("golf_hole_" + id) ?? firstOpenHole(card)));
  const segs = n === 18 ? (hole < 9 ? ["front", "game"] : ["back", "game"]) : ["game"];
  const pairs = pairsOf(bettors(card));
  const amtFor = seg => +card.bets[seg] || +card.bets.game || BET_DEFAULT[seg];
  openModal(`<h2>Press</h2><p class="hint">A new bet from the hole you pick to the end of that nine (or the game).</p>
    <form id="pf">
      ${pairs.length > 1 ? `<label>Match<select name="pair">${pairs.map(([a, b], i) => `<option value="${i}">${esc(pname(a))} v ${esc(pname(b))}</option>`).join("")}</select></label>` : ""}
      <label>Who's pressing<select name="by"></select></label>
      <div class="laylbl">Press on</div>
      <div class="seg2" id="pseg">${segs.map((s, i) => `<button type="button" class="${i === 0 ? "on" : ""}" data-seg="${s}">${n === 9 ? "9 holes" : s === "game" ? "Game" : "Rest of the " + SEG_NAME[s].toLowerCase()}</button>`).join("")}</div>
      <div class="row2"><label>Starts on hole<select name="from"></select></label>
      <label>Amount<span class="dollar"><input name="amt" inputmode="decimal"></span></label></div>
      <div class="acts"><button class="primary" type="submit">Press</button></div>
    </form>`, m => {
    const f = $("#pf", m); let seg = segs[0];
    const pair = () => pairs[Number(f.pair?.value || 0)];
    const fill = () => {
      const [a, b] = pair(), [s0, t] = segRange(seg, n);
      const leg = betLeg(card, pops, a, b, s0, t);
      const down = leg.d > 0 ? b : leg.d < 0 ? a : null;
      f.by.innerHTML = [a, b].map(s => `<option value="${s}" ${s === down ? "selected" : ""}>${esc(pname(s))}</option>`).join("");
      const start = Math.max(hole, s0);
      f.from.innerHTML = [...Array(t - start).keys()].map(k => `<option value="${start + k}">${start + k + 1}</option>`).join("");
      f.amt.value = amtFor(seg);
    };
    if (f.pair) f.pair.onchange = fill;
    $("#pseg", m).onclick = e => { const b = e.target.closest("[data-seg]"); if (!b) return; seg = b.dataset.seg;
      $("#pseg", m).querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); fill(); };
    fill();
    f.onsubmit = async e => {
      e.preventDefault();
      const amt = Number(f.amt.value.replace(/[$\s]/g, ""));
      if (!(amt > 0)) return toast("Enter the press amount.");
      const [a, b] = pair();
      const presses = [...(card.bets.presses || []), { a, b, by: f.by.value, seg, from: Number(f.from.value), amt }];
      try { await saveBets(card, { ...card.bets, presses }); closeModal(); toast(`${pname(f.by.value)} pressed for ${money(amt)}.`); } catch (err) { toast("Couldn't save: " + errMsg(err)); }
    };
  });
}
async function unpress(id, pi) {
  const card = cardById(id); if (!card?.bets) return;
  if (!confirm("Remove this press?")) return;
  const presses = (card.bets.presses || []).filter((_, i) => i !== pi);
  try { await saveBets(card, { ...card.bets, presses }); } catch (err) { toast("Couldn't save: " + errMsg(err)); }
}
// All-time money from finished matches (matches.bets.result.pays).
function moneyLedger() {
  const net = Object.fromEntries(PLAYERS.map(p => [p.slug, 0])), pair = {};
  let games = 0;
  for (const m of state.matches) {
    const pays = m.status === "final" && m.bets?.result?.pays;
    if (!pays) continue;
    games++;
    for (const x of pays) {
      if (!(x.from in net) || !(x.to in net)) continue;
      net[x.to] += x.amt; net[x.from] -= x.amt;
      const [s1, s2] = [x.from, x.to].sort(), k = s1 + "|" + s2;
      pair[k] = (pair[k] || 0) + (x.to === s1 ? x.amt : -x.amt);
    }
  }
  return { net, pair, games };
}
const moneyCls = v => v > 0 ? "up" : v < 0 ? "down" : "";
const moneySigned = v => v > 0 ? "+" + money(v) : money(v);
// Who paid whom after a round, typed in (rounds without a live card, or fixes).
function moneyForm(mt) {
  if (!editing()) return phraseForm(() => moneyForm(mt));
  const old = mt.bets?.result?.pays || [];
  const pairs = pairsOf(mt.players);
  openModal(`<h2>Money</h2><p class="hint">${fmtDate(mt.scheduled_for)}${mt.course_name ? " · " + esc(mt.course_name) : ""}</p>
    <form id="mf">
      ${pairs.map(([a, b], i) => { const p = old.find(x => (x.from === a && x.to === b) || (x.from === b && x.to === a));
        return `<div class="row2"><label>${esc(pname(a))} v ${esc(pname(b))}: who paid<select name="w${i}"><option value="">Nobody</option>
          <option value="${a}|${b}" ${p?.from === a ? "selected" : ""}>${esc(pname(a))} paid ${esc(pname(b))}</option>
          <option value="${b}|${a}" ${p?.from === b ? "selected" : ""}>${esc(pname(b))} paid ${esc(pname(a))}</option></select></label>
          <label>Amount<span class="dollar"><input name="a${i}" inputmode="decimal" value="${p?.amt ?? ""}"></span></label></div>`; }).join("")}
      <label>Note<input name="note" value="${esc(mt.bets?.note || "")}" placeholder="e.g. pressed on 18"></label>
      <div class="acts"><button class="primary" type="submit">Save</button></div>
    </form>`, m => {
    const f = $("#mf", m);
    f.onsubmit = async e => {
      e.preventDefault();
      const pays = [];
      for (let i = 0; i < pairs.length; i++) {
        const w = f["w" + i].value, amt = Number(f["a" + i].value.replace(/[$\s]/g, "") || 0);
        if (!w) continue;
        if (!(amt > 0)) return toast("Enter how much was paid.");
        const [from, to] = w.split("|"); pays.push({ from, to, amt });
      }
      const net = Object.fromEntries(mt.players.map(s => [s, 0])); pays.forEach(x => { net[x.to] += x.amt; net[x.from] -= x.amt; });
      const bets = { ...(mt.bets || {}), note: f.note.value.trim() || null, result: { pays, net, manual: true } };
      try { await save("matches", { bets }, mt.id); closeModal(); await refresh(); toast("Money saved."); } catch (err) { toast("Couldn't save: " + errMsg(err)); }
    };
  });
}

// ---------- check the scorecard before teeing off ----------
// Shows pars, hole handicaps, each player's handicap and where they stroke.
// "Fix pars or handicaps" edits it right here; go(pars, sis, toCourse) starts the round.
function parseSis(raw, n) {
  if (!raw.some(Boolean)) return { sis: null };
  if (raw.some(x => !x)) return { err: "Fill every hole's handicap, or leave them all blank." };
  const nums = raw.map(Number);
  if (nums.some(x => !Number.isInteger(x) || x < 1 || x > 36)) return { err: "Handicaps are whole numbers from the card." };
  if (new Set(nums).size !== n) return { err: "Two holes have the same handicap. Check the card." };
  const sorted = [...nums].sort((a, b) => a - b);
  return { sis: nums.map(x => sorted.indexOf(x) + 1) };
}
function confirmCard(m, step1, d, go) {
  let pars = [...d.pars], sis = d.sis ? [...d.sis] : null, editMode = false, changed = false;
  const gm = d.game || "match", isGross = gm === "stroke" || gm === "gross";
  const n = pars.length, wrap = document.createElement("div");
  // Pre-match course handicap overrides (editable right here before confirming the holes).
  const baseCard0 = { pars, sis, players: d.players, rating: d.rating, slope: d.slope, par: d.par || pars.reduce((a, b) => a + b, 0) };
  const G = d.players;
  const idxOf = s => isGuest(s) ? (d.guests?.[s]?.hcp ?? null) : currentIndex(s).index;
  const hcpOv = Object.fromEntries(d.players.map(s => [s, roundCh(idxOf(s), baseCard0, n)]));
  const origHcp = { ...hcpOv };
  wrap.className = "confirm"; step1.hidden = true; step1.after(wrap);
  const back = () => { wrap.remove(); step1.hidden = false; };
  const draw = () => {
    const cleanOv = {};
    for (const s of d.players) if (hcpOv[s] != null && hcpOv[s] !== "" && !isNaN(Number(hcpOv[s]))) cleanOv[s] = Number(hcpOv[s]);
    const card = { pars, sis, players: d.players, rating: d.rating, slope: d.slope, par: d.par || pars.reduce((a, b) => a + b, 0),
      scoring: dbScoring(gm), scores: { __meta: { game: gm, hcp: cleanOv, guests: d.guests || {} } } };
    const pops = matchPops(card), si = strokeIndex(pars, sis);
    const rows = d.players.map(s => ({ s, h: { index: idxOf(s) }, ch: cardCh(card, s), got: pops[s].reduce((a, b) => a + b, 0) }));
    const half = (a, b, lbl) => { const idx = [...Array(b - a).keys()].map(k => a + k);
      return `<table class="sc chk"><thead><tr><th>${lbl}</th>${idx.map(i => `<th>${i + 1}</th>`).join("")}<th>Tot</th></tr></thead><tbody>
        <tr class="par"><td>Par</td>${idx.map(i => `<td>${pars[i]}</td>`).join("")}<td>${idx.reduce((x, i) => x + pars[i], 0)}</td></tr>
        <tr class="hcp"><td>Hcp</td>${idx.map(i => `<td>${si[i]}</td>`).join("")}<td></td></tr>
        ${G.length > 1 && !isGross ? G.map(s => `<tr><td>${dot(s)}${esc(pname(s).slice(0, 5))}</td>${idx.map(i => `<td>${pops[s][i] > 0 ? `<i class="pd">${"●".repeat(pops[s][i])}</i>` : ""}</td>`).join("")}<td>${idx.reduce((x, i) => x + Math.max(0, pops[s][i]), 0) || ""}</td></tr>`).join("") : ""}
      </tbody></table>`; };
    const editor = (a, b, lbl) => `<div class="sgrp"><div class="sr head"><span>${lbl}</span><span>Par</span><span>Hcp</span></div>${[...Array(b - a).keys()].map(k => { const i = a + k;
      return `<div class="sr"><span class="sh">${i + 1}</span><div class="seg">${[3, 4, 5, 6].map(p => `<button type="button" class="${pars[i] === p ? "on" : ""}" data-h="${i}" data-p="${p}">${p}</button>`).join("")}</div>
        <input name="si${i}" inputmode="numeric" value="${sis?.[i] ?? ""}" aria-label="Hole ${i + 1} handicap"></div>`; }).join("")}</div>`;
    const noSis = !(sis?.length === n), flatPars = !d.parsKnown;
    const gmLbl = SCORING_LABEL[gm] || gm;
    wrap.innerHTML = `<h2>Check the scorecard</h2>
      <p class="hint">${esc(d.course_name)}${d.tee_name ? " · " + esc(d.tee_name) : ""}${d.rating ? ` · ${d.rating}/${d.slope}` : ""} · ${n} holes · <b>${esc(gmLbl)}</b></p>
      <table class="t cplayers"><thead><tr><th></th><th class="n">Index</th><th class="n">Course hcp</th>${G.length > 1 && !isGross ? `<th class="n">Strokes</th>` : ""}</tr></thead><tbody>
        ${rows.map(x => `<tr><td>${dot(x.s)}${esc(pname(x.s))}</td><td class="n">${fmtIdx(x.h.index)}</td><td class="n">${isGross ? `<span class="muted">–</span>` : `<input type="number" class="ch-in" data-ch="${x.s}" inputmode="numeric" min="-10" max="54" value="${x.ch ?? ""}" aria-label="${esc(pname(x.s))} course handicap">`}</td>${G.length > 1 && !isGross ? `<td class="n"><b>${x.got || "–"}</b></td>` : ""}</tr>`).join("")}
      </tbody></table>
      <p class="hint">${d.solo ? "Solo round: your gross score goes on your tab and moves your handicap." : isGross ? "Gross stroke play: playing straight up, no handicap strokes." : `${G.length > 1 ? (rows.some(x => x.got) ? "Strokes come off the lowest handicap in the group, on the hardest holes (● below). " : "Everyone plays level. ") : ""}${n === 9 ? "9 holes: half the course handicap. " : ""}Need to adjust a handicap for today? Edit any Course hcp box above before confirming.`}</p>
      ${flatPars && !editMode ? `<div class="warnt small">No hole pars saved for this course, so every hole shows par 4. Fix them below.</div>` : ""}
      ${noSis && !editMode && !isGross ? `<div class="warnt small">No hole handicaps saved, so strokes use the standard order. Add them below if the card has them.</div>` : ""}
      ${editMode ? `<form id="cfx"><p class="hint">Copy par and handicap (HCP) for each hole from the scorecard.</p>${n === 18 ? editor(0, 9, "Out") + editor(9, 18, "In") : editor(0, n, "Hole")}
          <div class="acts"><button class="primary" type="submit">Done</button><button type="button" id="cfxc">Cancel</button></div></form>`
        : `${n === 18 ? half(0, 9, "Out") + half(9, 18, "In") : half(0, n, "Hole")}
          <div class="acts"><button type="button" id="cfix">Fix pars or hole hcps</button></div>
          ${changed && d.saveName && n === 18 ? `<label class="chk"><input type="checkbox" id="cfsave" checked> Save the fixes to ${esc(d.saveName)} for next time</label>` : ""}
          ${d.betsLine ? `<div class="cbets"><span>Bets</span><b>${d.betsLine}</b></div>` : ""}
          <div class="acts"><button class="primary big" id="cfgo">Looks right, tee off ›</button><button type="button" id="cfback">Back</button></div>`}`;
    wrap.querySelectorAll("[data-ch]").forEach(inp => {
      inp.onchange = () => {
        const s = inp.dataset.ch, raw = inp.value.trim();
        const v = raw === "" ? null : Math.round(Number(raw));
        if (raw !== "" && (isNaN(v) || v < -10 || v > 54)) { toast("Enter a course handicap between -10 and 54."); inp.value = hcpOv[s] ?? ""; return; }
        hcpOv[s] = v;
        draw();
      };
    });
    if (editMode) {
      const f = $("#cfx", wrap); const P2 = [...pars];
      f.addEventListener("click", e => { const b = e.target.closest("[data-p]"); if (!b) return;
        P2[+b.dataset.h] = +b.dataset.p; b.parentNode.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); });
      $("#cfxc", wrap).onclick = () => { editMode = false; draw(); };
      f.onsubmit = e => { e.preventDefault();
        const r = parseSis(P2.map((_, i) => f["si" + i].value.trim()), n); if (r.err) return toast(r.err);
        changed = changed || JSON.stringify(P2) !== JSON.stringify(pars) || JSON.stringify(r.sis) !== JSON.stringify(sis);
        pars = P2; sis = r.sis; d.parsKnown = true; editMode = false; draw(); };
    } else {
      $("#cfix", wrap).onclick = () => { editMode = true; draw(); };
      $("#cfback", wrap).onclick = back;
      $("#cfgo", wrap).onclick = async () => {
        const btn = $("#cfgo", wrap); btn.disabled = true; btn.textContent = "Starting…";
        const outOv = {};
        if (!isGross) for (const s of d.players) if (hcpOv[s] != null && hcpOv[s] !== origHcp[s]) outOv[s] = hcpOv[s];
        try { await go(pars, sis, changed && !!$("#cfsave", wrap)?.checked, outOv); }
        catch (err) { btn.disabled = false; btn.textContent = "Looks right, tee off ›"; toast("Couldn't start: " + errMsg(err)); }
      };
    }
    m.querySelector(".sheet")?.scrollTo?.(0, 0);
  };
  draw();
}

// Top of every tab: the round happening now, else today's, else the next one.
const cardForMatch = id => state.cards.find(c => c.match_id === id);
const dayName = s => parseDate(s).toLocaleDateString("en-US", { weekday: "long" });
function whenText(s) {
  const d = daysBetween(today(), s);
  return d === 0 ? "Today" : d === 1 ? "Tomorrow" : d > 1 && d < 7 ? `${dayName(s)} · in ${d} days` : d >= 7 ? `${fmtShort(s)} · in ${d} days` : `${fmtShort(s)} · needs results`;
}
function liveStrip() {
  const out = [];
  for (const c of state.cards) {
    const board = c.players.map(s => ({ s, t: cardTotals(c, s) })).sort((a, b) => (b.t.thru ? 1 : 0) - (a.t.thru ? 1 : 0) || a.t.toPar - b.t.toPar);
    const thru = Math.max(0, ...board.map(x => x.t.thru));
    out.push(`<a class="spot live" href="#card/${c.id}">
      <div class="sl"><span class="pulse"></span>Live now<span class="sw">${thru ? `thru ${thru}` : "just started"}</span></div>
      <div class="sc2">${esc(c.course_name)}${c.tee_name ? `<span class="tee">${esc(c.tee_name)}</span>` : ""}</div>
      <div class="sh2">${esc(cardStory(c).head)}</div>
      <div class="sgo">Open Live ›</div></a>`);
  }
  if (!out.length) {
    const next = state.matches.filter(m => m.status === "scheduled" && !cardForMatch(m.id) && daysBetween(today(), m.scheduled_for) >= 0).sort(byDate)[0];
    if (next && daysBetween(today(), next.scheduled_for) <= 14) {
      const isToday = next.scheduled_for === today();
      const hasCourse = next.rating && next.slope && next.par;
      out.push(`<section class="spot ${isToday ? "today" : ""}">
        <div class="sl">${isToday ? "Today's round" : "Upcoming round"}<span class="sw">${whenText(next.scheduled_for)}${next.tee_time ? " · " + esc(next.tee_time) : ""}</span></div>
        <div class="sc2">${esc(next.course_name || "Course TBD")}${next.tee_name ? `<span class="tee">${esc(next.tee_name)}</span>` : ""}${isTitle(next) ? `<span class="tag gold">🏆 title match</span>` : ""}</div>
        <div class="sb">${next.players.map(s => `<span>${dot(s)}${esc(pname(s))}</span>`).join(`<span class="muted">vs</span>`)}</div>
        ${hasCourse && next.scoring !== "gross" ? strokesLine(next, next.players) : ""}
        <div class="acts"><button class="primary${isToday ? " big" : ""}" data-act="start-match" data-id="${next.id}">Start match</button>${isToday ? "" : `<span class="ss">Tap when you tee off.</span>`}</div>
      </section>`);
    }
  }
  return out.join("");
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
  const { data, error } = await sb.from("cards").select("*").eq("id", id).maybeSingle();
  if (error) return; // offline or a hiccup: keep what we have
  if (!data || data.status !== "live") { // deleted or ended elsewhere
    if (!pending[id]?.size) state.cards = state.cards.filter(c => c.id !== id);
    return;
  }
  const mine = pending[id] || new Set();
  const local = cardById(id);
  if (local) {
    for (const s of mine) if (s !== "__pars") data.scores[s] = local.scores[s];
    if (mine.has("__pars")) data.pars = local.pars;
    Object.assign(local, data);
  } else if (data.status === "live") state.cards.push(data);
  noteGuests(cardGuests(data));
  stampUpd();
}

// ---------- the story so far: headline + highlights ----------
const holeWord = i => `${i + 1}`;
function cardStory(card) {
  const n = card.pars.length, ALL = card.players, P = ALL;
  const vals = Object.fromEntries(ALL.map(s => [s, holeVals(card, s)]));
  const pts = Object.fromEntries(ALL.map(s => [s, cardPts(card, s)]));
  const pairs = P.length > 1 ? cardPairs(card) : [];
  const moments = []; // {i, text, kind}
  const thruAll = Math.max(0, ...ALL.map(s => cardTotals(card, s).thru));
  // Player moments
  for (const s of ALL) {
    let parRun = 0;
    vals[s].forEach((v, i) => {
      if (v == null) { parRun = 0; return; }
      const d = v - card.pars[i], nm = pname(s);
      if (d <= -2) moments.push({ i, kind: "great", text: `${d === -2 ? "Eagle" : "Albatross"} for ${nm} on ${holeWord(i)}` });
      else if (d === -1) moments.push({ i, kind: "good", text: `${nm} birdied ${holeWord(i)}` });
      else if (d >= 3) moments.push({ i, kind: "bad", text: `${nm} took a ${v} on ${holeWord(i)}` });
      parRun = d <= 0 ? parRun + 1 : 0;
      if (parRun >= 3 && (i === n - 1 || vals[s][i + 1] == null || vals[s][i + 1] - card.pars[i + 1] > 0))
        moments.push({ i, kind: "good", text: `${nm} went ${parRun} straight holes at par or better` });
    });
  }
  // Match moments: lead changes and winning runs
  for (const pr of pairs) {
    let up = 0, run = 0, runBy = null;
    pr.res.forEach((r, i) => {
      if (r == null) return;
      const before = up; up += r;
      const by = r > 0 ? pr.a : r < 0 ? pr.b : null;
      if (by && by === runBy) run++; else { run = by ? 1 : 0; runBy = by; }
      if (run === 3) moments.push({ i, kind: "good", text: `${pname(by)} won 3 straight holes against ${pname(by === pr.a ? pr.b : pr.a)}` });
      if (before <= 0 && up > 0 && before !== 0) moments.push({ i, kind: "swing", text: `${pname(pr.a)} took the lead back on ${holeWord(i)}` });
      else if (before >= 0 && up < 0 && before !== 0) moments.push({ i, kind: "swing", text: `${pname(pr.b)} took the lead back on ${holeWord(i)}` });
      else if (before !== 0 && up === 0) moments.push({ i, kind: "swing", text: `${pname(r > 0 ? pr.a : pr.b)} squared it on ${holeWord(i)}` });
      else if (before === 0 && up !== 0 && pr.res.slice(0, i).some(x => x != null)) moments.push({ i, kind: "swing", text: `${pname(up > 0 ? pr.a : pr.b)} took the lead on ${holeWord(i)}` });
    });
    if (pr.done) moments.push({ i: n, kind: "great", text: pr.text });
  }
  moments.sort((a, b) => b.i - a.i);

  // Headline
  const gm = cardGame(card), pops = matchPops(card);
  let head;
  const ptsLead = [...P].sort((a, b) => pts[b].pts - pts[a].pts);
  if (!thruAll) {
    const pr = pairs[0];
    if (gm === "stroke" || gm === "gross") head = "Gross stroke play. First tee, let's go.";
    else head = pr ? (pr.getter ? `${pname(pr.getter)} gets ${pr.strokes} from ${pname(pr.getter === pr.a ? pr.b : pr.a)}. First tee, let's go.` : "Playing level. First tee, let's go.") : "First tee, let's go.";
  } else if (gm === "skins" && P.length > 1) {
    const sk = cardSkins(card, pops);
    const ranked = [...P].sort((a, b) => sk.skins[b] - sk.skins[a]);
    const top = sk.skins[ranked[0]], tied = ranked.filter(s => sk.skins[s] === top);
    const carry = sk.pot > 1 ? ` · ${sk.pot} carrying` : "";
    if (!top) head = `No skins won thru ${thruAll}${carry}.`;
    else if (tied.length > 1) head = `Tied with ${top} skin${top === 1 ? "" : "s"} thru ${thruAll}${carry}.`;
    else head = `${pname(ranked[0])} leads with ${top} skin${top === 1 ? "" : "s"} thru ${thruAll}${carry}.`;
  } else if (gm === "stableford" && P.length > 1) {
    const top = pts[ptsLead[0]].pts, tied = ptsLead.filter(s => pts[s].pts === top);
    head = tied.length > 1 ? `Tied at ${top} Stableford pts thru ${thruAll}.` : `${pname(ptsLead[0])} leads with ${top} Stableford pts thru ${thruAll}.`;
  } else if ((gm === "stroke" || gm === "gross" || gm === "net") && P.length > 1) {
    const isNet = gm === "net";
    const scOf = s => {
      const v = vals[s]; let sum = 0;
      v.forEach((x, i) => { if (x != null) sum += x - (isNet ? pops[s][i] : 0) - card.pars[i]; });
      return sum;
    };
    const ranked = [...P].sort((a, b) => scOf(a) - scOf(b));
    const d = scOf(ranked[1]) - scOf(ranked[0]);
    head = d === 0 ? `All tied thru ${thruAll} (${isNet ? "net" : "gross"}).` : `${pname(ranked[0])} leads by ${d} thru ${thruAll} (${isNet ? "net" : "gross"}).`;
  } else if (pairs.length === 1) {
    const pr = pairs[0], lead = pr.up > 0 ? pr.a : pr.up < 0 ? pr.b : null, other = lead === pr.a ? pr.b : pr.a, u = Math.abs(pr.up), left = n - pr.thru;
    if (pr.done) head = pr.winner ? `${pr.text}.` : "Halved. Nobody blinked.";
    else if (!lead) head = `All square thru ${pr.thru}. Nobody's blinking.`;
    else if (u === left) head = `${pname(lead)} is dormie, ${u} up with ${left} to play. ${pname(other)} has to win out.`;
    else if (u >= 4) head = `${pname(lead)} is running away with it, ${u} up thru ${pr.thru}.`;
    else if (u === 3) head = `${pname(lead)} is dominating, 3 up thru ${pr.thru}.`;
    else head = `${pname(lead)} ${u} up thru ${pr.thru}. ${u === 1 ? "Tight one." : "Still a match."}`;
  } else if (pairs.length > 1) {
    // Match play text: every match that has started, biggest lead first, leader named first.
    // Points stay in the standings table only.
    const live = pairs.filter(pr => pr.thru).sort((x, y) => Math.abs(y.up) - Math.abs(x.up));
    const one = pr => {
      const lead = pr.up > 0 ? pr.a : pr.up < 0 ? pr.b : null, other = lead === pr.a ? pr.b : pr.a;
      if (pr.done) return pr.winner ? pr.text.replace(" wins ", ` beat ${pname(pr.winner === pr.a ? pr.b : pr.a)} `) : `${pname(pr.a)} and ${pname(pr.b)} halved`;
      return lead ? `${pname(lead)} ${Math.abs(pr.up)} up on ${pname(other)}` : `${pname(pr.a)} and ${pname(pr.b)} all square`;
    };
    const going = live.filter(pr => !pr.done).map(one).join(" · "), over = live.filter(pr => pr.done).map(one).join(" · ");
    head = [going && `${going} thru ${thruAll}`, over].filter(Boolean).join(" · ") + ".";
  } else head = `${pts[P[0]].pts} points thru ${thruAll}.`;
  return { head, moments, pairs, pts, thruAll };
}

function viewCard(id) {
  const card = cardById(id);
  if (!card) return `<section class="card"><div class="empty">No round in progress. Start one from + or an upcoming round.</div></section>`;
  const n = card.pars.length;
  const hole = Math.min(n - 1, Math.max(0, Number(localStorage.getItem("golf_hole_" + id) ?? firstOpenHole(card))));
  const ed = editing();
  const st = cardStory(card);
  const si = strokeIndex(card.pars, card.sis);
  const pops = matchPops(card);
  const wins = holeWinners(card, pops);
  const gm = cardGame(card), sk = gm === "skins" ? cardSkins(card, pops) : null;
  const two = gm === "match" && st.pairs.length === 1 ? st.pairs[0] : null;
  const chip = s => { if (!two || !two.thru) return ""; const me = (s === two.a ? 1 : -1) * two.up;
    return me > 0 ? `<span class="mchip up">${me} UP</span>` : me === 0 ? `<span class="mchip as">AS</span>` : ""; };
  const board = card.players.map(s => ({ s, t: cardTotals(card, s), p: st.pts[s], ch: cardCh(card, s), sk: sk ? sk.skins[s] ?? 0 : 0 }))
    .sort((a, b) => (b.t.thru ? 1 : 0) - (a.t.thru ? 1 : 0) || (sk ? b.sk - a.sk : b.p.pts - a.p.pts) || a.t.toPar - b.t.toPar);
  const others = state.cards.filter(c => c.id !== id);

  // Pieces of the top box, shared by the follow-along layout and the scoring layout.
  const chips = others.length ? `<div class="chips cardsw">${state.cards.map(c => `<a class="chip ${c.id === id ? "on" : ""}" href="#card/${c.id}">${esc(splitName(c.course_name).base)}</a>`).join("")}</div>` : "";
  const gmBadge = `<span class="lt-game">${cardSolo(card) ? "solo round" : esc(SCORING_LABEL[gm] || gm)}</span>`;
  const meta = `<div class="lt-meta"><span class="pulse"></span><span class="lt-course">${esc(card.course_name)}${card.tee_name ? " · " + esc(card.tee_name) : ""}</span>${gmBadge}<span class="lt-thru">${st.thruAll ? `thru ${st.thruAll}` : fmtShort(card.played_on)}</span></div>`;
  const latest = st.moments[0] && st.thruAll && !st.head.startsWith(st.moments[0].text) ? `<div class="latest">Latest: ${esc(st.moments[0].text)}</div>` : "";
  const lboard = `<div class="lboard">${board.map(x => `<div class="lrow">
      <span class="lname">${dot(x.s)}${esc(pname(x.s))}${chip(x.s)}</span>
      <span class="lscore">${x.t.thru ? `<b>${fmtToPar(x.t.toPar)}</b><small>${x.t.gross}</small>` : `<span class="muted">–</span>`}</span>
      <span class="lpts">${x.t.thru ? (sk ? `<b>${x.sk}</b><small>skin${x.sk === 1 ? "" : "s"}</small>` : `<b>${x.p.pts}</b><small>pts</small>`) : ""}</span></div>`).join("")}</div>`;
  // One short row per pairing: names left, standing right ("–" until the pair has played a hole).
  const mlines = st.pairs.length > 1 ? `<div class="mlines">${st.pairs.map(pr => `<div class="mp"><span class="mpn">${esc(pname(pr.a))} v ${esc(pname(pr.b))}</span>${pr.thru ? `<b>${esc(pr.text.replace(/ thru \d+$/, ""))}</b>` : `<span class="muted">–</span>`}</div>`).join("")}</div>` : "";
  const hcpline = `<div class="hcpline">${card.players.filter(p => pops[p].some(x => x > 0)).map(p => `${esc(pname(p))} strokes on ${pops[p].map((x, i) => x > 0 ? i + 1 + (x > 1 ? "×" + x : "") : null).filter(Boolean).join(", ")}`).join(" · ") || (card.players.length > 1 ? "Playing level, no strokes" : "")}${board.some(x => x.ch != null) ? ` · course hcp ${board.map(x => `${esc(pname(x.s))} ${x.ch ?? "–"}`).join(", ")}` : ""}</div>`;
  const rateWarn = !card.rating || !card.slope ? `<div class="warnt small">Add the course rating and slope (End round) so handicap strokes count.</div>` : "";
  const noSis = card.sis?.length === n ? "" : `<div class="muted small">No hole handicaps saved for this course, so strokes use the standard order. <button class="link ed" data-act="cardsc" data-id="${id}">Edit scorecard</button></div>`;
  // Scoring: the hole (header, map, everyone's buttons) comes first; the match standings sit under it in one box.
  // Scoring view: one small table. Rows are players (score to par, points or skins); with 3+ players
  // each opponent gets a column showing the row player's match against them (2 up, 1 dn, AS, W 3&2).
  const multi = st.pairs.length > 1;
  const short = s => esc(pname(s).split(" ")[0].slice(0, 6));
  const vs = (s, o) => {
    if (s === o) return `<td class="mx-self"></td>`;
    const pr = st.pairs.find(q => (q.a === s && q.b === o) || (q.a === o && q.b === s));
    if (!pr || !pr.thru) return `<td class="muted">–</td>`;
    const tip = ` title="${esc(pr.text)}"`;
    if (pr.done) { const m = (pr.text.split(" wins ")[1] || "").replace(" up", "up");
      return pr.winner === s ? `<td class="mx-up"${tip}>W${m ? " " + esc(m) : ""}</td>` : pr.winner ? `<td class="mx-dn"${tip}>L${m ? " " + esc(m) : ""}</td>` : `<td${tip}>H</td>`; }
    const me = (s === pr.a ? 1 : -1) * pr.up;
    return me > 0 ? `<td class="mx-up"${tip}>${me} up</td>` : me < 0 ? `<td class="mx-dn"${tip}>${-me} dn</td>` : `<td${tip}>AS</td>`;
  };
  const stable = `<table class="stbl"><thead><tr><th></th><th>Score</th><th>${sk ? "Skins" : "Pts"}</th>${multi ? card.players.map(o => `<th>${dot(o)}${short(o)}</th>`).join("") : ""}</tr></thead>
    <tbody>${board.map(x => `<tr><td class="stn">${dot(x.s)}<span>${esc(pname(x.s))}</span>${chip(x.s)}</td>
      <td class="sts">${x.t.thru ? `<b>${fmtToPar(x.t.toPar)}</b><small>${x.t.gross}</small>` : `<span class="muted">–</span>`}</td>
      <td class="stp">${x.t.thru ? `<b>${sk ? x.sk : x.p.pts}</b>` : `<span class="muted">–</span>`}</td>
      ${multi ? card.players.map(o => vs(x.s, o)).join("") : ""}</tr>`).join("")}</tbody></table>`;
  const standings = `<section class="card live-top lbcard">${chips}${meta}<div class="headline">${esc(st.head)}</div>${rateWarn}${latest}${stable}<details class="strokesd" ${viewCard._strokes ? "open" : ""}><summary class="muted small">Strokes</summary>${hcpline}${noSis}</details></section>`;
  const top = `<section class="card live-top">
    ${chips}
    ${meta}
    <div class="headline">${esc(st.head)}</div>
    ${latest}
    ${lboard}
    ${mlines}
    ${hcpline}
    ${rateWarn}
    ${noSis}
  </section>`;

  const entry = ed ? `<section class="card hole">
      <div class="hhead">
        <button class="nav" data-act="hole" data-v="${hole - 1}" ${hole === 0 ? "disabled" : ""} aria-label="Previous hole">‹</button>
        <div class="hnum"><div class="hn">Hole ${hole + 1}</div><button class="parbtn" data-act="cardsc" data-id="${id}">Par ${card.pars[hole]} · Hcp ${si[hole]}<span data-ryds="${id}:${hole}">${ydRoughText(card, hole)}</span></button>
          <button class="yds" data-act="yds" data-yds="${id}:${hole}">${ydText(card, hole)}</button>
          <div class="popline">${wins[hole] !== undefined ? (wins[hole] ? `<span class="hwin">${esc(pname(wins[hole]))} wins the hole</span>` : `<span class="hhalf">Hole halved</span>`) : ""}${(() => { if (wins[hole] !== undefined) return ""; const g = card.players.filter(p => pops[p][hole] > 0); return card.players.length < 2 ? "" : g.length ? `${g.map(p => esc(pname(p))).join(" & ")} ${g.length > 1 ? "stroke" : "strokes"} here` : "No strokes here"; })()}</div></div>
        <button class="nav" data-act="hole" data-v="${hole + 1}" ${hole === n - 1 ? "disabled" : ""} aria-label="Next hole">›</button>
      </div>
      <div class="satwrap" data-sat="${id}:${hole}" hidden>
        <canvas class="satcv"></canvas>
        <span class="sathint">Drag to measure</span>
        <button type="button" class="satbtn satclr" aria-label="Clear target" hidden>✕</button>
        <button type="button" class="satbtn satexp" aria-label="Expand hole map">⤢</button>
      </div>
      <div class="hnote" data-hnote="${id}:${hole}">${ydHoleNote(card, hole)}</div>
      ${card.players.map(s => {
        const v = holeVals(card, s)[hole];
        const pop = pops[s][hole]; const hp = st.pts[s].per[hole];
        return `<div class="prow">
          <div class="pn">${dot(s)}${esc(pname(s))}${pop > 0 ? `<span class="popb">${pop > 1 ? pop + " strokes" : "stroke"}</span>` : ""}<div class="ps">${hp != null ? `${hp} pt${hp === 1 ? "" : "s"}` : "&nbsp;"}</div></div>
          <button class="step" data-act="sc" data-s="${s}" data-d="-1" aria-label="${esc(pname(s))} one less">−</button>
          <button class="val ${v == null ? "empty" : scoreCls(v, card.pars[hole])}" data-act="sc" data-s="${s}" data-d="0" aria-label="${esc(pname(s))} score">${v ?? card.pars[hole]}</button>
          <button class="step" data-act="sc" data-s="${s}" data-d="1" aria-label="${esc(pname(s))} one more">+</button>
        </div>`;
      }).join("")}
      <div class="hfoot"><span><span id="savestate" class="savestate"></span><span id="autoadv" class="autoadv">${cardAction._advFor === id + ":" + hole ? `Hole ${hole + 2} next…` : ""}</span></span>${hole < n - 1 ? `<button class="primary" data-act="hole" data-v="${hole + 1}">Next hole ›</button>` : `<button class="primary" data-act="finish" data-id="${id}">Submit round</button>`}</div>
    </section>` : `<p class="hint center">Updates by itself. Tap Enter scores to keep score.</p>`;

  const grid = half => {
    const idx = half === 0 ? [...Array(Math.min(9, n)).keys()] : [...Array(n - 9).keys()].map(i => i + 9);
    if (!idx.length) return "";
    const sum = arr => arr.reduce((a, b) => a + b, 0);
    return `<table class="sc"><thead><tr><th>${half === 0 ? "Out" : "In"}</th>${idx.map(i => `<th class="${ed && i === hole ? "cur" : ""}" ${ed ? `data-act="hole" data-v="${i}"` : ""}>${i + 1}</th>`).join("")}<th>Tot</th></tr>
      <tr class="par"><td>Par</td>${idx.map(i => `<td>${card.pars[i]}</td>`).join("")}<td>${sum(idx.map(i => card.pars[i]))}</td></tr>
      <tr class="hcp"><td>Hcp</td>${idx.map(i => `<td>${si[i]}</td>`).join("")}<td></td></tr></thead>
      <tbody>${card.players.map(s => { const v = holeVals(card, s); const got = idx.filter(i => v[i] != null);
        const ch = cardCh(card, s), net = ch == null ? null : sum(got.map(i => v[i] - strokesOn(ch, si[i], n)));
        return `<tr><td>${dot(s)}${esc(pname(s).slice(0, 5))}${ch != null ? `<small class="sch">${ch}</small>` : ""}</td>${idx.map(i => `<td class="${pops[s][i] > 0 ? "pop" : ""} ${wins[i] === s ? "won" : ""}"><span class="${v[i] == null ? "" : scoreCls(v[i], card.pars[i])}">${v[i] ?? ""}</span></td>`).join("")}<td><b>${got.length ? sum(got.map(i => v[i])) : ""}</b>${got.length && net != null ? `<small class="snet">net ${net}</small>` : ""}</td></tr>`; }).join("")}${two ? (() => { let up = 0; const run = card.pars.map((_, i) => { if (wins[i] === undefined) return null; up += wins[i] === two.a ? 1 : wins[i] === two.b ? -1 : 0; return up; });
        return `<tr class="mrow"><td>Match</td>${idx.map(i => run[i] == null ? "<td></td>" : `<td><span class="ms" style="color:${run[i] ? pcolor(run[i] > 0 ? two.a : two.b) : "var(--muted)"}">${run[i] ? Math.abs(run[i]) : "AS"}</span></td>`).join("")}<td></td></tr>`; })() : ""}</tbody></table>`;
  };
  const hl = st.moments.filter(m => m.i < n || m.kind === "great");
  const highlights = hl.length ? `<section class="card"><h3>Highlights</h3><div class="moments">${hl.slice(0, 6).map(m => `<div class="mom ${m.kind}"><span class="mh2">${m.i < n ? m.i + 1 : "F"}</span>${esc(m.text)}</div>`).join("")}</div>
    ${hl.length > 6 ? `<details><summary class="muted small">Show all ${hl.length}</summary><div class="moments">${hl.slice(6).map(m => `<div class="mom ${m.kind}"><span class="mh2">${m.i < n ? m.i + 1 : "F"}</span>${esc(m.text)}</div>`).join("")}</div></details>` : ""}</section>` : "";

  const endBtn = ed ? `<div class="endwrap"><button class="endbtn" data-act="finish" data-id="${id}">${card.players.every(p => cardTotals(card, p).done) ? "Submit round" : "End round"}</button></div>` : "";
  const scard = `<section class="card"><h3>Scorecard</h3>${grid(0)}${grid(1)}
    <div class="legend2"><span><i class="sc-b"></i>birdie or better</span><span><i class="sc-o"></i>bogey or worse</span><span><i class="popk"></i>stroke hole</span><span>small number by a name = course handicap</span><span><i class="wonk"></i>won the hole</span></div></section>`;
  const scLinks = `<div class="ed acts center"><button class="link" data-act="cardsc" data-id="${id}">Edit scorecard</button><button class="link" data-act="card-del" data-id="${id}">Delete scorecard</button></div>`;
  const bets = betsBox(card);
  if (ed) {
    // Scoring view in tabs. Game (hole, map, scores, standings) is the default and stays put after
    // each score; tapping a hole on the scorecard jumps back to Game. Bets only when there are any.
    let tab = viewCard._tabFor === id ? viewCard._tab : "game";
    if (tab === "bets" && !bets) tab = "game";
    const tabs = [["game", "Game"], ["card", "Scorecard"], ...(bets ? [["bets", "Bets"]] : [])];
    const bar = `<div class="ctabs">${tabs.map(([k, l]) => `<button type="button" class="${k === tab ? "on" : ""}" data-act="ctab" data-v="${k}">${l}</button>`).join("")}</div>`;
    return bar + (tab === "card" ? scard + scLinks : tab === "bets" ? bets : entry + standings + endBtn);
  }
  return `${top + entry + endBtn}${highlights}${scard}${bets}${scLinks}`;
}
const scoreCls = (v, par) => v < par - 1 ? "sc-e" : v === par - 1 ? "sc-b" : v === par ? "sc-p" : v === par + 1 ? "sc-o" : "sc-d";
function firstOpenHole(card) {
  const n = card.pars.length;
  for (let i = 0; i < n; i++) if (card.players.some(s => holeVals(card, s)[i] == null)) return i;
  return n - 1;
}

const ADV_MS = 1600, HOLE_SETTLE_MS = 450;
function goHole(id, h) {
  viewCard._tab = "game"; viewCard._tabFor = id;
  clearTimeout(cardAction._adv); cardAction._advFor = null; cardAction._moved = Date.now();
  localStorage.setItem("golf_hole_" + id, h); render();
}
function cardAction(act, b) {
  if (act === "theme") { window.toggleTheme?.(); render(); return; }
  const id = state.cardId; const card = cardById(id); if (!card) return;
  // Right after the hole changes (a tap or the auto-advance), ignore taps for a moment so quick
  // taps meant for the old hole don't land on the new one or skip a hole.
  if ((act === "hole" || act === "sc") && Date.now() - (cardAction._moved || 0) < HOLE_SETTLE_MS) return;
  if (act === "hole") { goHole(id, Number(b.dataset.v)); return; }
  if (act === "ctab") { viewCard._tab = b.dataset.v; viewCard._tabFor = id; render(); scrollTo(0, 0); return; }
  if (!editing()) return phraseForm();
  if (act === "sc") {
    const s = b.dataset.s, d = Number(b.dataset.d);
    const hole = Number(localStorage.getItem("golf_hole_" + id) ?? firstOpenHole(card));
    // Pin the hole being scored. Without this, a phone that never stored a hole (card started on
    // another phone) follows "first open hole" and jumps the instant the last score goes in.
    localStorage.setItem("golf_hole_" + id, hole);
    const key = id + ":" + hole;
    const allIn = () => card.players.every(p => holeVals(card, p)[hole] != null);
    const wasIn = allIn(), armed = cardAction._advFor === key;
    const arr = holeVals(card, s); const par = card.pars[hole];
    let v = arr[hole];
    if (d === 0) v = v == null ? par : v; else v = Math.min(15, Math.max(1, (v ?? par) + d));
    arr[hole] = v; card.scores = { ...card.scores, [s]: arr };
    clearTimeout(cardAction._adv);
    // Auto-advance only when this tap fills the last empty score on the hole (or one is already
    // counting down, and this tap restarts it). Fixing a hole that was already complete stays put.
    cardAction._advFor = hole < card.pars.length - 1 && allIn() && (!wasIn || armed) ? key : null;
    render(); queueSave(card, s);
    if (cardAction._advFor === key) {
      cardAction._adv = setTimeout(() => {
        if (cardAction._advFor !== key) return;
        cardAction._advFor = null;
        if (state.tab !== "card" || state.cardId !== id || Number(localStorage.getItem("golf_hole_" + id) ?? hole) !== hole) return;
        goHole(id, hole + 1);
      }, ADV_MS);
    }
  }
  if (act === "par") {
    const h = Number(b.dataset.v); const p = card.pars[h];
    card.pars = card.pars.map((x, i) => i === h ? (p >= 5 ? 3 : p + 1) : x);
    render(); queueSave(card, "__pars");
  }
}

// ---------- edit scorecard (hole pars + hole handicaps) ----------
// Type what's printed on the paper card. Any unique handicap numbers work
// (a 9-hole card printed 1,3,5... gets ranked 1-9 automatically).
function scorecardForm({ title, sub, pars, sis, saveCourseOpt, onSave }) {
  const n = pars.length;
  const row = i => `<div class="sr"><span class="sh">${i + 1}</span>
    <div class="seg">${[3, 4, 5, 6].map(p => `<button type="button" class="${pars[i] === p ? "on" : ""}" data-h="${i}" data-p="${p}">${p}</button>`).join("")}</div>
    <input name="si${i}" inputmode="numeric" value="${sis?.[i] ?? ""}" aria-label="Hole ${i + 1} handicap"></div>`;
  const half = (a, b, lbl) => `<div class="sgrp"><div class="sr head"><span>${lbl}</span><span>Par</span><span>Hcp</span></div>${[...Array(b - a).keys()].map(k => row(a + k)).join("")}
    <div class="sr tot"><span>Total</span><span class="ptot" data-a="${a}" data-b="${b}"></span><span></span></div></div>`;
  openModal(`<h2>${esc(title)}</h2>${sub ? `<p class="hint">${esc(sub)}</p>` : ""}
    <form id="scf">
      <p class="hint">Copy par and handicap (HCP) for each hole from the scorecard. Leave handicaps blank if the card doesn't list them.</p>
      ${n === 18 ? half(0, 9, "Out") + half(9, 18, "In") : half(0, n, "Hole")}
      <div class="sr tot grand" ${n === 18 ? "" : "hidden"}><span>Par</span><span id="pgrand"></span><span></span></div>
      ${saveCourseOpt ? `<label class="chk"><input type="checkbox" name="tocourse" checked> Save to ${esc(saveCourseOpt)} for next time</label>` : ""}
      <div class="acts"><button class="primary" type="submit">Save scorecard</button></div>
    </form>`, m => {
    const f = $("#scf", m); const P = [...pars];
    const totals = () => { f.querySelectorAll(".ptot").forEach(el => el.textContent = P.slice(+el.dataset.a, +el.dataset.b).reduce((x, y) => x + y, 0)); $("#pgrand", m).textContent = P.reduce((x, y) => x + y, 0); };
    f.addEventListener("click", e => { const b = e.target.closest("[data-p]"); if (!b) return;
      P[+b.dataset.h] = +b.dataset.p; b.parentNode.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); totals(); });
    totals();
    f.onsubmit = async e => {
      e.preventDefault();
      const raw = P.map((_, i) => f["si" + i].value.trim());
      let S = null;
      if (raw.some(Boolean)) {
        if (raw.some(x => !x)) return toast("Fill every hole's handicap, or leave them all blank.");
        const nums = raw.map(Number);
        if (nums.some(x => !Number.isInteger(x) || x < 1 || x > 36)) return toast("Handicaps are whole numbers from the card.");
        if (new Set(nums).size !== n) return toast("Two holes have the same handicap. Check the card.");
        const sorted = [...nums].sort((a, b) => a - b);
        S = nums.map(x => sorted.indexOf(x) + 1);
      }
      const btn = f.querySelector("[type=submit]"); btn.disabled = true;
      try { await onSave(P, S, !!f.tocourse?.checked); closeModal(); await refresh(); toast("Scorecard saved."); }
      catch (err) { btn.disabled = false; toast("Couldn't save: " + errMsg(err)); }
    };
  });
}
// Save pars/handicaps onto every saved tee of a course.
async function saveCourseCard(name, pars, sis) {
  const rows = state.courses.filter(c => c.name === name);
  const par = pars.reduce((a, b) => a + b, 0);
  for (const c of rows) await save("courses", { pars, sis, par }, c.id);
}
function cardScorecard(id) {
  const card = cardById(id); if (!card) return;
  if (!editing()) return phraseForm(() => cardScorecard(id));
  const course = state.courses.find(c => c.name === card.course_name);
  const n = card.pars.length;
  scorecardForm({ title: "Edit scorecard", sub: card.course_name, pars: card.pars, sis: card.sis?.length === n ? card.sis : null,
    saveCourseOpt: course && (n === 18 || course.pars?.length === n || !course.pars) ? card.course_name : null,
    onSave: async (pars, sis, toCourse) => {
      await flushSaves();
      await save("cards", { pars, sis }, id);
      Object.assign(card, { pars, sis });
      if (toCourse) await saveCourseCard(card.course_name, pars, sis);
    } });
}
// ---------- round scorecards (hole by hole, read only) ----------
// Rounds posted from a live card keep hole_scores. Rounds of the same match (or same day,
// course and tee) are grouped into one scorecard. Pars come from the saved course.
function rscPars(r) {
  const n = r.hole_scores?.length;
  const c = state.courses.find(x => x.id === r.course_id && x.pars?.length === n)
    || state.courses.find(x => x.name === r.course_name && x.pars?.length === n);
  return c ? c.pars : null;
}
function rscGroups(slug) {
  const groups = {};
  for (const r of state.rounds) {
    if (!r.hole_scores?.length) continue;
    const k = r.match_id || roundKey(r);
    (groups[k] ||= { key: k, played_on: r.played_on, course_name: r.course_name, tee_name: r.tee_name, rounds: [] }).rounds.push(r);
  }
  // Guests ride along on the family's scorecard for that round (never a card of their own).
  for (const r of state.guestRounds) {
    if (!r.hole_scores?.length) continue;
    groups[r.match_id || roundKey(r)]?.rounds.push(r);
  }
  const order = s => { const i = PLAYERS.findIndex(p => p.slug === s); return i < 0 ? 99 : i; };
  return Object.values(groups)
    .filter(g => !slug || g.rounds.some(r => r.player === slug))
    .map(g => ({ ...g, solo: g.rounds.length === 1 && isSoloRound(g.rounds[0]), rounds: g.rounds.sort((a, b) => (b.player === slug) - (a.player === slug) || order(a.player) - order(b.player)) }))
    .sort((a, b) => b.played_on.localeCompare(a.played_on) || String(b.rounds[0].created_at || "").localeCompare(String(a.rounds[0].created_at || "")));
}
function roundScorecardsSection(slug) {
  const gs = rscGroups(slug).filter(g => slug || !g.solo); // solo rounds live on the player's tab only
  const row = g => `<button type="button" class="rscrow" data-act="rsc" data-id="${g.rounds.find(r => r.player === slug)?.id || g.rounds[0].id}">
      <span class="rscw"><b>${fmtShort(g.played_on)}</b> <span class="muted">${g.played_on.slice(0, 4)}</span> · ${esc(g.course_name)}${g.tee_name ? `<span class="tee">${esc(g.tee_name)}</span>` : ""}
        <span class="rscp">${g.rounds.map(r => `<span>${dot(r.player)}${esc(pname(r.player))} <b>${r.score}</b></span>`).join("")}${g.solo ? `<span class="tag">solo</span>` : ""}</span></span>
      <span class="rscgo">View ›</span></button>`;
  const first = gs.slice(0, 5).map(row).join(""), rest = gs.slice(5).map(row).join("");
  return `<section class="card"><h3>Scorecards <span class="muted small">${gs.length}</span></h3>
    ${gs.length ? `${first}${rest ? `<details><summary class="muted small">Show all ${gs.length}</summary>${rest}</details>` : ""}` : `<div class="empty">No hole-by-hole scorecards yet.</div>`}
    <p class="hint">Rounds scored on a live scorecard show here hole by hole. Rounds posted as a final score only don't have one.</p></section>`;
}
function roundScorecardView(id) {
  const r0 = state.rounds.find(r => r.id === id); if (!r0) return;
  const g = rscGroups().find(x => x.rounds.some(r => r.id === id)); if (!g) return;
  const rounds = [r0, ...g.rounds.filter(r => r.id !== id)];
  const n = Math.max(...rounds.map(r => r.hole_scores.length));
  const pars = rscPars(r0);
  const sum = arr => arr.reduce((a, b) => a + (b ?? 0), 0);
  const grid = half => {
    const idx = half === 0 ? [...Array(Math.min(9, n)).keys()] : [...Array(Math.max(0, n - 9)).keys()].map(i => i + 9);
    if (!idx.length) return "";
    return `<table class="sc"><thead><tr><th>${half === 0 ? "Out" : "In"}</th>${idx.map(i => `<th>${i + 1}</th>`).join("")}<th>Tot</th></tr>
      ${pars ? `<tr class="par"><td>Par</td>${idx.map(i => `<td>${pars[i]}</td>`).join("")}<td>${sum(idx.map(i => pars[i]))}</td></tr>` : ""}</thead>
      <tbody>${rounds.map(r => { const v = r.hole_scores, got = idx.filter(i => v[i] != null);
        return `<tr><td>${dot(r.player)}${esc(pname(r.player).slice(0, 5))}</td>${idx.map(i => `<td><span class="${v[i] == null || !pars ? "" : scoreCls(v[i], pars[i])}">${v[i] ?? "–"}</span></td>`).join("")}<td><b>${got.length ? sum(got.map(i => v[i])) : ""}</b></td></tr>`; }).join("")}</tbody></table>`;
  };
  const totals = rounds.map(r => `<div class="mpr"><span>${dot(r.player)}${esc(pname(r.player))}</span><b>${r.score} <span class="muted">${toPar(r.score, r.par)}${r.points != null ? ` · ${r.points} pts` : ""}</span></b></div>`).join("");
  openModal(`<h2>${esc(g.course_name)}</h2>
    <p class="muted small rscsub">${fmtDate(g.played_on)}${g.tee_name ? ` · ${esc(g.tee_name)} tees` : ""}${pars ? ` · par ${sum(pars)}` : ""}${r0.match_id ? " · match" : g.solo ? " · solo" : ""}</p>
    ${grid(0)}${grid(1)}
    ${pars ? `<div class="legend2"><span><i class="sc-b"></i>birdie or better</span><span><i class="sc-o"></i>bogey or worse</span></div>` : `<p class="hint">No hole pars saved for this course, so holes aren't marked.</p>`}
    <div class="mpl">${totals}</div>`);
}

// ---------- guests (saved in a hidden list, picked or added at round start) ----------
// Handicap typed like the card: "12.4", or "+2" for a plus handicap (stored as -2).
function parseHcp(raw) {
  const t = String(raw ?? "").trim(); if (!t) return { v: null };
  const v = t.startsWith("+") ? -Number(t.slice(1)) : Number(t);
  if (isNaN(v) || v < -10 || v > 54) return { err: "Handicap is a number from +10 to 54." };
  return { v: r1(v) };
}
const guestRoundCount = slug => state.guestRounds.filter(r => r.player === slug).length;
// The guest list on a start form: pick a saved guest or add a new one, and say if they're in the money.
function guestPicker() {
  const saved = [...state.guests].sort((a, b) => guestName(a).localeCompare(guestName(b)));
  return `<div class="gpicker"><div class="laylbl">Guests</div>
    <div class="glist"></div>
    <select name="g_pick" aria-label="Add a guest"><option value="">+ Add a guest</option>${saved.map(g => `<option value="${g.id}">${esc(guestName(g))} · hcp ${fmtIdx(g.handicap)}</option>`).join("")}<option value="new">New guest…</option></select>
    <div class="gnew" hidden>
      <div class="row2"><label>First name<input name="g_first" autocomplete="off" autocapitalize="words"></label><label>Last name<input name="g_last" autocomplete="off" autocapitalize="words"></label></div>
      <label>Handicap<input name="g_hcp" inputmode="decimal" placeholder="e.g. 14.2"></label>
      <label class="chk"><input type="checkbox" name="g_money"> In the money</label>
      <div class="acts"><button type="button" class="primary" data-g="add">Add to round</button><button type="button" data-g="cancel">Cancel</button></div>
    </div>
    <p class="hint">Guests play the game on the card. Tick In the money to put them in the bets too. Guests never count in head to head, Master Champ or money totals.</p></div>`;
}
// Returns { commit } once wired: commit() saves new or changed guests and returns { slugs, meta }.
function wireGuestPicker(root, onChange) {
  const box = root.querySelector(".gpicker"); if (!box) return null;
  const q = n => box.querySelector(`[name=${n}]`);
  const list = []; // { id, first, last, hcp, money }
  let adding = null; // saved guest id being added, or "new"
  const paint = () => {
    box.querySelector(".glist").innerHTML = list.map((g, i) => `<div class="grow"><span class="gname">${dot("g_x")}${esc([g.first, g.last].filter(Boolean).join(" "))} <small class="muted">hcp ${fmtIdx(g.hcp)}</small></span>
      <label class="chk gm"><input type="checkbox" data-gm="${i}" ${g.money ? "checked" : ""} aria-label="${esc(g.first)} in the money"> Money</label>
      <button type="button" class="link" data-g="rm" data-i="${i}" aria-label="Remove ${esc(g.first)}">✕</button></div>`).join("");
    [...q("g_pick").options].forEach(o => { if (o.value && o.value !== "new") o.hidden = list.some(g => g.id === o.value); });
    onChange?.(list.filter(g => g.money).length);
  };
  const close = () => { adding = null; box.querySelector(".gnew").hidden = true; q("g_pick").value = ""; q("g_pick").hidden = false; };
  q("g_pick").onchange = () => {
    const v = q("g_pick").value; if (!v) return;
    const g = v === "new" ? null : state.guests.find(x => x.id === v);
    adding = v;
    q("g_first").value = g?.first_name || ""; q("g_last").value = g?.last_name || ""; q("g_hcp").value = g ? (g.handicap == null ? "" : fmtIdx(g.handicap)) : ""; q("g_money").checked = false;
    q("g_pick").hidden = true; box.querySelector(".gnew").hidden = false;
    if (!g) q("g_first").focus();
  };
  const add = () => {
    const first = q("g_first").value.trim(), last = q("g_last").value.trim();
    if (!first) return toast("Type the guest's first name.");
    const h = parseHcp(q("g_hcp").value); if (h.err) return toast(h.err);
    if (h.v == null) return toast("Type the guest's handicap (0 if they don't have one).");
    list.push({ id: adding === "new" ? null : adding, first, last, hcp: h.v, money: q("g_money").checked });
    close(); paint();
  };
  box.addEventListener("click", e => {
    const b = e.target.closest("[data-g]"); if (!b) return;
    if (b.dataset.g === "add") add();
    if (b.dataset.g === "cancel") close();
    if (b.dataset.g === "rm") { list.splice(Number(b.dataset.i), 1); paint(); }
  });
  box.addEventListener("change", e => { const s = e.target.closest("[data-gm]"); if (s) { list[Number(s.dataset.gm)].money = s.checked; paint(); } });
  box.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.closest(".gnew")) { e.preventDefault(); add(); } });
  paint();
  return {
    count: () => list.length,
    pending: () => adding != null,
    async commit() {
      const meta = {}, slugs = [];
      for (const g of list) {
        const row = { first_name: g.first, last_name: g.last || null, handicap: g.hcp };
        const old = g.id && state.guests.find(x => x.id === g.id);
        if (!old) { g.id = await save("guests", row); }
        else if (old.first_name !== row.first_name || (old.last_name || null) !== row.last_name || old.handicap !== row.handicap) { await save("guests", row, g.id); Object.assign(old, row); }
        const slug = "g_" + g.id, name = [g.first, g.last].filter(Boolean).join(" ");
        GUESTS[slug] = { name, hcp: g.hcp };
        meta[slug] = { name, hcp: g.hcp, money: g.money };
        slugs.push(slug);
      }
      return { slugs, meta };
    }
  };
}
// Head to Head: the saved guests (collapsed, so the page stays about the family).
function guestsSection() {
  const gs = [...state.guests].sort((a, b) => guestName(a).localeCompare(guestName(b)));
  return `<section class="card"><details><summary><h3 class="inl">Guests</h3> <span class="muted small">${gs.length}</span></summary>
    ${gs.map(g => { const n = guestRoundCount("g_" + g.id);
      return `<div class="crow"><div><b>${esc(guestName(g))}</b><div class="muted small">hcp ${fmtIdx(g.handicap)} · ${n} round${n === 1 ? "" : "s"}</div></div>
        <button class="link ed" data-act="guest" data-id="${g.id}">Edit</button></div>`; }).join("") || `<div class="empty">No guests yet.</div>`}
    <div class="ed acts"><button type="button" data-act="guest" data-id="">+ Add a guest</button></div>
    <p class="hint">Add guests here or when you start a scorecard. They show on the live card and scorecards only, never in head to head, Master Champ, handicaps or money totals.</p></details></section>`;
}
function guestForm(id) {
  if (!editing()) return phraseForm(() => guestForm(id));
  const g = id ? state.guests.find(x => x.id === id) : null;
  if (id && !g) return;
  openModal(`<h2>${g ? "Edit guest" : "Add a guest"}</h2>
    <form id="gf2">
      <div class="row2"><label>First name<input name="first" value="${esc(g?.first_name || "")}" required autocomplete="off" autocapitalize="words"></label>
      <label>Last name<input name="last" value="${esc(g?.last_name || "")}" autocomplete="off" autocapitalize="words"></label></div>
      <label>Handicap<input name="hcp" inputmode="decimal" value="${g?.handicap == null ? "" : fmtIdx(g.handicap)}" placeholder="e.g. 14.2" required></label>
      <p class="hint">Their handicap stays what you type. It doesn't move with their scores.</p>
      <div class="acts"><button class="primary" type="submit">Save</button>${g ? `<button type="button" class="danger" id="gdel">Delete guest</button>` : ""}</div>
    </form>`, m => {
    const f = $("#gf2", m);
    f.onsubmit = async e => {
      e.preventDefault();
      const first = f.first.value.trim(), last = f.last.value.trim();
      if (!first) return toast("Type a first name.");
      const h = parseHcp(f.hcp.value); if (h.err) return toast(h.err);
      if (h.v == null) return toast("Type a handicap (0 if they don't have one).");
      try { await save("guests", { first_name: first, last_name: last || null, handicap: h.v }, g?.id); closeModal(); await refresh(); toast("Guest saved."); }
      catch (err) { toast("Couldn't save: " + errMsg(err)); }
    };
    $("#gdel", m)?.addEventListener("click", async () => {
      if (!confirm(`Delete ${guestName(g)}? Their old scorecards stay.`)) return;
      try { await remove("guests", g.id); closeModal(); await refresh(); toast("Guest deleted."); }
      catch (err) { toast("Couldn't delete: " + errMsg(err)); }
    });
  });
}

// ---------- start match: pick tees, then straight to the Live tab ----------
function startMatch(mt) {
  if (!mt) return;
  if (!editing()) return phraseForm(() => startMatch(mt));
  const existing = cardForMatch(mt.id);
  if (existing) { location.hash = "card/" + existing.id; return; }
  const tees = state.courses.filter(c => mt.course_name && c.name === mt.course_name).sort((a, b) => b.rating - a.rating);
  if (!tees.length) return cardForm(mt); // course not saved yet: full form (course, tees, ratings)
  let pick = tees.find(t => t.tee_name === mt.tee_name) || tees[Math.floor(tees.length / 2)];
  const has18 = tees[0].pars?.length !== 9;
  const multi = mt.players.length > 1;
  const initGame = mt.scoring === "gross" ? "stroke" : (mt.scoring || "match");
  openModal(`<div class="step1"><h2>Start match</h2>
    <p class="hint">${esc(mt.course_name)} · ${mt.players.map(pname).map(esc).join(" vs ")}</p>
    <div class="laylbl">What tees are you playing?</div>
    <div class="teepick">${tees.map(t => `<button type="button" class="teeopt ${t.id === pick.id ? "on" : ""}" data-tee="${t.id}"><b>${esc(t.tee_name || "Tees")}</b><span>${t.rating}/${t.slope}</span></button>`).join("")}</div>
    ${has18 ? `<div class="laylbl">Holes</div><div class="seg2"><button type="button" class="on" data-holes="18">18</button><button type="button" data-holes="9">Front 9</button></div>` : ""}
    <div id="smstrokes" class="hint"></div>
    ${guestPicker()}
    <div class="smbets" ${multi ? "" : "hidden"}><div class="laylbl">Bets</div>${betFields(mt.bets === undefined ? BET_DEFAULT : mt.bets, has18 ? 18 : 9)}</div>
    ${gameSelectHtml(initGame)}
    <div class="acts"><button class="primary big" id="teeoff">Check scorecard ›</button></div>
    <p class="muted small">Not the right course? <button class="link" id="smfull">Change course or players</button></p></div>`, m => {
    let holes = has18 ? 18 : 9, game = initGame, betsOn = multi;
    const syncBets = wireBets(m, holes);
    const gpick = wireGuestPicker(m, money => { betsOn = mt.players.length + money > 1; m.querySelector(".smbets").hidden = !betsOn; });
    const preview = () => {
      if (game === "stroke" || game === "gross") { $("#smstrokes", m).textContent = "Gross stroke play: playing straight up, no strokes."; return; }
      const c = { rating: pick.rating, slope: pick.slope, par: pick.par };
      const chs = Object.fromEntries(mt.players.map(s => [s, roundCh(currentIndex(s).index, c, holes)]));
      const vals = Object.values(chs).filter(x => x != null);
      if (vals.length < mt.players.length) { $("#smstrokes", m).textContent = ""; return; }
      const low = Math.min(...vals);
      $("#smstrokes", m).textContent = mt.players.map(s => chs[s] - low > 0 ? `${pname(s)} gets ${chs[s] - low}` : null).filter(Boolean).join(" · ") || "Everyone plays level.";
    };
    m.querySelector(".teepick").onclick = e => { const b = e.target.closest("[data-tee]"); if (!b) return;
      pick = tees.find(t => t.id === b.dataset.tee); m.querySelectorAll(".teeopt").forEach(x => x.classList.toggle("on", x === b)); preview(); };
    const seg = m.querySelector(".seg2"); if (seg) seg.onclick = e => { const b = e.target.closest("[data-holes]"); if (!b) return;
      holes = Number(b.dataset.holes); seg.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); preview(); syncBets?.(holes); };
    const gsel = m.querySelector("[name=game]");
    if (gsel) gsel.onchange = () => { game = gsel.value; preview(); };
    $("#smfull", m).onclick = () => cardForm(mt);
    preview();
    $("#teeoff", m).onclick = async () => {
      const n = holes;
      if (gpick.pending()) return toast("Tap Add to round for the guest first, or Cancel.");
      const bets = betsOn ? readBets(m, n) : null; if (bets === false) return;
      let gx;
      try { gx = await gpick.commit(); } catch (err) { return toast("Couldn't save the guest: " + errMsg(err)); }
      const allPlayers = [...mt.players, ...gx.slugs];
      const pars = pick.pars?.length >= n ? pick.pars.slice(0, n) : Array(n).fill(4);
      let sis = null;
      if (pick.sis?.length === 18) { const s9 = pick.sis.slice(0, n); sis = n === 9 ? s9.map(x => s9.filter(y => y < x).length + 1) : pick.sis; }
      else if (pick.sis?.length === n) sis = pick.sis;
      confirmCard(m, $(".step1", m), { course_name: pick.name, tee_name: pick.tee_name, rating: pick.rating, slope: pick.slope, par: pick.par,
        pars, sis, parsKnown: pick.pars?.length >= n, players: allPlayers, guests: gx.meta, saveName: pick.name, game,
        betsLine: bets ? stakesText(bets, n) : betsOn ? "No money" : "" },
        async (pars, sis, toCourse, hcpOv) => {
          if (toCourse) await saveCourseCard(pick.name, pars, sis);
          const sc = dbScoring(game);
          await save("matches", { course_id: pick.id, tee_name: pick.tee_name, rating: pick.rating, slope: pick.slope, par: pick.par, scoring: sc, bets }, mt.id);
          const meta = { game, ...(Object.keys(hcpOv || {}).length ? { hcp: hcpOv } : {}), ...(gx.slugs.length ? { guests: gx.meta } : {}) };
          const id = await save("cards", { played_on: today(), course_id: pick.id, course_name: pick.name, tee_name: pick.tee_name,
            rating: pick.rating, slope: pick.slope, par: pick.par, pars, sis, players: allPlayers, scores: { __meta: meta }, match_id: mt.id,
            scoring: sc, status: "live", bets });
          localStorage.setItem("golf_hole_" + id, "0");
          closeModal(); await loadData(); location.hash = "card/" + id;
        });
    };
  });
}

// solo = a player's slug: a round for just that player, started from their tab. Same flow, but no match,
// no bets, no guests and stroke play; it counts toward their handicap and nothing else.
function cardForm(fromMatch, solo) {
  if (!editing()) return phraseForm(() => cardForm(fromMatch, solo));
  if (solo) fromMatch = null;
  const todays = solo ? [] : state.matches.filter(m => m.status === "scheduled" && Math.abs(daysBetween(today(), m.scheduled_for)) <= 1);
  const m0 = fromMatch || (todays.length === 1 ? todays[0] : null);
  const v = m0 ? { ...m0, ...(state.courses.find(c => c.id === m0.course_id) || {}), course_name: m0.course_name } : {};
  openModal(`<div class="step1"><h2>${solo ? `${dot(solo)}${esc(pname(solo))}'s solo round` : "Start a scorecard"}</h2>
    ${solo ? `<p class="hint">Just ${esc(pname(solo))}. It goes on ${esc(pname(solo))}'s tab and counts toward the handicap, but not head to head, Master Champ or money.</p>` : ""}
    <form id="cf">
      ${todays.length || fromMatch ? `<label>Match<select name="match"><option value="">Not a match</option>${[...new Set([...(fromMatch ? [fromMatch] : []), ...todays])].map(m => `<option value="${m.id}" ${m0 && m.id === m0.id ? "selected" : ""}>${fmtShort(m.scheduled_for)} · ${esc(m.course_name || "match")} · ${m.players.map(pname).join(", ")}</option>`).join("")}</select></label>` : ""}
      ${solo ? `<input type="checkbox" name="pl" value="${solo}" checked hidden>` : `<fieldset><legend>Who's playing</legend>${PLAYERS.map(p => `<label class="chk"><input type="checkbox" name="pl" value="${p.slug}" ${(m0 ? m0.players : PLAYERS.map(x => x.slug)).includes(p.slug) ? "checked" : ""}> ${dot(p.slug)}${esc(p.name)}</label>`).join("")}</fieldset>
      ${guestPicker()}`}
      <div class="row2"><label>Date<input type="date" name="played_on" value="${today()}" required></label>
      <label>Holes<select name="holes"><option>18</option><option>9</option></select></label></div>
      ${courseFields(v)}
      ${solo ? `<input type="hidden" name="game" value="stroke">` : `<div class="laylbl">Bets</div>${betFields(m0?.bets === undefined ? BET_DEFAULT : m0.bets, 18)}
      ${gameSelectHtml(m0?.scoring === "gross" ? "stroke" : (m0?.scoring || "match"))}`}
      <div class="acts"><button class="primary" type="submit">Check scorecard ›</button></div>
    </form></div>`, m => {
    const f = $("#cf", m); wireCoursePicker(f);
    const syncBets = wireBets(f, 18) || (() => {});
    const gpick = wireGuestPicker(f) || { pending: () => false, commit: async () => ({ slugs: [], meta: {} }) };
    f.holes.onchange = () => syncBets(Number(f.holes.value));
    if (f.match) f.match.onchange = () => {
      const mt = state.matches.find(x => x.id === f.match.value); if (!mt) return;
      f.querySelectorAll("[name=pl]").forEach(x => x.checked = mt.players.includes(x.value));
      if (f.game && mt.scoring) f.game.value = mt.scoring === "gross" ? "stroke" : mt.scoring;
      if (mt.course_name) { const c = state.courses.find(c => c.id === mt.course_id) || mt;
        const nm = splitName(mt.course_name); f.course_name.value = nm.base; f.layout.value = nm.layout; renderLayouts(f);
        f.tee_name.value = mt.tee_name || ""; f.rating.value = mt.rating ?? ""; f.slope.value = mt.slope ?? ""; f.par.value = mt.par ?? "";
        f.pars.value = c.pars ? JSON.stringify(c.pars) : ""; f.sis.value = c.sis ? JSON.stringify(c.sis) : ""; }
    };
    f.onsubmit = async e => {
      e.preventDefault();
      const c = readCourse(f); const n = Number(f.holes.value);
      const players = [...f.querySelectorAll("[name=pl]:checked")].map(x => x.value);
      if (!players.length) return toast("Pick who's playing.");
      if (!c.course_name) return toast("Pick or type the course.");
      if (gpick.pending()) return toast("Tap Add to round for the guest first, or Cancel.");
      let pars = c.pars?.length === 18 ? (n === 9 ? c.pars.slice(0, 9) : c.pars) : c.pars?.length === 9 && n === 9 ? c.pars : Array(n).fill(4);
      // 9 holes from an 18-hole card: rank those 9 holes by their 18-hole handicaps.
      let sis = null;
      if (c.sis?.length === 18) { const s9 = c.sis.slice(0, n); sis = n === 9 ? s9.map(x => s9.filter(y => y < x).length + 1) : c.sis; }
      else if (c.sis?.length === n) sis = c.sis;
      const mt = state.matches.find(x => x.id === f.match?.value);
      const game = f.game?.value || "match";
      // Guests in the money join the game and the bets; guests who aren't just keep score.
      const moneyGuests = () => f.querySelectorAll(".gpicker [data-gm]:checked").length;
      const inPlay = players.length + moneyGuests();
      const bets = inPlay > 1 ? readBets(f, n) : null; if (bets === false) return;
      const known = c.pars?.length === n || (c.pars?.length === 18 && n === 9);
      let gx;
      try { gx = await gpick.commit(); } catch (err) { return toast("Couldn't save the guest: " + errMsg(err)); }
      confirmCard(m, $(".step1", m), { course_name: c.course_name, tee_name: c.tee_name, rating: c.rating, slope: c.slope, par: c.par,
        pars, sis, parsKnown: known, players: [...players, ...gx.slugs], guests: gx.meta, game, solo: !!solo, saveName: state.courses.some(x => x.name === c.course_name) || (c.rating && c.slope && c.par) ? c.course_name : null,
        betsLine: bets ? stakesText(bets, n) : inPlay > 1 ? "No money" : "" },
        async (pars, sis, toCourse, hcpOv) => {
          const course_id = c.rating && c.slope && c.par ? await ensureCourse({ ...c, name: c.course_name, ...(toCourse ? { pars, sis } : {}) }) : null;
          if (toCourse) await saveCourseCard(c.course_name, pars, sis);
          const sc = dbScoring(game);
          const meta = { game, ...(Object.keys(hcpOv || {}).length ? { hcp: hcpOv } : {}), ...(gx.slugs.length ? { guests: gx.meta } : {}), ...(solo ? { solo: true } : {}) };
          const row = { played_on: f.played_on.value, course_id, course_name: c.course_name, tee_name: c.tee_name, rating: c.rating, slope: c.slope,
            par: c.par, pars, sis, players: [...players, ...gx.slugs], scores: { __meta: meta }, match_id: f.match?.value || null, scoring: sc, status: "live", bets };
          const id = await save("cards", row);
          if (mt) await save("matches", { scoring: sc, bets }, mt.id);
          localStorage.setItem("golf_hole_" + id, "0");
          closeModal(); await loadData(); location.hash = "card/" + id;
        });
    };
  });
}

function finishForm(id) {
  const card = cardById(id); if (!card) return;
  const n = card.pars.length; const parSum = card.pars.reduce((a, b) => a + b, 0);
  const rows = card.players.map(s => ({ s, t: cardTotals(card, s) }));
  const bet = settleBets(card);
  openModal(`<h2>Submit round</h2><p class="hint">${esc(card.course_name)} · ${fmtDate(card.played_on)}</p>
    <form id="ff">
      ${courseFields({ ...card, par: n === 18 ? parSum : card.par || parSum })}
      <div class="board">${rows.map(x => `<div class="br"><span>${dot(x.s)}${esc(pname(x.s))}</span><span class="n">${x.t.done ? `<b>${x.t.gross}</b> ${fmtToPar(x.t.toPar)} · ${cardPts(card, x.s).pts} pts` : `<span class="warnt">${x.t.thru}/${n} holes, won't be posted</span>`}</span></div>`).join("")}</div>
      ${card.players.length > 1 ? `<div class="mpl">${cardPairs(card).map(pr => `<div class="mpr"><span>${esc(pname(pr.a))} v ${esc(pname(pr.b))}</span><b>${esc(pr.text)}</b></div>`).join("")}</div>` : ""}
      ${bet ? `<div class="cbets"><span>Money</span><b>${bet.pays.length ? paysText(bet.pays) : "Nobody pays"}</b></div>${bet.done ? "" : `<p class="hint">${bet.pot ? "The pot only pays once everyone in it finishes every hole, so it pushes." : "Bets that didn't finish push."}</p>`}` : ""}
      <p class="hint">Each finished score goes on that player's round log${card.match_id ? " and the match gets its result" : ""}.${n === 9 ? " 9-hole rounds don't count toward handicaps." : ""}${card.players.some(isGuest) ? " Guests go on the scorecard only." : ""}</p>
      <div class="acts"><button class="primary" type="submit">Submit round</button><button type="button" data-close>Keep playing</button></div>
    </form>`, m => {
    const f = $("#ff", m); wireCoursePicker(f);
    f.onsubmit = async e => {
      e.preventDefault();
      const c = readCourse(f);
      if (!c.rating || !c.slope || !c.par) return toast("Rating, slope, and par are needed for handicaps.");
      const done = rows.filter(x => x.t.done);
      if (!done.length) { if (confirm("Nobody has every hole scored, so nothing gets posted. End this round anyway?")) { try { await save("cards", { status: "done" }, id); closeModal(); await loadData(); location.hash = cardSolo(card) || "h2h"; toast("Round ended."); } catch (err) { toast(errMsg(err)); } } return; }
      const btn = f.querySelector("[type=submit]"); btn.disabled = true;
      try {
        await flushSaves();
        const course_id = await ensureCourse({ ...c, name: c.course_name, pars: n === 18 ? card.pars : null, sis: n === 18 && card.sis?.length === 18 ? card.sis : null });
        // Money needs a match to live on: make one for a card that wasn't started from a scheduled round.
        // Matches only list the family (guests stay out of head to head); guest money rides in bets.result.
        const fam = card.players.filter(s => !isGuest(s)), famDone = done.filter(x => !isGuest(x.s));
        let matchId = card.match_id || null;
        if (!matchId && bet && famDone.length >= 2) {
          matchId = await save("matches", { scheduled_for: card.played_on, course_id, course_name: c.course_name, tee_name: c.tee_name, rating: c.rating, slope: c.slope, par: c.par,
            players: fam, status: "scheduled", scoring: card.scoring || "match", title_match: false });
          await save("cards", { match_id: matchId }, id); card.match_id = matchId;
        }
        for (const x of done) {
          const cc = { ...card, rating: c.rating, slope: c.slope, par: c.par };
          await save("rounds", { player: x.s, played_on: card.played_on, holes: n, score: x.t.gross, hole_scores: holeVals(card, x.s), points: cardPts(cc, x.s).pts,
            course_name: c.course_name, tee_name: c.tee_name, rating: c.rating, slope: c.slope, par: n === 9 && c.par >= 50 ? parSum : c.par, course_id, match_id: matchId,
            ...(isGuest(x.s) ? { notes: "Guest: " + pname(x.s) } : {}) });
        }
        const gNames = Object.fromEntries(card.players.filter(isGuest).map(s => [s, { name: pname(s) }]));
        if (matchId && famDone.length >= 2) await save("matches", { status: "final", course_name: c.course_name, tee_name: c.tee_name, rating: c.rating, slope: c.slope, par: c.par, course_id,
          bets: bet ? { ...card.bets, result: { pays: bet.pays, net: bet.net, ...(Object.keys(gNames).length ? { guests: gNames } : {}) } } : null }, matchId);
        await save("cards", { status: "done" }, id);
        closeModal(); await loadData(); location.hash = cardSolo(card) || "h2h"; toast("Round posted.");
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
  openModal(`<h2>Add</h2><div class="acts col"><button class="primary" data-go="card">Start a live scorecard</button><button data-go="round">Post a final score</button><button data-go="match">Schedule a round</button><button data-go="photo">Add photos</button></div>`, m => {
    m.querySelector("[data-go=photo]").onclick = () => photoForm();
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
  else if (h === "live" || (!h && state.cards.length)) { state.tab = "card"; state.cardId = state.cards[0]?.id || null; }
  else state.tab = P[h] || h === "h2h" || h === "gallery" ? h : "h2h";
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
  if (act === "solo-start") cardForm(null, id);
  if (act === "start-card") cardForm(state.matches.find(m => m.id === id));
  if (act === "start-match") startMatch(state.matches.find(m => m.id === id));
  if (act === "finish") finishForm(id);
  if (act === "cardsc") cardScorecard(id);
  if (act === "bets") betsForm(id);
  if (act === "add-photo") photoForm();
  if (act === "photo") photoView(id, viewGallery.course);
  if (act === "gcourse") { viewGallery.course = b.dataset.v || null; render(); }
  if (act === "press") pressForm(id);
  if (act === "unpress") unpress(id, Number(b.dataset.v));
  if (act === "money") moneyForm(state.matches.find(m => m.id === id));
  if (act === "guest") guestForm(id || null);
  if (act === "rsc") roundScorecardView(id);
  if (act === "card-del") { if (confirm("Delete this scorecard? Scores on it are lost.")) remove("cards", id).then(async () => { await loadData(); location.hash = "h2h"; toast("Deleted."); }).catch(err => toast(errMsg(err))); }
  if (["hole", "sc", "par", "theme", "ctab"].includes(act)) cardAction(act, b);
  if (act === "yds") ydToggle();
});
// Keep the Strokes section open or closed while the live card redraws.
document.addEventListener("toggle", e => { if (e.target.classList?.contains("strokesd")) viewCard._strokes = e.target.open; }, true);
document.addEventListener("change", e => {
  if (e.target.id === "calcCourse") {
    const c = state.courses.find(x => x.id === e.target.value);
    $("#calcOut").innerHTML = strokesLine(c, PLAYERS.map(p => p.slug));
  }
});

// The turtle shell above the title. Deliberately unlabeled: no cursor, no hint, nothing on screen.
// One tap: full fresh reload (drops the offline copy first). Double tap: switch white and purple mode.
// The single tap waits a beat so a second tap can cancel the reload.
const SHELL_DOUBLE_MS = 350;
let shellTimer = null;
document.addEventListener("click", e => {
  const h = e.target.closest && e.target.closest("header h1#title");
  if (!h || !h.querySelector(".tw")) return;
  const tw = h.querySelector(".tw").getBoundingClientRect();
  if (e.clientY >= tw.top) return; // only the shell, which sits above "THE"
  if (shellTimer) { clearTimeout(shellTimer); shellTimer = null; window.toggleTheme?.(); return; }
  shellTimer = setTimeout(() => {
    shellTimer = null;
    (window.caches ? caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k)))) : Promise.resolve())
      .catch(() => {}).then(() => location.reload());
  }, SHELL_DOUBLE_MS);
});
(async function init() {
  document.title = CFG.siteTitle;
  // "The" sits small and centered above the name
  const tm = /^the\s+/i.test(CFG.siteTitle) ? CFG.siteTitle.replace(/^the\s+/i, "") : null;
  if (tm) $("#title").innerHTML = `<span class="tw"><small class="the">The</small><span>${esc(tm)}</span></span>`;
  else $("#title").textContent = CFG.siteTitle;
  $("#tagline").textContent = CFG.tagline || "";
  renderTabs();
  $("#lockbtn").onclick = () => { if (confirm("Lock this phone? You'll need the family phrase to get back in.")) lock(); };
  $("#gf").onsubmit = async e => {
    e.preventDefault();
    const f = e.target, p = f.p.value.trim(), btn = f.querySelector("button"), msg = $("#gmsg");
    if (!p) return;
    btn.disabled = true; msg.textContent = "";
    for (let i = 0; i < 40 && !DEMO && !sb; i++) await new Promise(r => setTimeout(r, 100)); // database client still loading
    try { if (!(await unlock(p))) { msg.textContent = "That's not it."; f.p.select(); } else f.p.value = ""; }
    catch (err) { msg.textContent = /too many|locked/i.test(errMsg(err)) ? errMsg(err) : "Couldn't check right now. Try again."; }
    btn.disabled = false;
  };
  if (DEMO) $("#demo").hidden = false;
  else {
    const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
    sb = createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  $("#fab").onclick = addMenu;
  // White (sand) mode by default; double-tap the shell for purple mode. Choice saved per phone.
  const themeNow = () => document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const setThemeColor = hex => {
    // Re-inserting the meta tag forces iOS standalone PWA to repaint the very top bar immediately.
    document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.remove());
    const m = document.createElement("meta");
    m.name = "theme-color";
    m.content = hex;
    document.head.appendChild(m);
  };
  const paintTheme = () => {
    const t = themeNow();
    setThemeColor(t === "light" ? "#c3b090" : "#53275a");
    document.documentElement.style.backgroundColor = t === "light" ? "#dfd3be" : "#150c17";
  };
  window.toggleTheme = () => {
    const next = themeNow() === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("golf_mode", next); } catch (e) { /* private mode */ }
    paintTheme();
  };
  paintTheme();
  window.addEventListener("hashchange", route);
  let rz = null, lastW = innerWidth;
  window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (Math.abs(innerWidth - lastW) > 40) { lastW = innerWidth; render(); } }, 250); });
  await loadData().catch(e => toast("Couldn't load data: " + errMsg(e)));
  // Scores typed with no signal are kept on the phone; send them now.
  for (const c of state.cards) {
    try { const saved = JSON.parse(localStorage.getItem("golf_card_" + c.id) || "null");
      if (saved && editing()) { c.scores = { ...c.scores, ...saved.scores }; c.pars = saved.pars || c.pars; Object.keys(saved.scores || {}).filter(s => !s.startsWith("__")).forEach(s => queueSave(c, s)); queueSave(c, "__pars"); } } catch (e) { /* ignore */ }
  }
  route();
  alertsInit(); // after the database client is ready
})();

// ---------- GPS yardages (one-tap on-demand front / middle / back of the green) ----------
// Green outlines come from OpenStreetMap: greens.json for saved courses (tools/greens.py builds it),
// otherwise the phone asks OpenStreetMap itself the first time and keeps the answer.
// One-tap "call it up" mode: pulls a fresh GPS fix on demand when tapped (no battery-draining background watch).
const yd = { on: localStorage.getItem("golf_gps") === "1", busy: false, pos: null, err: "", file: null, live: {}, asked: {}, fixKey: "", hiddenAt: 0 };
const M2Y = 1.09361;
function ydLoadFile() {
  if (yd.file) return;
  yd.file = {};
  fetch("greens.json?v=202611240249").then(r => r.ok ? r.json() : {}).then(j => { yd.file = j || {}; ydPaint(); }).catch(() => {});
}
function ydCourse(card) {
  const c = state.courses.find(x => x.id === card.course_id) || state.courses.find(x => x.name === card.course_name && x.lat != null);
  const any = c?.lat != null ? c : state.courses.find(x => x.name.split(" (")[0] === card.course_name.split(" (")[0] && x.lat != null);
  return any ? { lat: any.lat, lng: any.lng } : null;
}
function ydGreens(card) {
  const key = card.course_name;
  if (yd.file?.[key]) return yd.file[key];
  if (yd.live[key]) return yd.live[key];
  try { const c = JSON.parse(localStorage.getItem("golf_greens_" + key) || "null"); if (c && Date.now() - c.at < 30 * 864e5) return (yd.live[key] = c.holes); } catch (e) { /* ignore */ }
  if (yd.file && Object.keys(yd.file).length && !yd.asked[key]) { yd.asked[key] = true; ydFetchLive(card).catch(() => {}); }
  return null;
}
const ydDist = (a, b) => Math.hypot((a[0] - b[0]) * 110540, (a[1] - b[1]) * 111320 * Math.cos(a[0] * Math.PI / 180));
const ydPip = (pt, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [yi, xi] = poly[i], [yj, xj] = poly[j]; if (((yi > pt[0]) !== (yj > pt[0])) && (pt[1] < (xj - xi) * (pt[0] - yi) / (yj - yi) + xi)) c = !c; } return c; };
// Course not in greens.json: ask OpenStreetMap (Overpass) once, match holes the same way the build script does.
async function ydFetchLive(card) {
  const loc = ydCourse(card); if (!loc) { yd.live[card.course_name] = {}; ydPaint(); return; }
  const q = `[out:json][timeout:25];(way["golf"="hole"](around:1800,${loc.lat},${loc.lng});way["golf"="green"](around:1800,${loc.lat},${loc.lng});way["golf"="fairway"](around:1800,${loc.lat},${loc.lng});way["golf"="bunker"](around:1800,${loc.lat},${loc.lng});way["golf"="water_hazard"](around:1800,${loc.lat},${loc.lng});way["golf"="lateral_water_hazard"](around:1800,${loc.lat},${loc.lng});way["natural"="water"](around:1800,${loc.lat},${loc.lng}););out tags geom;`;
  let j = null;
  for (const u of OVERPASS) { try { const r = await timed(u, { method: "POST", body: "data=" + encodeURIComponent(q) }, 30000); if (r.ok) { j = await r.json(); break; } } catch (e) { /* next */ } }
  if (!j) { yd.live[card.course_name] = {}; ydPaint(); return; } // no answer: no yardages this time (tap off/on to retry)
  const geo = w => (w.geometry || []).map(p => [p.lat, p.lon]);
  const greens = j.elements.filter(w => w.tags?.golf === "green").map(geo).filter(g => g.length > 2);
  const hs = j.elements.filter(w => w.tags?.golf === "hole" && /^\d+$/.test(w.tags.ref || "")).map(w => { const l = geo(w); const pin = l[l.length - 1];
    let g = greens.find(g => ydPip(pin, g)); if (!g) { g = greens.slice().sort((a, b) => ydDist(a[0], pin) - ydDist(b[0], pin))[0]; if (g && ydDist(g[0], pin) > 80) g = null; }
    return { ref: +w.tags.ref, par: w.tags.par, hcp: w.tags.handicap, tee: l[0], pin, g }; }).filter(h => h.g && h.tee);
  const parent = hs.map((_, i) => i), find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  hs.forEach((A, a) => hs.forEach((B, b) => { if (B.ref === A.ref + 1 && ydDist(A.pin, B.tee) < 300) parent[find(a)] = find(b); }));
  const comps = {}; hs.forEach((h, i) => (comps[find(i)] ||= []).push(h));
  const sis = card.sis?.length === card.pars.length ? card.sis : null;
  let best = null, bs = 0;
  for (const comp of Object.values(comps)) {
    let sc = 0;
    for (const h of comp) { const i = h.ref - 1; if (i >= card.pars.length) { sc--; continue; } sc += String(card.pars[i]) === h.par ? 1 : -3; if (h.hcp && sis) sc += String(sis[i]) === h.hcp ? 2 : -5; }
    if (sc > bs) { best = comp; bs = sc; }
  }
  const holes = {};
  (best || []).forEach(h => { if (h.ref <= card.pars.length && String(card.pars[h.ref - 1]) === h.par) holes[h.ref] = holes[h.ref] ? "dup" : { g: h.g, t: h.tee }; });
  Object.keys(holes).forEach(k => { if (holes[k] === "dup") delete holes[k]; });
  // Attach nearby fairways, bunkers, water hazards, and trees to each hole automatically.
  const ctr = g => [g.reduce((s, p) => s + p[0], 0) / g.length, g.reduce((s, p) => s + p[1], 0) / g.length];
  const segD = (p, a, b) => {
    const kx = 111320 * Math.cos(a[0] * Math.PI / 180), ky = 110540;
    const px = (p[1] - a[1]) * kx, py = (p[0] - a[0]) * ky, bx = (b[1] - a[1]) * kx, by = (b[0] - a[0]) * ky;
    const l2 = bx * bx + by * by; if (l2 < 1e-6) return Math.hypot(px, py);
    const t = Math.max(0, Math.min(1, (px * bx + py * by) / l2)); return Math.hypot(px - t * bx, py - t * by);
  };
  const simp = (g, m) => g.length <= m ? g : Array.from({ length: m }, (_, i) => g[Math.floor(i * g.length / m)]);
  const fws = [], bks = [], wts = [], trs = [];
  for (const w of j.elements) {
    const g = geo(w); if (g.length < 3) continue; const tg = w.tags || {}, c = ctr(g);
    if (tg.golf === "fairway") fws.push([c, g]);
    else if (tg.golf === "bunker") bks.push([c, g]);
    else if (tg.golf === "water_hazard" || tg.golf === "lateral_water_hazard" || tg.natural === "water") wts.push([c, g]);
    else if (tg.natural === "wood" || tg.landuse === "forest") trs.push([c, g]);
  }
  for (const h of Object.values(holes)) {
    const gc = ctr(h.g);
    const fw = fws.filter(([c]) => segD(c, h.t, gc) < 55).map(([, g]) => simp(g, 24));
    const bk = bks.filter(([c]) => segD(c, h.t, gc) < 65).map(([, g]) => simp(g, 16));
    const wt = wts.filter(([c]) => segD(c, h.t, gc) < 85).map(([, g]) => simp(g, 22));
    const tr = trs.filter(([c]) => segD(c, h.t, gc) < 85).map(([, g]) => simp(g, 22));
    if (fw.length) h.fw = fw; if (bk.length) h.bk = bk; if (wt.length) h.wt = wt; if (tr.length) h.tr = tr;
  }
  yd.live[card.course_name] = holes;
  if (Object.keys(holes).length) try { localStorage.setItem("golf_greens_" + card.course_name, JSON.stringify({ at: Date.now(), holes })); } catch (e) { /* full */ }
  ydPaint();
}
// Distances along the line from you through the middle of the green to its front and back edges.
function ydNumbers(pos, g) {
  const lat0 = pos[0], kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  const P = g.map(p => [(p[1] - pos[1]) * kx, (p[0] - pos[0]) * ky]);
  let A = 0, cx = 0, cy = 0;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const f = P[j][0] * P[i][1] - P[i][0] * P[j][1]; A += f; cx += (P[j][0] + P[i][0]) * f; cy += (P[j][1] + P[i][1]) * f; }
  if (Math.abs(A) < 1e-6) { cx = P.reduce((s, p) => s + p[0], 0) / P.length; cy = P.reduce((s, p) => s + p[1], 0) / P.length; } else { cx /= 3 * A; cy /= 3 * A; }
  const mid = Math.hypot(cx, cy);
  if (ydPip(pos, g)) return { on: true, mid };
  const ux = cx / mid, uy = cy / mid, ts = [];
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [x1, y1] = P[j], [x2, y2] = P[i], ex = x2 - x1, ey = y2 - y1, den = ux * ey - uy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = (x1 * ey - y1 * ex) / den, s2 = (x1 * uy - y1 * ux) / den;
    if (t > 0 && s2 >= 0 && s2 <= 1) ts.push(t);
  }
  return { mid, front: ts.length ? Math.min(...ts) : mid, back: ts.length ? Math.max(...ts) : mid };
}
function ydText(card, hole) {
  if (yd.busy && !yd.pos) return `<span class="ydmsg">📍 Pulling GPS…</span>`;
  if (!yd.on) return `<span class="ydoff">📍 Get Yardage</span>`;
  const holes = ydGreens(card), h = holes?.[hole + 1] || holes?.[String(hole + 1)];
  if (yd.err) return `<span class="ydmsg">${esc(yd.err)}</span>`;
  if (!h) return `<span class="ydmsg">${holes || (yd.file && !yd.asked[card.course_name]) ? "No yardage for this hole" : "Loading greens…"}</span>`;
  if (!yd.pos) return `<span class="ydoff">📍 Get Yardage</span>`;
  const n = ydNumbers([yd.pos.lat, yd.pos.lng], h.g), y = m => Math.round(m * M2Y);
  if (n.on) return `<span class="ydmsg">On the green ↻</span>`;
  if (y(n.mid) > 700) return `<span class="ydmsg">Not near hole ${hole + 1} ↻</span>`;
  const acc = yd.pos.acc > 18 ? `<span class="ydacc">±${Math.round(yd.pos.acc * M2Y)}</span>` : "";
  return `<span class="ydf">F ${y(n.front)}</span><b>${y(n.mid)}</b><span class="ydf">B ${y(n.back)}</span>${acc}<span class="ydref" aria-hidden="true">↻</span>`;
}
function ydGreenCenter(g) {
  let lat = 0, lng = 0;
  for (const p of g) { lat += p[0]; lng += p[1]; }
  return [lat / g.length, lng / g.length];
}
function ydRoughText(card, hole) {
  const holes = ydGreens(card), h = holes?.[hole + 1] || holes?.[String(hole + 1)];
  if (!h?.t || !h?.g?.length) return "";
  const y = Math.round(ydDist(h.t, ydGreenCenter(h.g)) * M2Y);
  return y > 40 && y < 750 ? ` · ~${y} yds` : "";
}
function ydHoleSvg(card, hole) {
  const holes = ydGreens(card), h = holes?.[hole + 1] || holes?.[String(hole + 1)];
  if (!h?.t || !h?.g?.length) {
    const done = holes || (yd.file && yd.asked[card.course_name] && yd.live[card.course_name]);
    return done ? "" : `<div class="hmap-none">Loading hole map…</div>`;
  }
  const gc = ydGreenCenter(h.g), t = h.t;
  const kx = 111320 * Math.cos(t[0] * Math.PI / 180), ky = 110540;
  const toM = p => [(p[1] - t[1]) * kx, (p[0] - t[0]) * ky];
  const [gx, gy] = toM(gc), L = Math.hypot(gx, gy);
  if (L < 30) return "";
  // Rotate so tee is at bottom (0,0) and green center is straight up (0, L).
  const ux = gx / L, uy = gy / L;
  const rot = p => { const [x, y] = toM(p); return [x * uy - y * ux, x * ux + y * uy]; };
  const gPts = h.g.map(rot);
  const W = 280, H = 104, padX = 24;
  // Horizontal orientation: tee on left, green on right so it stays compact on mobile!
  const scaleX = (W - padX * 2) / (L + 28);
  const mapX = d => padX + d * scaleX;
  const mapY = off => H / 2 - off * Math.min(scaleX * 1.45, 0.85);
  const toPoly = pts => pts.map(rot).map(([off, d]) => `${mapX(d).toFixed(1)},${mapY(off).toFixed(1)}`).join(" ");
  const poly = toPoly(h.g);
  const tx = mapX(0), ty = mapY(0), gcx = mapX(L), gcy = mapY(0);
  const yds = Math.round(L * M2Y);
  const trSvg = (h.tr || []).map(p => `<polygon points="${toPoly(p)}" class="htree"/>`).join("");
  const wtSvg = (h.wt || []).map(p => `<polygon points="${toPoly(p)}" class="hwater"/>`).join("");
  const fwSvg = (h.fw && h.fw.length)
    ? h.fw.map(p => `<polygon points="${toPoly(p)}" class="hfairway"/>`).join("")
    : `<path d="M ${tx.toFixed(1)} ${(ty - 5).toFixed(1)} Q ${((tx + gcx) / 2).toFixed(1)} ${(ty - 17).toFixed(1)} ${(gcx - 8).toFixed(1)} ${(gcy - 12).toFixed(1)} L ${(gcx - 8).toFixed(1)} ${(gcy + 12).toFixed(1)} Q ${((tx + gcx) / 2).toFixed(1)} ${(ty + 17).toFixed(1)} ${tx.toFixed(1)} ${(ty + 5).toFixed(1)} Z" class="hfairway"/>`;
  const bkSvg = (h.bk || []).map(p => `<polygon points="${toPoly(p)}" class="hbunker"/>`).join("");
  let dotMe = "";
  if (yd.pos) {
    const [moff, md] = rot([yd.pos.lat, yd.pos.lng]);
    if (md > -40 && md < L + 50 && Math.abs(moff) < 120) {
      dotMe = `<circle cx="${mapX(md).toFixed(1)}" cy="${mapY(moff).toFixed(1)}" r="4.5" fill="#e2b53e" stroke="#080707" stroke-width="1.5"/>`;
    }
  }
  return `<svg viewBox="0 0 ${W} ${H}" class="hsvg" aria-label="Hole ${hole + 1} silhouette, approximately ${yds} yards">
    ${trSvg}${wtSvg}${fwSvg}${bkSvg}
    <line x1="${tx.toFixed(1)}" y1="${ty.toFixed(1)}" x2="${gcx.toFixed(1)}" y2="${gcy.toFixed(1)}" class="hline"/>
    <polygon points="${poly}" class="hgreen"/>
    <rect x="${(tx - 4).toFixed(1)}" y="${(ty - 4).toFixed(1)}" width="8" height="8" rx="2" class="htee"/>
    <circle cx="${gcx.toFixed(1)}" cy="${gcy.toFixed(1)}" r="2.8" class="hpin"/>
    ${dotMe}
    <text x="${tx.toFixed(1)}" y="${H - 5}" text-anchor="middle" class="hlbl">TEE</text>
    <text x="${((tx + gcx) / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle" class="hlbl-y">~${yds} yds</text>
    <text x="${gcx.toFixed(1)}" y="${H - 5}" text-anchor="middle" class="hlbl">GREEN</text>
  </svg>`;
}
// Hand-entered shapes for holes the map data can't see (no fairway outline). Trent's calls.
// Map fairway outlines aren't reliable enough to call doglegs on their own (offset tees and shared fairways
// read as bends), so shape only comes from here: checked against the official layout and Trent's calls.
const HOLE_SHAPE = { "CrossWinds Golf Course": { 1: "Dogleg left", 4: "Dogleg left" } };
// Caddy note: one line per hole from the course outline data (OpenStreetMap): shape, water, sand.
// Distances are yards from the tee along the line to the middle of the green. No club advice.
function ydHoleNote(card, hole) {
  const holes = ydGreens(card), h = holes?.[hole + 1] || holes?.[String(hole + 1)];
  if (!h?.t || !h?.g?.length) {
    const done = holes || (yd.file && yd.asked[card.course_name] && yd.live[card.course_name]);
    return done ? "" : `<span class="muted">Loading hole notes…</span>`;
  }
  const gc = ydGreenCenter(h.g), t = h.t;
  const kx = 111320 * Math.cos(t[0] * Math.PI / 180), ky = 110540;
  const toM = p => [(p[1] - t[1]) * kx, (p[0] - t[0]) * ky];
  const [gx, gy] = toM(gc), L = Math.hypot(gx, gy);
  if (L < 30) return "";
  const ux = gx / L, uy = gy / L;
  // along = meters toward the green, side = meters off the line (+ left, - right)
  const rel = p => { const [x, y] = toM(p); return { a: x * ux + y * uy, s: ux * y - uy * x }; };
  const Y = m => Math.round(m * M2Y / 5) * 5;
  const par = card.pars[hole], bits = [];
  const center = poly => { const r = poly.map(rel); return { a: r.reduce((q, x) => q + x.a, 0) / r.length, s: r.reduce((q, x) => q + x.s, 0) / r.length, pts: r }; };
  // Shape: where the fairway bends away from the straight line (a hand-entered shape wins)
  const fixShape = HOLE_SHAPE[card.course_name]?.[hole + 1];
  if (fixShape) bits.push(fixShape);
  else if (false && par >= 4 && h.fw?.length) { // auto shape off: see HOLE_SHAPE
    const pts = h.fw.flatMap(poly => poly.map(rel)).filter(x => x.a > L * 0.25 && x.a < L * 0.8);
    if (pts.length) {
      // The fairway bulges out on the far side of the straight line: bulge right = dogleg left.
      const s = pts.reduce((q, x) => q + x.s, 0) / pts.length;
      const corner = pts.filter(x => Math.sign(x.s) === Math.sign(s)).reduce((m, x) => Math.abs(x.s) > Math.abs(m.s) ? x : m, pts[0]);
      if (Math.abs(s) > 18) bits.push(`${Math.abs(s) > 35 ? "Hard dogleg" : "Dogleg"} ${s > 0 ? "right" : "left"} around ${Y(corner.a)}`);
    }
  }
  // Water in play: anything between the tee and just past the green, within 70 m of the line
  const waters = (h.wt || []).map(center).map(w => ({ ...w, inPlay: w.pts.filter(x => x.a > 20 && x.a < L + 25 && Math.abs(x.s) < 70) })).filter(w => w.inPlay.length);
  waters.sort((p, q) => Math.min(...p.inPlay.map(x => x.a)) - Math.min(...q.inPlay.map(x => x.a)));
  for (const w of waters.slice(0, 2)) {
    const near = Math.min(...w.inPlay.map(x => x.a)), far = Math.max(...w.inPlay.map(x => x.a));
    const crosses = w.inPlay.some(x => x.s > 5) && w.inPlay.some(x => x.s < -5);
    const side = w.s > 0 ? "left" : "right";
    if (near > L - 45) bits.push(`Water ${crosses ? "in front of" : side + " of"} the green`);
    else if (crosses) bits.push(`Water crosses at ${Y(near)}, ${Y(Math.min(far, L))} to clear it`);
    else bits.push(`Water ${side} from ${Y(near)}`);
  }
  // Sand: fairway bunkers in the landing area, then bunkers around the green
  const bks = (h.bk || []).map(center);
  const fwb = par >= 4 ? bks.filter(b => b.a > 140 && b.a < L - 45 && Math.abs(b.s) < 45).sort((p, q) => p.a - q.a) : [];
  if (fwb.length) {
    const two = fwb.slice(0, 2), sd = b => b.s > 0 ? "left" : "right";
    bits.push(two.length === 2 && sd(two[0]) === sd(two[1]) ? `Fairway sand ${sd(two[0])} at ${Y(two[0].a)} and ${Y(two[1].a)}` : `Fairway sand ${two.map(b => `${sd(b)} at ${Y(b.a)}`).join(", ")}`);
  }
  const gb = bks.filter(b => Math.hypot(b.a - L, b.s) < 40);
  if (gb.length) {
    const where = new Set(gb.map(b => b.a < L - 12 && Math.abs(b.s) < 12 ? "short" : b.a > L + 12 && Math.abs(b.s) < 12 ? "long" : b.s > 0 ? "left" : "right"));
    const order = ["short", "left", "right", "long"].filter(x => where.has(x));
    bits.push(order.length >= 3 ? "Green guarded by sand all around" : `Sand ${order.join(" and ")} of the green`);
  }
  // Only call a hole clean when the map data has hazards for this course (some courses only have greens)
  const mapped = Object.values(holes).some(x => x?.bk?.length || x?.wt?.length);
  if (!bits.length && mapped) bits.push(par === 3 ? "Clean look at the green" : "Straightaway, nothing in the way");
  return esc(bits.slice(0, 3).join(" · "));
}
function ydPaint() {
  document.querySelectorAll("[data-yds]").forEach(el => { const [id, h] = el.dataset.yds.split(":"); const card = cardById(id); if (card) el.innerHTML = ydText(card, +h); });
  document.querySelectorAll("[data-ryds]").forEach(el => { const [id, h] = el.dataset.ryds.split(":"); const card = cardById(id); if (card) el.textContent = ydRoughText(card, +h); });
  document.querySelectorAll("[data-hnote]").forEach(el => { const [id, h] = el.dataset.hnote.split(":"); const card = cardById(id); if (card) el.innerHTML = ydHoleNote(card, +h); });
  satPaint();
}

// ---------- Interactive Esri satellite hole map (inline drag-to-measure + optional blow-up) ----------
const satTiles = new Map(), satBases = new Map(), satTap = {};
const satToMerc = (lat, lng, z) => {
  const s = 256 * Math.pow(2, z), rad = lat * Math.PI / 180;
  return [((lng + 180) / 360) * s, (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * s];
};
const satToLatLng = (x, y, z) => {
  const s = 256 * Math.pow(2, z), n = Math.PI - (2 * Math.PI * y) / s;
  return [(180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), (x / s) * 360 - 180];
};
function satGetTile(z, x, y) {
  const k = `${z}/${y}/${x}`;
  if (satTiles.has(k)) return satTiles.get(k);
  const p = new Promise(res => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  });
  satTiles.set(k, p);
  return p;
}
function satGeom(h, W, H, horiz) {
  const gc = ydGreenCenter(h.g), t = h.t;
  const totalYds = Math.round(ydDist(t, gc) * M2Y);
  const z = totalYds > 430 ? 17 : 18;
  const [tx, ty] = satToMerc(t[0], t[1], z), [gx, gy] = satToMerc(gc[0], gc[1], z);
  const dx = gx - tx, dy = gy - ty, len = Math.max(10, Math.hypot(dx, dy));
  const midMx = (tx + gx) / 2, midMy = (ty + gy) / 2;
  const span = horiz ? (W - 76) : (H - 124);
  const scale = Math.min(span / len, horiz ? 1.15 : 1.45);
  const rot = horiz ? -Math.atan2(dy, dx) : (-Math.PI / 2 - Math.atan2(dy, dx));
  const cx = W / 2, cy = horiz ? H / 2 : (H / 2 + 4);
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const toScr = (mx, my) => { const rx = mx - midMx, ry = my - midMy; return [cx + (rx * cr - ry * sr) * scale, cy + (rx * sr + ry * cr) * scale]; };
  const toMerc = (sx, sy) => { const vx = (sx - cx) / scale, vy = (sy - cy) / scale; return [midMx + (vx * cr + vy * sr), midMy + (-vx * sr + vy * cr)]; };
  return { gc, t, totalYds, z, tx, ty, gx, gy, midMx, midMy, scale, rot, cx, cy, toScr, toMerc };
}
async function satBase(key, h, W, H, horiz) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const bk = `${key}:${horiz ? "h" : "v"}:${Math.round(W)}x${Math.round(H)}`;
  if (satBases.has(bk)) return satBases.get(bk);
  const G = satGeom(h, W, H, horiz);
  const corners = [[0, 0], [W, 0], [0, H], [W, H]].map(([sx, sy]) => G.toMerc(sx, sy));
  const minTx = Math.floor(Math.min(...corners.map(p => p[0])) / 256);
  const maxTx = Math.floor(Math.max(...corners.map(p => p[0])) / 256);
  const minTy = Math.floor(Math.min(...corners.map(p => p[1])) / 256);
  const maxTy = Math.floor(Math.max(...corners.map(p => p[1])) / 256);
  const jobs = [];
  for (let x = minTx; x <= maxTx; x++) for (let y = minTy; y <= maxTy; y++) jobs.push(satGetTile(G.z, x, y).then(img => ({ img, x, y })));
  const tiles = await Promise.all(jobs);
  const off = document.createElement("canvas");
  off.width = Math.round(W * dpr); off.height = Math.round(H * dpr);
  const ctx = off.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#161d17"; ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(G.cx, G.cy); ctx.scale(G.scale, G.scale); ctx.rotate(G.rot); ctx.translate(-G.midMx, -G.midMy);
  for (const ti of tiles) if (ti.img) ctx.drawImage(ti.img, ti.x * 256, ti.y * 256, 256.5, 256.5);
  ctx.restore();
  const vig = ctx.createRadialGradient(G.cx, G.cy, Math.min(W, H) * 0.25, G.cx, G.cy, Math.max(W, H) * 0.75);
  vig.addColorStop(0, "rgba(0,0,0,0)"); vig.addColorStop(1, "rgba(15,8,18,0.4)");
  ctx.fillStyle = vig; ctx.fillRect(0, 0, W, H);
  const entry = { off, G, dpr, W, H };
  if (satBases.size > 24) satBases.delete(satBases.keys().next().value);
  satBases.set(bk, entry);
  return entry;
}
function satDrawOverlay(cv, base, tap, horiz) {
  const { off, G, dpr, W, H } = base;
  if (cv.width !== off.width || cv.height !== off.height) { cv.width = off.width; cv.height = off.height; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(off, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Measure from live GPS if on the hole (< 700 yds from green), otherwise from the tee.
  const gpsNear = yd.pos && ydDist([yd.pos.lat, yd.pos.lng], G.gc) * M2Y < 700 ? [yd.pos.lat, yd.pos.lng] : null;
  const origin = gpsNear || G.t;
  const [omx, omy] = satToMerc(origin[0], origin[1], G.z);
  const [osx, osy] = G.toScr(omx, omy);
  const [tsx, tsy] = G.toScr(G.tx, G.ty);
  const [gsx, gsy] = G.toScr(G.gx, G.gy);

  const drawPill = (x, y, text, accent) => {
    ctx.save();
    ctx.font = `700 ${horiz ? 11 : 12}px -apple-system, BlinkMacSystemFont, sans-serif`;
    const tw = ctx.measureText(text).width, pw = tw + 14, ph = horiz ? 20 : 22, r = ph / 2;
    const maxRight = horiz ? W - 42 : W - 8;
    const px = Math.max(8, Math.min(maxRight - pw, x - pw / 2));
    const py = Math.max(6, Math.min(H - ph - 6, y - ph / 2));
    ctx.fillStyle = accent ? "rgba(191,164,120,0.96)" : "rgba(21,12,23,0.88)";
    ctx.strokeStyle = accent ? "#1a120a" : "rgba(191,164,120,0.78)";
    ctx.lineWidth = 1.25;
    ctx.beginPath(); ctx.roundRect(px, py, pw, ph, r); ctx.fill(); ctx.stroke();
    ctx.fillStyle = accent ? "#1a120a" : "#f5efe4";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, px + pw / 2, py + ph / 2 + 0.5);
    ctx.restore();
  };

  if (tap) {
    const [pmx, pmy] = satToMerc(tap[0], tap[1], G.z);
    const [psx, psy] = G.toScr(pmx, pmy);
    const d1 = Math.round(ydDist(origin, tap) * M2Y);
    const d2 = Math.round(ydDist(tap, G.gc) * M2Y);
    ctx.save();
    ctx.strokeStyle = "rgba(245,239,228,0.94)"; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(osx, osy); ctx.lineTo(psx, psy); ctx.lineTo(gsx, gsy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(psx, psy, horiz ? 11 : 14, 0, Math.PI * 2);
    ctx.strokeStyle = "#bfa478"; ctx.lineWidth = 2.2; ctx.stroke();
    ctx.beginPath(); ctx.arc(psx, psy, 3.6, 0, Math.PI * 2);
    ctx.fillStyle = "#f5efe4"; ctx.fill();
    ctx.restore();
    if (horiz) {
      const above = psy > H * 0.52 ? -22 : 22;
      drawPill((osx + psx) / 2, Math.max(16, Math.min(H - 16, (osy + psy) / 2 + above)), `${d1} yds`, false);
      drawPill((psx + gsx) / 2, Math.max(16, Math.min(H - 16, (psy + gsy) / 2 - above * 0.85)), `${d2} pin`, true);
    } else {
      drawPill((osx + psx) / 2 + 28, (osy + psy) / 2, `${d1} yds`, false);
      drawPill((psx + gsx) / 2 + 28, (psy + gsy) / 2, `${d2} to pin`, true);
    }
  } else {
    ctx.save();
    ctx.strokeStyle = "rgba(245,239,228,0.65)"; ctx.lineWidth = 1.8; ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.moveTo(osx, osy); ctx.lineTo(gsx, gsy); ctx.stroke();
    ctx.restore();
    if (!horiz) drawPill((osx + gsx) / 2, (osy + gsy) / 2, `${Math.round(ydDist(origin, G.gc) * M2Y)} yds`, false);
  }

  // Tee dot
  ctx.save();
  ctx.beginPath(); ctx.arc(tsx, tsy, 5, 0, Math.PI * 2);
  ctx.fillStyle = "#bfa478"; ctx.fill(); ctx.lineWidth = 1.8; ctx.strokeStyle = "#150c17"; ctx.stroke();
  // Live GPS player dot when on the hole
  if (gpsNear) {
    ctx.beginPath(); ctx.arc(osx, osy, 9, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(77,163,255,0.28)"; ctx.fill();
    ctx.beginPath(); ctx.arc(osx, osy, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#4da3ff"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#ffffff"; ctx.stroke();
  }
  // Green pin dot + ring
  ctx.beginPath(); ctx.arc(gsx, gsy, 9.5, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(191,164,120,0.88)"; ctx.lineWidth = 1.6; ctx.stroke();
  ctx.beginPath(); ctx.arc(gsx, gsy, 4, 0, Math.PI * 2);
  ctx.fillStyle = "#f5efe4"; ctx.fill();
  ctx.restore();
}
function satWireDrag(cv, base, key, horiz, onUpdate) {
  let dragging = false;
  const pick = e => {
    const r = cv.getBoundingClientRect();
    const sx = Math.max(4, Math.min(r.width - 4, e.clientX - r.left));
    const sy = Math.max(4, Math.min(r.height - 4, e.clientY - r.top));
    const [mx, my] = base.G.toMerc(sx, sy);
    satTap[key] = satToLatLng(mx, my, base.G.z);
    satDrawOverlay(cv, base, satTap[key], horiz);
    onUpdate?.();
  };
  cv.onpointerdown = e => { dragging = true; cv.setPointerCapture?.(e.pointerId); pick(e); };
  cv.onpointermove = e => { if (dragging) pick(e); };
  cv.onpointerup = cv.onpointercancel = () => { dragging = false; };
}
function openSatModal(card, hole) {
  const holes = ydGreens(card), h = holes?.[hole + 1] || holes?.[String(hole + 1)];
  if (!h?.t || !h?.g?.length) return;
  const key = card.id + ":" + hole;
  const rough = ydRoughText(card, hole);
  openModal(`<div class="sat-sheet">
    <h2>Hole ${hole + 1} · Par ${card.pars[hole]}${rough}</h2>
    <p class="hint" style="margin:0 0 10px">Tap or drag anywhere on the fairway, water, or bunkers to measure.</p>
    <div class="sat-fullbox">
      <canvas class="sat-fullcv" id="satfull"></canvas>
      <button type="button" class="satbtn satclr" id="satmclr" aria-label="Clear target" ${satTap[key] ? "" : "hidden"}>✕</button>
    </div>
    <div class="sat-foot"><span>${esc(card.course_name)}${card.tee_name ? " · " + esc(card.tee_name) : ""}</span><span>Imagery © Esri</span></div>
  </div>`, async m => {
    const cv = $("#satfull", m), clr = $("#satmclr", m);
    const W = cv.clientWidth || 340, H = cv.clientHeight || 460;
    const base = await satBase(`${card.course_name}:${hole + 1}`, h, W, H, false);
    if (!cv.isConnected) return;
    satDrawOverlay(cv, base, satTap[key], false);
    const sync = () => { clr.hidden = !satTap[key]; satPaint(); };
    satWireDrag(cv, base, key, false, sync);
    clr.onclick = () => { delete satTap[key]; satDrawOverlay(cv, base, null, false); sync(); };
  });
}
function satPaint() {
  document.querySelectorAll("[data-sat]").forEach(async wrap => {
    const [id, hIdx] = wrap.dataset.sat.split(":");
    const hole = +hIdx, card = cardById(id);
    if (!card) return;
    const holes = ydGreens(card), h = holes?.[hole + 1] || holes?.[String(hole + 1)];
    if (!h?.t || !h?.g?.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const cv = $(".satcv", wrap), clr = $(".satclr", wrap), exp = $(".satexp", wrap), hint = $(".sathint", wrap);
    const key = id + ":" + hole;
    const W = cv.clientWidth || Math.min(360, innerWidth - 52), H = cv.clientHeight || 118;
    const base = await satBase(`${card.course_name}:${hole + 1}`, h, W, H, true);
    if (!wrap.isConnected) return;
    const syncUI = () => { clr.hidden = !satTap[key]; hint.hidden = !!satTap[key]; };
    satDrawOverlay(cv, base, satTap[key], true);
    syncUI();
    satWireDrag(cv, base, key, true, syncUI);
    clr.onclick = e => { e.stopPropagation(); delete satTap[key]; satDrawOverlay(cv, base, null, true); syncUI(); };
    exp.onclick = e => { e.stopPropagation(); openSatModal(card, hole); };
  });
}
// Auto refresh: once yardages are on, take a fresh GPS fix on every new hole, every 15 s while the
// Live tab is on screen (so the number follows you from the green to the next tee and down the
// fairway), and whenever the phone comes back out of the pocket. GPS never runs with the app hidden.
// Skips holes with no green data.
setInterval(() => { if (yd.on && !yd.busy && state.tab === "card" && !document.hidden) { yd.fixKey = ""; ydSync(true); } }, 15000);
function ydSync(quiet) {
  if (state.tab !== "card") return;
  ydLoadFile();
  if (!yd.on || yd.busy || document.hidden || !("geolocation" in navigator)) return;
  const card = cardById(state.cardId); if (!card) return;
  const n = (card.pars || []).length || 18;
  const hole = Math.min(n - 1, Math.max(0, Number(localStorage.getItem("golf_hole_" + card.id) ?? firstOpenHole(card))));
  const key = card.id + ":" + hole;
  if (key === yd.fixKey) return;
  const holes = ydGreens(card);
  if (holes && !(holes[hole + 1] || holes[String(hole + 1)])) return;
  if (!quiet && yd.fixKey.split(":")[1] !== String(hole)) yd.pos = null; // new hole: don't show the old spot's number
  yd.fixKey = key;
  ydToggle();
}
function ydToggle() {
  yd.on = true; yd.err = ""; yd.busy = true;
  try { localStorage.setItem("golf_gps", "1"); } catch (e) { /* private mode */ }
  ydLoadFile();
  ydPaint();
  if (!("geolocation" in navigator)) { yd.busy = false; yd.err = "GPS not supported on this device"; ydPaint(); return; }
  navigator.geolocation.getCurrentPosition(
    p => { yd.busy = false; yd.err = ""; yd.pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }; ydPaint(); },
    e => { yd.busy = false; yd.err = e.code === 1 ? "Location blocked. Allow it in Safari Settings." : "Could not get GPS. Tap to retry."; ydPaint(); },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
  );
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { yd.hiddenAt = Date.now(); return; }
  if (yd.hiddenAt && Date.now() - yd.hiddenAt > 20000) yd.fixKey = ""; // pulled back out: fresh fix
  ydSync(true);
});

// ---------- Home Screen app + push alerts ----------
// Installable (manifest + sw.js). Alerts: the phone subscribes (Web Push), the subscription is saved through
// gt_push_sub (no phrase needed), and the "push" edge function sends tee offs, hole results and finals.
// No VAPID key on the server = the Alerts box stays hidden.
function stampUpd() {
  state.updatedAt = new Date();
  const b = document.getElementById("upd");
  if (b) b.textContent = "Updated " + state.updatedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) + (document.documentElement.classList.contains("app") ? " ↻" : "");
}
const inApp = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const PUSH_FN = DEMO ? null : `${CFG.supabaseUrl}/functions/v1/push`;
let SWREG = null, VAPID = null;
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const AL_IDS = { start: "al-start", end: "al-end", own: "al-own" };
const HOLES_HINT = { off: "No hole alerts.", big: "Only when it matters: lead changes, the match squared, dormie, match decided, birdie or better.", all: "Every hole: who won it, match status, birdies, blowups." };
const alState = () => { try { return JSON.parse(localStorage.getItem("golf_alerts") || "null"); } catch (e) { return null; } };
const alSave = v => { try { localStorage.setItem("golf_alerts", JSON.stringify(v)); } catch (e) { /* private mode */ } };
let alMe = alState()?.me ?? null, alHoles = (h => h === "all" || h === "off" ? h : "big")(alState()?.p?.holes);
function paintMe() {
  document.querySelectorAll("#al-holes [data-h]").forEach(b => b.classList.toggle("on", b.dataset.h === alHoles));
  $("#al-hhint").textContent = HOLES_HINT[alHoles];
  $("#al-me").innerHTML = [...PLAYERS.map(p => [p.slug, p.name]), [null, "Just watching"]].map(([s, n]) =>
    `<button type="button" data-me="${s ?? ""}" class="${(alMe ?? "") === (s ?? "") ? "on" : ""}">${s ? dot(s) : ""}${esc(n)}</button>`).join("");
  const ownWrap = $("#al-own-wrap"); if (ownWrap) ownWrap.hidden = !alMe;
}
async function alertsUI() {
  const sec = $("#alerts"); if (!sec || !VAPID) return;
  sec.hidden = false;
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const can = "PushManager" in window && "Notification" in window && !!SWREG;
  const needInstall = ios && !inApp();
  $("#alerts-install").hidden = !needInstall;
  $("#alerts-form").hidden = needInstall || !can;
  const note = $("#alerts-note");
  if (!needInstall && !can) note.textContent = "This browser can't get alerts. On iPhone, add Golf to your Home Screen first.";
  else if (!needInstall && Notification.permission === "denied") note.textContent = "Notifications are blocked for Golf. Turn them on in Settings, Notifications, Golf.";
  const st = alState(), sub = can ? await SWREG.pushManager.getSubscription().catch(() => null) : null;
  const on = !!(st && st.on && sub);
  if (st && st.p) { for (const [k, id] of Object.entries(AL_IDS)) $("#" + id).checked = st.p[k] !== false; alHoles = st.p.holes === "all" || st.p.holes === "off" ? st.p.holes : "big"; }
  paintMe();
  $("#al-save").textContent = on ? "Save" : "Turn on alerts";
  $("#al-off").hidden = !on;
  $("#alerts-sum").textContent = on ? "On" + (alMe ? " · " + pname(alMe) : "") : "Phone and watch";
  // Keep the server's copy fresh (phones rotate subscriptions now and then); once a day is plenty.
  if (on && sb && Date.now() - (st.synced || 0) > 864e5) sb.rpc("gt_push_sub", { op: "sub", sub: sub.toJSON(), prefs: st.p, me: st.p?.own !== false ? null : (st.me ?? null) })
    .then(({ error }) => { if (!error) alSave({ ...st, synced: Date.now() }); });
}
async function alertsInit() {
  if (DEMO || !("serviceWorker" in navigator)) return;
  try { SWREG = await navigator.serviceWorker.register("sw.js"); } catch (e) { return; }
  try { VAPID = (await (await fetch(PUSH_FN, { cache: "no-store" })).json()).key || null; } catch (e) { VAPID = null; }
  await alertsUI();
}
$("#al-me").addEventListener("click", e => { const b = e.target.closest("[data-me]"); if (!b) return; alMe = b.dataset.me || null; paintMe(); });
$("#al-holes").addEventListener("click", e => { const b = e.target.closest("[data-h]"); if (!b) return; alHoles = b.dataset.h; paintMe(); });
$("#alerts-form").addEventListener("submit", async e => {
  e.preventDefault();
  const note = $("#alerts-note"), btn = $("#al-save");
  const p = { holes: alHoles }; for (const [k, id] of Object.entries(AL_IDS)) p[k] = $("#" + id).checked;
  btn.disabled = true;
  try {
    const perm = await Notification.requestPermission(); // must run straight from the tap (iPhone rule)
    if (perm !== "granted") { note.textContent = "Notifications weren't allowed. Turn them on in Settings, Notifications, Golf."; btn.disabled = false; return; }
    note.textContent = "Saving…";
    const sub = await SWREG.pushManager.getSubscription() || await SWREG.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(VAPID) });
    const { error } = await sb.rpc("gt_push_sub", { op: "sub", sub: sub.toJSON(), prefs: p, me: p.own ? null : alMe });
    if (error) throw error;
    const was = alState();
    alSave({ on: true, p, me: alMe, synced: Date.now() });
    fetch(PUSH_FN, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "welcome", endpoint: sub.endpoint }) }).catch(() => {});
    note.textContent = was && was.on ? "Saved." : "You're in. A test alert should arrive in a few seconds.";
  } catch (err) { note.textContent = "Couldn't turn alerts on right now. " + (/full|many/i.test(errMsg(err)) ? errMsg(err) + "." : "Try again in a bit."); }
  btn.disabled = false; alertsUI();
});
$("#al-off").addEventListener("click", async () => {
  const note = $("#alerts-note");
  try {
    const sub = await SWREG.pushManager.getSubscription();
    if (sub) { await sb.rpc("gt_push_sub", { op: "unsub", sub: sub.toJSON() }); await sub.unsubscribe(); }
    alSave({ on: false, p: alState()?.p, me: alMe });
    note.textContent = "Alerts are off.";
  } catch (e) { note.textContent = "Couldn't turn alerts off right now. Try again in a bit."; }
  alertsUI();
});
// Refreshing inside the installed app (it has no reload button): pull down from the top (non-live tabs),
// tap the "Updated" line, or come back after 5+ minutes away (also picks up new versions of the site).
(() => {
  if (!inApp()) return;
  document.documentElement.classList.add("app");
  // Elastic pull-down on non-live tabs: drag as far down as you want to fiddle with it while the
  // page background and locked crest watermark stay put underneath; the spinning crest floats in the gap.
  const ind = document.createElement("div"); ind.className = "ptr"; ind.setAttribute("aria-hidden", "true");
  ind.innerHTML = `<img src="crest.webp?v=202611232130" alt=""><span>Pull to refresh</span>`;
  document.body.append(ind);
  const lbl = ind.querySelector("span"), root = document.documentElement;
  const busy = () => !$("#modal").hidden || document.body.dataset.tab === "card";
  const LINE = 105;
  let settleTimer = 0, refreshing = false;
  const setPull = (p, mode) => {
    clearTimeout(settleTimer);
    root.classList.toggle("pulling", !mode && p > 0);
    root.classList.toggle("settle", mode === "bounce");
    root.classList.toggle("glide", mode === "glide");
    root.style.setProperty("--pull", p.toFixed(1) + "px");
    root.style.setProperty("--ptr-rot", (p * 2.2).toFixed(0) + "deg");
    const k = Math.max(0, Math.min(1, (p - 16) / 68));
    ind.style.opacity = k.toFixed(2);
    const y = Math.max(-28, p * 0.46 - 28);
    ind.style.transform = `translate3d(-50%,${y.toFixed(1)}px,0) scale(${(0.74 + 0.28 * k).toFixed(3)})`;
    if (mode && p === 0) settleTimer = setTimeout(() => { root.classList.remove("settle", "glide", "pulling"); ind.classList.remove("spin"); }, mode === "glide" ? 450 : 580);
  };
  const go = async () => {
    if (refreshing) return;
    refreshing = true;
    lbl.textContent = "Refreshing…"; ind.classList.add("spin");
    setPull(116, "glide");
    const minSpin = new Promise(r => setTimeout(r, 580));
    const refreshWork = Promise.race([
      loadData().then(() => render()).catch(() => {}),
      new Promise(r => setTimeout(r, 4500))
    ]);
    await Promise.all([minSpin, refreshWork]);
    setPull(0, "glide");
    setTimeout(() => { refreshing = false; lbl.textContent = "Pull to refresh"; }, 460);
  };
  let y0 = null, d = 0, raf = 0, armed = null;
  const paint = () => {
    raf = 0;
    if (y0 === null) return;
    const pull = Math.max(0, d - 6);
    const maxPull = Math.max(360, innerHeight * 0.72);
    const travel = maxPull * (1 - Math.exp(-pull / (maxPull * 0.65)));
    setPull(travel, false);
    const a = travel > LINE;
    if (a !== armed) { armed = a; lbl.textContent = a ? "Let go to refresh" : "Pull to refresh"; }
  };
  const release = () => {
    if (y0 === null) return;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    const pull = Math.max(0, d - 6);
    const maxPull = Math.max(360, innerHeight * 0.72);
    const travel = maxPull * (1 - Math.exp(-pull / (maxPull * 0.65)));
    const fire = travel > LINE; y0 = null; d = 0;
    if (fire) go(); else setPull(0, "bounce");
  };
  addEventListener("touchstart", e => {
    if (refreshing) return;
    y0 = (scrollY <= 2 && e.touches.length === 1 && !busy() && !e.target.closest("canvas,input,textarea,select,.tabs,.lpic")) ? e.touches[0].clientY : null; d = 0; armed = null;
  }, { passive: true, capture: true });
  addEventListener("touchmove", e => {
    if (y0 === null) return;
    if (!e.touches.length) { release(); return; }
    const cy = e.touches[0].clientY;
    d = cy - y0;
    if (d <= 0) { y0 = null; setPull(0, "glide"); return; } // scrolling up: let the page scroll
    if (cy >= innerHeight - 16) { release(); return; } // iOS home-bar zone: release before system steals touchend
    if (d > 6) e.preventDefault();
    if (!raf) raf = requestAnimationFrame(paint);
  }, { passive: false, capture: true });
  addEventListener("touchend", e => { if (!e.touches?.length) release(); }, { passive: true, capture: true });
  addEventListener("touchcancel", release, { passive: true, capture: true });
  addEventListener("pointercancel", release, { passive: true, capture: true });
  addEventListener("blur", release);
  $("#upd").addEventListener("click", () => { if (!busy()) go(); });
  let away = 0;
  document.addEventListener("visibilitychange", () => { if (document.hidden) away = Date.now(); else if (away && Date.now() - away > 5 * 60000 && $("#modal").hidden) location.reload(); });
  if (state.updatedAt) stampUpd();
})();

// ---------- Return-to-top button + deep-bottom scroll-resistance Easter egg ----------
(() => {
  const topBtn = $("#totop"), hint = $("#abyss-hint"), rev = $("#abyss-reveal"), abyssTop = $(".abyss-top");
  if (!topBtn || !hint || !rev) return;
  let charge = 0, opened = false, cool = 0, ty = null;
  const GOAL = 450;
  const atBottom = () => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 16;
  const onCard = () => document.body.dataset.tab === "card";
  const paintTop = () => {
    topBtn.hidden = onCard() || (window.scrollY < 260 && !opened);
  };
  const backToTop = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (opened) {
      setTimeout(() => {
        opened = false; charge = 0;
        rev.hidden = true; hint.textContent = ""; hint.classList.remove("show");
        paintTop();
      }, 450);
    }
  };
  topBtn.onclick = backToTop;
  if (abyssTop) abyssTop.onclick = backToTop;
  addEventListener("scroll", paintTop, { passive: true });
  addEventListener("hashchange", () => { opened = false; charge = 0; rev.hidden = true; hint.textContent = ""; hint.classList.remove("show"); paintTop(); });

  const pushResistance = delta => {
    if (opened || onCard() || !$("#modal").hidden || !atBottom()) return;
    charge = Math.min(GOAL, charge + delta * 0.45); // heavy resistance
    clearTimeout(cool);
    if (charge >= GOAL) {
      opened = true;
      hint.textContent = ""; hint.classList.remove("show");
      rev.hidden = false;
      paintTop();
      setTimeout(() => rev.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
      return;
    }
    const pct = charge / GOAL;
    if (pct > 0.2) {
      hint.textContent = pct < 0.55 ? "Nothing down here…" : pct < 0.85 ? "Seriously, stop scrolling…" : "One more push…";
      hint.classList.add("show");
    }
    cool = setTimeout(() => {
      if (!opened) { charge = 0; hint.textContent = ""; hint.classList.remove("show"); }
    }, 1800);
  };

  addEventListener("wheel", e => { if (e.deltaY > 0) pushResistance(e.deltaY); }, { passive: true });
  addEventListener("touchstart", e => { ty = e.touches.length === 1 ? e.touches[0].clientY : null; }, { passive: true });
  addEventListener("touchmove", e => {
    if (ty === null) return;
    const dy = ty - e.touches[0].clientY;
    ty = e.touches[0].clientY;
    if (dy > 0) pushResistance(dy);
  }, { passive: true });
  addEventListener("touchend", () => { ty = null; }, { passive: true });
})();
