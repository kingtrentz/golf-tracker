"""Build greens.json (hole-by-hole green outlines) from OpenStreetMap for the saved courses.
Usage: python tools/greens.py  (reads courses from Supabase with the public key, writes greens.json)
Each hole is matched by number + par (+ hole handicap when OSM has it) so a club with two courses,
or a neighbour course in the same box, can't get mixed up. Holes OSM doesn't have are left out."""
import json, math, re, sys, urllib.request
CFG = open("config.js").read()
URL = re.search(r'supabaseUrl: "([^"]+)"', CFG).group(1); KEY = re.search(r'supabaseAnonKey: "([^"]+)"', CFG).group(1)
get = lambda u, h={}: json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "golf-tracker (kingtrentz)", **h}), timeout=120))
rows = get(f"{URL}/rest/v1/courses?select=name,lat,lng,pars,sis", {"apikey": KEY})
courses = {}
for r in rows:  # one entry per course (all tees share pars/sis)
    if r["pars"] and len(r["pars"]) >= 9: courses.setdefault(r["name"], r)
locs = {}
for r in rows:
    if r["lat"] is not None: locs.setdefault(r["name"].split(" (")[0], (r["lat"], r["lng"]))
def pip(pt, poly):
    c = False; j = len(poly) - 1
    for i in range(len(poly)):
        (yi, xi), (yj, xj) = poly[i], poly[j]
        if (yi > pt[0]) != (yj > pt[0]) and pt[1] < (xj - xi) * (pt[0] - yi) / (yj - yi) + xi: c = not c
        j = i
    return c
def simplify(pts, tol=0.6):  # Douglas-Peucker in metres; closed rings are split at the far point first
    if len(pts) < 4: return [[round(p[0], 6), round(p[1], 6)] for p in pts]
    if pts[0] == pts[-1]:
        k = max(range(len(pts)), key=lambda i: (pts[i][0] - pts[0][0]) ** 2 + ((pts[i][1] - pts[0][1]) * 0.8) ** 2)
        return simplify(pts[:k + 1], tol) + simplify(pts[k:], tol)[1:]
    lat0 = pts[0][0]; kx = 111320 * math.cos(math.radians(lat0)); ky = 110540
    P = [((p[1]) * kx, p[0] * ky) for p in pts]
    def rec(a, b):
        (x1, y1), (x2, y2) = P[a], P[b]; dmax, idx = 0, a
        L = math.hypot(x2 - x1, y2 - y1) or 1e-9
        for i in range(a + 1, b):
            d = abs((x2 - x1) * (y1 - P[i][1]) - (x1 - P[i][0]) * (y2 - y1)) / L
            if d > dmax: dmax, idx = d, i
        return rec(a, idx)[:-1] + rec(idx, b) if dmax > tol else [a, b]
    return [[round(pts[i][0], 6), round(pts[i][1], 6)] for i in rec(0, len(pts) - 1)]
norm = lambda s: re.sub(r"golf|country|club|course|municipal|links|the|[^a-z]", "", (s or "").lower())
def dist(a, b): return math.hypot((a[0] - b[0]) * 110540, (a[1] - b[1]) * 111320 * math.cos(math.radians(a[0])))
out, report = {}, []
cache = {}
clubs = {}
for name, c in courses.items(): clubs.setdefault(name.split(" (")[0], []).append((name, c))
for base, members in sorted(clubs.items()):
    if base not in locs: report += [f"{n}: no location saved, skipped" for n, _ in members]; continue
    lat, lng = locs[base]
    els = {}
    for dy in (-1, 0, 1):  # 3x3 tiles around the club (the OSM API caps one call's size)
        for dx in (-1, 0, 1):
            y, x, h = lat + dy * 0.012, lng + dx * 0.015, 0.006
            for e in get(f"https://api.openstreetmap.org/api/0.6/map.json?bbox={x-h*1.25},{y-h},{x+h*1.25},{y+h}")["elements"]:
                els[(e["type"], e["id"])] = e
    j = {"elements": list(els.values())}
    N = {e["id"]: (e["lat"], e["lon"]) for e in j["elements"] if e["type"] == "node"}
    W = {e["id"]: e for e in j["elements"] if e["type"] == "way"}
    co = lambda w: [N[n] for n in w["nodes"] if n in N]
    greens = [co(w) for w in W.values() if w.get("tags", {}).get("golf") == "green"]
    hs = []
    for w in W.values():
        t = w.get("tags", {})
        if t.get("golf") != "hole" or not t.get("ref", "").isdigit(): continue
        line = co(w)
        if len(line) < 2: continue
        pin = line[-1]
        g = next((g for g in greens if pip(pin, g)), None) or min(greens, key=lambda g: dist(g[0], pin), default=None)
        if g and dist(g[0], pin) > 80 and not pip(pin, g): g = None
        if g: hs.append({"ref": int(t["ref"]), "par": t.get("par"), "hcp": t.get("handicap"), "tee": line[0], "pin": pin, "g": g})
    # Chain holes into routings: hole k's green is a short walk from hole k+1's tee.
    parent = list(range(len(hs)))
    def find(i):
        while parent[i] != i: parent[i] = parent[parent[i]]; i = parent[i]
        return i
    for a, A in enumerate(hs):
        for b, B in enumerate(hs):
            if B["ref"] == A["ref"] + 1 and dist(A["pin"], B["tee"]) < 300: parent[find(a)] = find(b)
    comps = {}
    for i, h in enumerate(hs): comps.setdefault(find(i), []).append(h)
    for name, c in members:
        best, score = None, 0
        for comp in comps.values():
            sc = 0
            for h in comp:
                i = h["ref"] - 1
                if i >= len(c["pars"]): sc -= 1; continue
                sc += 1 if str(c["pars"][i]) == h["par"] else -3
                if h["hcp"] and c.get("sis") and len(c["sis"]) == len(c["pars"]): sc += 2 if str(c["sis"][i]) == h["hcp"] else -5
            if sc > score: best, score = comp, sc
        if not best: report.append(f"{name}: not mapped in OpenStreetMap"); continue
        got = {}
        for h in best:
            if h["ref"] <= len(c["pars"]) and str(c["pars"][h["ref"] - 1]) == h["par"]: got.setdefault(h["ref"], []).append(h)
        good = {k: {"g": simplify(v[0]["g"]), "t": [round(v[0]["tee"][0], 6), round(v[0]["tee"][1], 6)]} for k, v in sorted(got.items()) if len(v) == 1}
        out[name] = good
        miss = [i + 1 for i in range(len(c["pars"])) if i + 1 not in good]
        report.append(f"{name}: {len(good)}/{len(c['pars'])} holes" + (f", missing {miss}" if miss else ""))
json.dump(out, open("greens.json", "w"), separators=(",", ":"))
print("\n".join(report))
print("greens.json", len(json.dumps(out, separators=(",", ":"))), "bytes")
