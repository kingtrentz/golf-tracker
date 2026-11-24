// Golf math for alerts. Same rules as app.js (keep them in step): moving handicap,
// group strokes off the low course handicap, match play per pair, hole winners.
// Pure functions only, so they can be tested without a database.

export type Card = {
  id: string; played_on: string; course_name: string; tee_name?: string | null;
  rating: number | null; slope: number | null; par: number | null;
  pars: number[]; sis?: number[] | null; players: string[];
  scores: Record<string, (number | null)[]>; match_id?: string | null;
  status: string; scoring?: string | null; bets?: any; created_at?: string; updated_at?: string;
};
export type Round = { id: string; player: string; played_on: string; created_at?: string; holes: number; rating: number; slope: number; par: number; score: number; match_id?: string | null };
export type World = { names: Record<string, string>; start: Record<string, number>; rounds: Round[] };

const r1 = (n: number) => Math.round(n * 10) / 10;
const byDate = (a: Round, b: Round) => a.played_on.localeCompare(b.played_on) || String(a.created_at || "").localeCompare(String(b.created_at || ""));
const diffOf = (r: Round) => r1((113 / r.slope) * (r.score - r.rating));
const countsForIndex = (r: Round) => r.holes === 18 && !!r.rating && !!r.slope && !!r.score;
const STEP = 0.25;

export function effIndex(rounds: Round[], start: number | null): number | null {
  let idx = start;
  for (const r of rounds.filter(countsForIndex).sort(byDate)) {
    const d = diffOf(r);
    idx = idx == null ? d : idx + STEP * (d - idx);
    idx = Math.max(-10, Math.min(54, idx));
  }
  return idx == null ? null : r1(idx);
}
const courseHcp = (idx: number | null, c: { rating: number; slope: number; par: number }) =>
  idx == null ? null : Math.round(idx * (c.slope / 113) + (c.rating - c.par));
export function strokeIndex(pars: number[], sis?: number[] | null) {
  const n = pars.length;
  if (sis?.length === n && sis.every(x => x >= 1 && x <= n)) return sis;
  if (n === 18) return pars.map((_, i) => i < 9 ? 2 * i + 1 : 2 * (i - 9) + 2);
  return pars.map((_, i) => i + 1);
}
export function strokesOn(ch: number | null, si: number, n: number) {
  if (!ch) return 0;
  if (ch > 0) return Math.floor(ch / n) + (si <= ch % n ? 1 : 0);
  const p = -ch; return -(Math.floor(p / n) + (si > n - (p % n) ? 1 : 0));
}
// Same as app.js cardCh: the card has no course_id, so a 9-hole card with an 18-hole rating doubles its par.
function roundCh(idx: number | null, c: { rating: number | null; slope: number | null; par: number | null }, n: number) {
  if (idx == null || !c.rating || !c.slope || !c.par) return null;
  let par = c.par;
  if (n === 9 && c.rating >= 50 && c.par < 50) par = c.par * 2;
  const full = courseHcp(idx, { rating: c.rating, slope: c.slope, par });
  return n === 9 ? Math.round(full! / 2) : full;
}
function groupPops(chs: Record<string, number | null>, pars: number[], sis?: number[] | null) {
  const n = pars.length, si = strokeIndex(pars, sis), vals = Object.values(chs).map(x => x ?? 0);
  const low = Math.min(...vals);
  return Object.fromEntries(Object.entries(chs).map(([s, ch]) => [s, pars.map((_, i) => vals.length > 1 ? strokesOn((ch ?? 0) - low, si[i], n) : 0)]));
}

export const holeVals = (card: Card, s: string) => { const a = card.scores?.[s] || []; return card.pars.map((_, i) => a[i] ?? null); };
export function cardTotals(card: Card, s: string) {
  const v = holeVals(card, s); let gross = 0, par = 0, thru = 0;
  v.forEach((x, i) => { if (x != null) { gross += x; par += card.pars[i]; thru++; } });
  return { gross, toPar: gross - par, thru, done: thru === card.pars.length };
}
// Handicap going in: ignore rounds posted from this card (they appear once it's submitted).
export function cardChs(card: Card, w: World) {
  const before = w.rounds.filter(r => !(card.match_id && r.match_id === card.match_id) && !(card.created_at && r.created_at && r.created_at >= card.created_at));
  const par = card.par || card.pars.reduce((a, b) => a + b, 0);
  return Object.fromEntries(card.players.map(s => [s, roundCh(effIndex(before.filter(r => r.player === s), w.start[s] ?? null), { rating: card.rating, slope: card.slope, par }, card.pars.length)]));
}
export const cardPops = (card: Card, w: World) => groupPops(cardChs(card, w), card.pars, card.sis);

export function matchPlay(a: string, b: string, va: (number | null)[], vb: (number | null)[], pars: number[], pa: number[], pb: number[], name: (s: string) => string) {
  const n = pars.length;
  const diff = pa.reduce((x, y) => x + y, 0) - pb.reduce((x, y) => x + y, 0);
  let up = 0, thru = 0, closed: { up: number; left: number } | null = null;
  for (let i = 0; i < n; i++) {
    if (va[i] == null || vb[i] == null) continue;
    const na = va[i]! - pa[i], nb = vb[i]! - pb[i];
    const r = na < nb ? 1 : nb < na ? -1 : 0;
    thru++;
    if (closed == null) { up += r; const left = n - (i + 1); if (Math.abs(up) > left) closed = { up, left }; }
  }
  const lead = up > 0 ? a : up < 0 ? b : null, left = n - thru;
  let text: string, winner: string | null = null, done = false, short: string;
  if (closed && closed.left > 0) { winner = closed.up > 0 ? a : b; done = true; text = `${name(winner)} wins ${Math.abs(closed.up)}&${closed.left}`; short = text; }
  else if (thru === n) { done = true; winner = lead; text = lead ? `${name(lead)} wins ${Math.abs(up)} up` : "Halved"; short = text; }
  else if (!thru) { text = "Not started"; short = text; }
  else if (!lead) { text = `All square thru ${thru}`; short = "All square"; }
  else { text = `${name(lead)} ${Math.abs(up)} up${Math.abs(up) === left ? " (dormie)" : ""} thru ${thru}`; short = `${name(lead)} ${Math.abs(up)} up`; }
  return { a, b, up, thru, done, winner, lead, text, short, strokes: Math.abs(diff), getter: diff > 0 ? a : diff < 0 ? b : null };
}
export function cardPairs(card: Card, w: World, pops = cardPops(card, w)) {
  const name = (s: string) => w.names[s] || s;
  const out = [];
  for (let i = 0; i < card.players.length; i++) for (let j = i + 1; j < card.players.length; j++) {
    const a = card.players[i], b = card.players[j];
    out.push(matchPlay(a, b, holeVals(card, a), holeVals(card, b), card.pars, pops[a], pops[b], name));
  }
  return out;
}
export const holeDone = (card: Card, i: number) => card.players.every(s => holeVals(card, s)[i] != null);

// ---------- alert text (short: it has to read on a watch) ----------
export type Alert = { key: string; kind: "start" | "holes" | "end"; title: string; body: string; url: string; players: string[]; big?: boolean; tag?: string };
const SITE = "https://kingtrentz.github.io/golf-tracker/";
const scoreWord = (d: number) => d <= -3 ? "albatross" : d === -2 ? "eagle" : d === -1 ? "birdie" : d === 0 ? "par" : d === 1 ? "bogey" : d === 2 ? "double" : d === 3 ? "triple" : `+${d}`;
const courseShort = (c: Card) => { const m = /^(.*\S) \(([^()]+)\)$/.exec(c.course_name || ""); return m ? m[2] : (c.course_name || "Golf"); };
const vsLine = (c: Card, w: World) => c.players.map(s => w.names[s] || s).join(" vs ");

export function startAlert(card: Card, w: World): Alert {
  const nm = (s: string) => w.names[s] || s;
  const n = card.pars.length;
  const chs = cardChs(card, w), low = Math.min(...card.players.map(s => chs[s] ?? 0));
  const gets = card.players.length > 1 && card.scoring !== "gross" ? card.players.filter(s => (chs[s] ?? 0) - low > 0).map(s => `${nm(s)} gets ${(chs[s] ?? 0) - low}`) : [];
  const body = [`${vsLine(card, w)}${n === 9 ? ", 9 holes" : ""}.`, gets.length ? gets.join(", ") + "." : ""].filter(Boolean).join(" ");
  return { key: `start:${card.id}`, kind: "start", title: `Teeing off at ${courseShort(card)}`, body: (card.tee_name ? `${card.tee_name} tees. ` : "") + body, url: SITE + "#live", players: card.players };
}

export function holeAlert(card: Card, w: World, i: number): Alert {
  const nm = (s: string) => w.names[s] || s;
  const pops = cardPops(card, w);
  const par = card.pars[i];
  const lines: string[] = [];
  let big = card.players.some(s => holeVals(card, s)[i]! - par <= -1);
  if (card.players.length > 1) {
    const cutAt = (k: number) => ({ ...card, scores: Object.fromEntries(card.players.map(s => [s, holeVals(card, s).map((v, j) => j <= k ? v : null)])) });
    const prev = i > 0 ? cardPairs(cutAt(i - 1), w, pops) : null, now = cardPairs(cutAt(i), w, pops);
    now.forEach((p, k) => {
      const q = prev?.[k]; const was = q && !q.done ? q.up : 0, upNow = p.up, n = card.pars.length;
      if (q?.done) return;
      if (p.done) big = true;                                   // match decided
      else if (was !== 0 && upNow === 0) big = true;            // squared it
      else if (was * upNow < 0) big = true;                     // lead switched
      else if (upNow !== 0 && Math.abs(upNow) === n - p.thru) big = true; // dormie
    });
    const nets = card.players.map(s => [s, holeVals(card, s)[i]! - pops[s][i]] as const);
    const best = Math.min(...nets.map(x => x[1])), win = nets.filter(x => x[1] === best);
    const scores = card.players.map(s => `${nm(s)} ${holeVals(card, s)[i]}`).join(", ");
    const pop = win.length === 1 && pops[win[0][0]][i] > 0 && holeVals(card, win[0][0])[i]! >= Math.min(...card.players.filter(s => s !== win[0][0]).map(s => holeVals(card, s)[i]!)) ? " with a stroke" : "";
    const tie = win.length < card.players.length ? `${win.map(x => nm(x[0])).join(" and ")} tie for the hole` : "Hole halved";
    lines.push(win.length === 1 ? `${nm(win[0][0])} wins the hole${pop}. ${scores}.` : `${tie}. ${scores}.`);
    // match status as of this hole (later holes ignored)
    const cut = { ...card, scores: Object.fromEntries(card.players.map(s => [s, holeVals(card, s).map((v, k) => k <= i ? v : null)])) };
    const pairs = cardPairs(cut, w, pops);
    if (pairs.length === 1) lines.push(`${pairs[0].text}.`);
    else lines.push(pairs.map(p => p.done ? p.text : p.lead ? `${p.short} on ${nm(p.lead === p.a ? p.b : p.a)}` : `${nm(p.a)}-${nm(p.b)} square`).join(" · ") + ` thru ${i + 1}.`);
  } else {
    const s = card.players[0], v = holeVals(card, s)[i]!;
    lines.push(`${nm(s)} ${v} (${scoreWord(v - par)}). ${fmtPar(cardTotals(card, s), card, i)} thru ${i + 1}.`);
  }
  // birdies or better, blowups (triple bogey or worse)
  const extra = card.players.map(s => [s, holeVals(card, s)[i]! - par] as const).filter(([, d]) => d <= -1 || d >= 3)
    .map(([s, d]) => d <= -1 ? `${scoreWord(d)[0].toUpperCase() + scoreWord(d).slice(1)} for ${nm(s)}!` : `${nm(s)} blew up with ${[8, 11, 18].includes(par + d) ? "an" : "a"} ${par + d}.`);
  if (card.players.length > 1) lines.push(...extra);
  return { key: `hole:${card.id}:${i}`, kind: "holes", title: `Hole ${i + 1} · par ${par} · ${courseShort(card)}`, body: lines.join(" "), url: SITE + "#live", players: card.players, big, tag: `golf-${card.id}` };
}
function fmtPar(_t: unknown, card: Card, i: number) {
  const s = card.players[0]; let d = 0;
  holeVals(card, s).forEach((v, k) => { if (k <= i && v != null) d += v - card.pars[k]; });
  return d === 0 ? "E" : d > 0 ? `+${d}` : String(d);
}

export function endAlert(card: Card, w: World, match: any | null): Alert {
  const nm = (s: string) => w.names[s] || s;
  const n = card.pars.length;
  const tot = card.players.map(s => ({ s, t: cardTotals(card, s) }));
  const fin = tot.filter(x => x.t.done).sort((a, b) => a.t.gross - b.t.gross);
  const lines: string[] = [];
  if (card.players.length > 1 && card.scoring !== "net" && card.scoring !== "gross") {
    const pairs = cardPairs(card, w);
    const multi = pairs.length > 1;
    lines.push(pairs.map(p => {
      const other = (x: string | null) => nm(x === p.a ? p.b : p.a);
      if (!p.thru) return `${nm(p.a)} v ${nm(p.b)} not played`;
      if (!multi) return p.text;
      if (p.done) return p.winner ? p.text.replace(" wins ", ` beat ${other(p.winner)} `) : `${nm(p.a)} and ${nm(p.b)} halved`;
      return p.lead ? `${p.short} on ${other(p.lead)} thru ${p.thru}` : `${nm(p.a)}-${nm(p.b)} square thru ${p.thru}`;
    }).join(" · ") + ".");
  }
  if (fin.length) lines.push(fin.map(x => `${nm(x.s)} ${x.t.gross} (${x.t.toPar === 0 ? "E" : x.t.toPar > 0 ? "+" + x.t.toPar : x.t.toPar})`).join(", ") + ".");
  else lines.push(`Ended early, thru ${Math.max(0, ...tot.map(x => x.t.thru))} of ${n}. Nothing posted.`);
  const res = match?.bets?.result;
  const pays = res?.manual?.pays || res?.pays;
  const amt = (a: number) => "$" + (a % 1 ? a.toFixed(2) : a);
  if (Array.isArray(pays)) lines.push(pays.length ? pays.map((p: any) => `${nm(p.from)} pays ${nm(p.to)} ${amt(+p.amt)}`).join(", ") + "." : "Money: nobody pays.");
  return { key: `end:${card.id}`, kind: "end", title: `Final: ${courseShort(card)}`, body: lines.join(" "), url: SITE + "#h2h", players: card.players };
}

// Which alerts a card has earned right now. A hole goes out once everyone has a score on it and
// either a later hole has a score or the card sat still for `settle` ms (so a quick fix still lands).
export function cardAlerts(card: Card, w: World, now: number, match: any = null, settle = 45000): Alert[] {
  const out: Alert[] = [];
  if (card.status === "live") {
    out.push(startAlert(card, w));
    const idle = now - Date.parse(card.updated_at || card.created_at || new Date(now).toISOString()) >= settle;
    const n = card.pars.length;
    for (let i = 0; i < n; i++) {
      if (!holeDone(card, i)) continue;
      const later = card.players.some(s => holeVals(card, s).some((v, k) => k > i && v != null));
      if (later || idle) out.push(holeAlert(card, w, i));
    }
  } else if (card.status === "done") out.push(endAlert(card, w, match));
  return out;
}
