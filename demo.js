// Sample data shown only when config.js has no database keys.
window.GOLF_DEMO = (function () {
  const courses = [
    { id: "c1", name: "Sample Links", tee_name: "White", rating: 70.1, slope: 124, par: 72, city: "Demo", state: "KY" },
    { id: "c2", name: "Practice Ridge", tee_name: "Blue", rating: 72.4, slope: 133, par: 72, city: "Demo", state: "TN" },
    { id: "c3", name: "Range Hollow", tee_name: "White", rating: 68.9, slope: 119, par: 71, city: "Demo", state: "KY" }
  ];
  let seed = 7;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const base = { trent: 88, dad: 92, logan: 95 };
  const rounds = [];
  const matches = [];
  let id = 1;
  const start = new Date("2026-04-04T12:00:00");
  for (let w = 0; w < 22; w++) {
    const d = new Date(start.getTime() + w * 7 * 864e5);
    const date = d.toISOString().slice(0, 10);
    const c = courses[w % 3];
    const together = w % 3 === 0;
    let mid = null;
    if (together) {
      mid = "m" + w;
      matches.push({ id: mid, scheduled_for: date, tee_time: "9:10 AM", course_id: c.id, course_name: c.name, tee_name: c.tee_name,
        rating: c.rating, slope: c.slope, par: c.par, players: ["trent", "dad", "logan"], status: "final",
        scoring: "net", title_match: true, notes: "" });
    }
    for (const p of ["trent", "dad", "logan"]) {
      if (!together && rnd() < 0.35) continue;
      const trend = p === "logan" ? -w * 0.25 : p === "trent" ? -w * 0.12 : 0;
      const score = Math.round(base[p] + trend + (rnd() - 0.5) * 10 + (c.rating - 70));
      rounds.push({ id: "r" + id++, player: p, played_on: date, course_id: c.id, course_name: c.name, tee_name: c.tee_name,
        rating: c.rating, slope: c.slope, par: c.par, holes: 18, score, match_id: mid, notes: "" });
    }
  }
  matches.push({ id: "m-up1", scheduled_for: "2026-11-28", tee_time: "10:30 AM", course_id: "c2", course_name: "Practice Ridge",
    tee_name: "Blue", rating: 72.4, slope: 133, par: 72, players: ["trent", "dad", "logan"], status: "scheduled",
    scoring: "net", title_match: true, notes: "Thanksgiving weekend showdown" });
  matches.push({ id: "m-up2", scheduled_for: "2026-12-12", tee_time: "", course_id: "c1", course_name: "Sample Links",
    tee_name: "White", rating: 70.1, slope: 124, par: 72, players: ["trent", "logan"], status: "scheduled",
    scoring: "gross", title_match: false, notes: "" });
  const guests = [{ id: "demo-g1", first_name: "Sam", last_name: "Sample", handicap: 14.2 }];
  return { courses, rounds, matches, guests };
})();

window.GOLF_DEMO.courses.push({ id: "hgr", name: "Hermitage Golf Course (General's Retreat)", tee_name: "White", rating: 71.2, slope: 128, par: 72, lat: 36.2281182, lng: -86.6399744, pars: [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 4, 5] });
window.GOLF_DEMO.cards = [{"played_on": "2026-11-26", "course_name": "Hermitage Golf Course (General's Retreat)", "tee_name": "", "rating": 71.2, "slope": 128, "par": 72, "pars": [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 4, 5], "sis": [18, 2, 10, 6, 14, 4, 16, 8, 12, 1, 17, 3, 9, 13, 5, 15, 7, 11], "status": "live", "id": "live4", "players": ["trent", "dad", "logan", "g_demo-g1"], "scoring": "match", "scores": {"__meta": {"game": "match", "guests": {"g_demo-g1": {"name": "test test", "hcp": 14.2, "money": false}}}, "trent": [5, 4], "dad": [4, 5], "logan": [5, 5], "g_demo-g1": [6, 4]}, "bets": {"front": 5, "back": 5, "game": 10, "presses": []}}, {"played_on": "2026-11-26", "course_name": "Hermitage Golf Course (General's Retreat)", "tee_name": "", "rating": 71.2, "slope": 128, "par": 72, "pars": [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 4, 5], "sis": [18, 2, 10, 6, 14, 4, 16, 8, 12, 1, 17, 3, 9, 13, 5, 15, 7, 11], "status": "live", "id": "live3", "players": ["trent", "dad", "logan"], "scoring": "match", "scores": {"__meta": {"game": "match"}, "trent": [5, 4, 3], "dad": [4, 5, 3], "logan": [5, 5, 4]}}, {"played_on": "2026-11-26", "course_name": "Hermitage Golf Course (General's Retreat)", "tee_name": "", "rating": 71.2, "slope": 128, "par": 72, "pars": [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 4, 5], "sis": [18, 2, 10, 6, 14, 4, 16, 8, 12, 1, 17, 3, 9, 13, 5, 15, 7, 11], "status": "live", "id": "two", "players": ["trent", "dad"], "scoring": "match", "scores": {"__meta": {"game": "match"}, "trent": [4], "dad": [5]}}, {"played_on": "2026-11-26", "course_name": "Hermitage Golf Course (General's Retreat)", "tee_name": "", "rating": 71.2, "slope": 128, "par": 72, "pars": [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 4, 5], "sis": [18, 2, 10, 6, 14, 4, 16, 8, 12, 1, 17, 3, 9, 13, 5, 15, 7, 11], "status": "live", "id": "solo", "players": ["trent"], "scoring": "gross", "scores": {"__meta": {"game": "stroke", "solo": true}, "trent": [5, 3, 4]}}];
try { localStorage.setItem('golf_phrase','preview'); localStorage.setItem('golf_hole_live4','2'); localStorage.setItem('golf_hole_live3','3'); localStorage.setItem('golf_hole_two','6'); localStorage.setItem('golf_hole_solo','3'); } catch (e) {}
