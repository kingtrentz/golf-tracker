// Golf tracker gallery: checks the family phrase, then hands out signed upload
// URLs for the public 'photos' bucket, or deletes a photo (file + row).
// Deployed to the Supabase project with verify_jwt off (the phrase is the check).
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

function serviceKey(): string {
  const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (k) return k;
  try { const all = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); return all.default || Object.values(all)[0] as string; } catch { return ""; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });
  const { data: ok, error: ce } = await sb.rpc("gt_check", { p: String(body.p || "") });
  if (ce) return json({ error: ce.message }, 429);
  if (!ok) return json({ error: "Wrong security phrase." }, 403);

  if (body.action === "upload") {
    const n = Math.min(Math.max(Number(body.count) || 1, 1), 20);
    const day = new Date().toISOString().slice(0, 10);
    const out = [];
    for (let i = 0; i < n; i++) {
      const id = crypto.randomUUID();
      const full = `${day}/${id}.jpg`, thumb = `${day}/${id}_t.jpg`;
      const a = await sb.storage.from("photos").createSignedUploadUrl(full);
      const b = await sb.storage.from("photos").createSignedUploadUrl(thumb);
      if (a.error || b.error) return json({ error: (a.error || b.error)!.message }, 500);
      out.push({ path: full, token: a.data.token, thumb, thumbToken: b.data.token });
    }
    return json({ slots: out });
  }

  if (body.action === "delete") {
    const { data: row } = await sb.from("photos").select("id, path, thumb").eq("id", body.id).maybeSingle();
    if (!row) return json({ ok: true });
    await sb.storage.from("photos").remove([row.path, row.thumb].filter(Boolean));
    const { error } = await sb.from("photos").delete().eq("id", row.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }
  return json({ error: "Unknown action" }, 400);
});
