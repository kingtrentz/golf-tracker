// Golf tracker push alerts (phone + Apple Watch). Deployed with verify_jwt off.
// Called by: the cards table trigger (tee off, every saved score, round submitted),
// a once-a-minute sweep while a card is live, and the page (public key, welcome alert).
// Anyone can call it, so it never trusts what it's told: it re-reads the card and only
// sends alerts that card has earned, each one once (push_sent).
// Needs the VAPID_PRIVATE_KEY secret (Trent makes it). No secret = alerts off, nothing sent.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import { createECDH, createPrivateKey } from "node:crypto";
import { Buffer } from "node:buffer";
import { type Alert, type Card, cardAlerts, type World } from "./golf.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const NAMES: Record<string, string> = { trent: "Trent", logan: "Logan", dad: "Dad" };

function serviceKey(): string {
  const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (k) return k;
  try { const all = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); return all.default || Object.values(all)[0] as string; } catch { return ""; }
}
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// The secret can be the raw 32-byte key (base64url, one line) or a PEM private key.
export function vapidKeys(raw: string | undefined): { pub: string; priv: string } | null {
  const s = (raw || "").trim();
  if (!s) return null;
  try {
    let d: Buffer;
    if (s.includes("BEGIN")) {
      const jwk = createPrivateKey(s.replace(/\\n/g, "\n")).export({ format: "jwk" }) as { d?: string };
      d = Buffer.from(jwk.d!.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    } else d = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (d.length !== 32) return null;
    const ec = createECDH("prime256v1"); ec.setPrivateKey(d);
    return { pub: b64u(ec.getPublicKey()), priv: b64u(d) };
  } catch { return null; }
}
const KEYS = vapidKeys(Deno.env.get("VAPID_PRIVATE_KEY"));
if (KEYS) webpush.setVapidDetails(Deno.env.get("VAPID_SUB") || "https://kingtrentz.github.io", KEYS.pub, KEYS.priv);

type Sub = { endpoint: string; p256dh: string; auth: string; player: string | null; prefs: Record<string, boolean>; welcomed: boolean };
// Test hook: tests swap this out so nothing leaves the machine.
export const io = {
  send: (s: Sub, payload: string) => webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: "high", contentEncoding: "aes128gcm" }),
};

async function sendTo(sb: any, subs: Sub[], msg: { title: string; body: string; url: string; tag?: string }) {
  const payload = JSON.stringify(msg);
  let sent = 0;
  await Promise.all(subs.map(async s => {
    try { await io.send(s, payload); sent++; }
    catch (e: any) {
      const code = e?.statusCode;
      if (code === 404 || code === 410) await sb.from("push_subs").delete().eq("endpoint", s.endpoint);
      else console.log("push failed", code || String(e?.message || e).slice(0, 120)); // never log endpoints
    }
  }));
  return sent;
}
// A phone stays quiet for rounds its player is in unless prefs.own is true. Holes: "big" (default) = big moments only, "all" = every hole.
const holesPref = (s: Sub) => { const v: any = s.prefs?.holes; return v === "all" || v === true ? "all" : v === "off" || v === false ? "off" : "big"; };
const wants = (s: Sub, a: Alert) => !(s.player && s.prefs?.own !== true && a.players.includes(s.player)) &&
  (a.kind === "holes" ? holesPref(s) !== "off" : (s.prefs as any)?.[a.kind] !== false);

async function world(sb: any): Promise<World> {
  const [pl, rs] = await Promise.all([sb.from("players").select("slug,starting_index"), sb.from("rounds").select("id,player,played_on,created_at,holes,rating,slope,par,score,match_id")]);
  const start: Record<string, number> = {};
  for (const p of pl.data || []) if (p.starting_index != null) start[p.slug] = Number(p.starting_index);
  const rounds = (rs.data || []).map((r: any) => ({ ...r, rating: Number(r.rating), slope: Number(r.slope), par: Number(r.par) }));
  return { names: NAMES, start, rounds };
}
const num = (c: any): Card => ({ ...c, rating: c.rating == null ? null : Number(c.rating), slope: c.slope == null ? null : Number(c.slope), par: c.par == null ? null : Number(c.par), scores: c.scores || {} });

// Claim an alert key; true only for the one call that gets it first.
async function claim(sb: any, key: string) {
  const { error } = await sb.from("push_sent").insert({ key });
  return !error;
}

export async function processCards(sb: any, cardIds: string[] | "sweep", now = Date.now()) {
  if (!KEYS) return { off: true };
  let q = sb.from("cards").select("*");
  q = cardIds === "sweep" ? q.eq("status", "live").gte("updated_at", new Date(now - 3 * 3600e3).toISOString()) : q.in("id", cardIds);
  const { data: cards } = await q;
  if (!cards?.length) return { cards: 0 };
  const w = await world(sb);
  // First run with a key: everything that already happened counts as sent.
  const first = await claim(sb, "__init");
  const { data: subs } = await sb.from("push_subs").select("*");
  let sent = 0;
  for (const raw of cards) {
    const card = num(raw);
    const age = now - Date.parse(card.updated_at || card.created_at || "");
    if (age > 6 * 3600e3) continue; // old card touched later: stay quiet
    const match = card.status === "done" && card.match_id ? (await sb.from("matches").select("bets").eq("id", card.match_id).maybeSingle()).data : null;
    const alerts = cardAlerts(card, w, now, match);
    const { data: done } = await sb.from("push_sent").select("key").in("key", alerts.map(a => a.key));
    const have = new Set((done || []).map((x: any) => x.key));
    const fresh = alerts.filter(a => !have.has(a.key));
    // If several holes are waiting (a gap in signal), only the newest one goes out:
    // "every hole" phones get the newest hole, "big moments" phones the newest big one.
    const holes = fresh.filter(a => a.kind === "holes"), bigs = holes.filter(a => a.big);
    const lastAll = holes[holes.length - 1], lastBig = bigs[bigs.length - 1];
    for (const a of fresh) {
      if (!(await claim(sb, a.key))) continue;
      if (first) continue;
      const to = (subs || []).filter((s: Sub) => wants(s, a) && (a.kind !== "holes" || (holesPref(s) === "all" ? a === lastAll : a === lastBig)));
      if (to.length) sent += await sendTo(sb, to, { title: a.title, body: a.body, url: a.url, tag: a.tag });
    }
  }
  return { cards: cards.length, sent, first };
}

async function welcome(sb: any, endpoint: string) {
  if (!KEYS || typeof endpoint !== "string") return { ok: false };
  const { data: s } = await sb.from("push_subs").select("*").eq("endpoint", endpoint).maybeSingle();
  if (!s || s.welcomed) return { ok: !!s };
  await sb.from("push_subs").update({ welcomed: true }).eq("endpoint", endpoint);
  const hp = holesPref(s);
  const on = [s.prefs?.start !== false && "tee offs", hp === "all" ? "every hole" : hp === "big" && "big moments", s.prefs?.end !== false && "final scores"].filter(Boolean);
  const who = s.player ? ` Stays quiet for rounds ${NAMES[s.player] || s.player} is playing.` : "";
  const n = await sendTo(sb, [s], { title: "Golf alerts are on", body: `You'll get ${on.join(", ") || "nothing yet"}.${who}`, url: "https://kingtrentz.github.io/golf-tracker/" });
  return { ok: n === 1 };
}

export async function handle(req: Request, sb: any) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method === "GET") return json({ key: KEYS?.pub || null });
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  if (body.action === "key") return json({ key: KEYS?.pub || null });
  if (body.action === "welcome") return json(await welcome(sb, body.endpoint));
  if (body.sweep) return json(await processCards(sb, "sweep"));
  if (typeof body.card === "string" && /^[0-9a-f-]{36}$/i.test(body.card)) return json(await processCards(sb, [body.card]));
  return json({ error: "Bad request" }, 400);
}

if (!Deno.env.get("GOLF_PUSH_TEST")) {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });
  Deno.serve(req => handle(req, sb).catch(e => { console.log("error", String(e?.message || e).slice(0, 200)); return json({ error: "failed" }, 500); }));
}
