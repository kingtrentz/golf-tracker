# McGrath Masters (golf tracker)

Live site: https://kingtrentz.github.io/golf-tracker/

Trent vs Dad vs Logan: rounds, handicaps, head to head, live scorecards, upcoming matches, and the Master Champ belt.
by kingtrentz⚡️ x claude

This README is the knowledge doc for the repo: what the site does, how the data works, how to deploy it, and known issues. It describes the code as of Nov 26, 2026 (live card fast-tap fix). Anything not read directly from the code is marked *(inferred)*.

**Working rule for this site:** careful cleanup in small steps, each approved before it goes live. No redesigns.

## What the site does
Tabs (built in `app.js`):
- **Live** (only while a round is on): full-screen on-course scorecard with big +/- buttons. Every tap saves; with no signal, scores wait on the phone and save when it reconnects. Anyone with the link can follow along.
  - **Auto-advance:** when a tap fills the last empty score on a hole, the card shows "Hole N next…" and moves on 1.6 seconds after the last tap (more taps restart the wait). Fixing a hole that was already complete doesn't move you. The hole being scored is pinned on the phone, so a card started on another phone no longer jumps the instant the last score goes in.
  - **Fast taps:** for 0.45 seconds after the hole changes, taps on the card are ignored, so quick taps can't land on the next hole or skip one. Buttons use `touch-action: manipulation`, so fast double taps don't zoom the page (pinch zoom still works). Code: `goHole`, `cardAction`, `ADV_MS`, `HOLE_SETTLE_MS` in `app.js`.
- **Head to Head:** matchups, handicaps, upcoming rounds, the Master Champ belt, and every hole-by-hole scorecard (Scorecards section).
- **One tab per player** (Trent, Logan, Dad): round log, handicap, best scores, and that player's hole-by-hole scorecards (Scorecards section).
- **Gallery:** course photos, filterable by course.

Features worth knowing:
- **Games:** match play, stroke play (gross), net stroke play, skins, Stableford. Strokes are given off the lowest course handicap in the group, on the hardest holes. Optional per-pair bets with presses (ties push).
- **Handicaps:** each player starts at a starting handicap; after every 18-hole round it moves 25% of the way toward that round's differential ((score - rating) x 113 / slope). `handicapStep` in `config.js` overrides the 25% (it isn't set now, so 25% applies). Unofficial, not the USGA best-8-of-20 index. The same math is copied in `supabase/functions/push/golf.ts`; keep the two in step.
- **Master Champ:** title matches only count when all three play.
- **Scorecards (read only):** the Scorecards section on Head to Head and each player tab lists finished rounds that have hole-by-hole scores, newest first (5 shown, the rest under Show all). Tapping one (or the "hole by hole" tag in a round log) opens the card: holes, par, each player's strokes, Out/In/Tot, final score and to par, with birdies circled and bogeys boxed. Rounds of the same match (or same day, course and tee) share one card. Data: `rounds.hole_scores`, saved when a live card is submitted; pars come from the saved course (`courses.pars`) and are left off if the course has none. Rounds posted as a final score only have no scorecard. Code: `rscGroups`, `roundScorecardsSection`, `roundScorecardView` in `app.js`.
- **Courses near me:** uses the phone's location to list saved courses, OpenGolfAPI courses and OpenStreetMap golf courses nearby. OpenGolfAPI fills rating, slope, par and hole pars when it has them; otherwise type them once from the scorecard and the course is saved with its location.
- **On-course yardages and hole maps:** one-tap GPS yardage, hole outlines and rough yardages, and satellite hole maps (Esri World Imagery tiles) with drag-to-measure. Green and hole outlines come from OpenStreetMap: `greens.json` for saved courses (built by `tools/greens.py`), otherwise the page asks Overpass once and caches it on the phone.
- **Theme:** dark by default, with a Light mode toggle (saved per phone).
- **Visitor counts:** GoatCounter script in `index.html`.

## App features (installable web app)
- `manifest.webmanifest`, icons (`icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`) and `sw.js` make it installable to the Home Screen.
- **Service worker (`sw.js`, cache `golf-shell-v1`):** network first for the page, with the last copy as a fallback when there's no signal. Versioned app files (`?v=`) also keep a last copy so the app opens on a course with no bars. Supabase data and photos aren't cached.
- **Push alerts** (phone and Apple Watch): tee off, holes (big moments, all, or off), and round finished. Each phone says which player it is and can stay quiet for rounds that player is in.

## How the data works
There is no build step and no scheduled data pull. The site is plain static files on GitHub Pages; all data lives in a free Supabase project.

| Piece | Where | What it does |
|---|---|---|
| Static site | `index.html`, `style.css`, `app.js`, `config.js`, `demo.js` | Reads Supabase directly from the browser with the public (publishable) key in `config.js` |
| Tables | `setup.sql` | `courses`, `matches`, `rounds`, `players` (starting handicaps), `cards` (live scorecards), `photos` |
| Writes | `setup.sql` functions `gt_save`, `gt_delete`, `gt_set_start`, `gt_card_score`, `gt_check` | Every write needs the family security phrase, checked inside the database (stored hashed in `private.app_secret`, never in this code). 25 wrong tries in 10 minutes locks writes for 10 minutes. Each phone remembers the phrase until you tap Lock |
| Photos | `photos` table, public `photos` storage bucket (5 MB, JPEG/PNG/WebP) | Uploads and deletes go through the `gallery` edge function, which checks the phrase and hands out signed upload URLs |
| Push alerts | `supabase/push.sql`, edge function `push` (`index.ts` + `golf.ts`) | `push_subs` and `push_sent` tables (private). A trigger on `cards` calls the function on tee off, every saved score and when a round is submitted; a pg_cron job (`golf-push-sweep`) calls it every minute while a card is live; `golf-push-cleanup` prunes old records daily. The function re-reads the card and sends each alert once. Needs the `VAPID_PRIVATE_KEY` secret in Supabase |
| Keep-alive | `.github/workflows/keepalive.yml` | Reads one row every 3 days (cron `17 14 */3 * *`) so the free Supabase project doesn't pause |

With no Supabase keys in `config.js`, the site runs on the sample data in `demo.js`.

## Files
| Path | What it is |
|---|---|
| `index.html` | Page shell; sets theme before load; loads `config.js`, `demo.js`, `app.js` with `?v=` version stamps |
| `app.js` | The whole app (tabs, scoring, handicaps, live card, yardages, maps, gallery, alerts) |
| `style.css` | Styles, dark and light palettes |
| `config.js` | Site title, tagline, Supabase URL and public key, default course per club, player names and colors |
| `demo.js` | Sample data used only when `config.js` has no database keys |
| `greens.json` | Green and hole outlines from OpenStreetMap for saved courses |
| `tools/greens.py` | Rebuilds `greens.json` (`python tools/greens.py`, run from the repo root) |
| `setup.sql` | Database tables, write functions, phrase check, photo bucket |
| `supabase/push.sql` | Push alert tables, trigger and cron jobs (applied Nov 23, 2026) |
| `supabase/functions/gallery/index.ts` | Photo upload and delete function |
| `supabase/functions/push/` | Push alert sender (`index.ts`) and golf math (`golf.ts`) |
| `crest.webp`, `logo.png`, `scrolled-too-far.webp` | Crest watermark, logo, and the "gotcha" image at the very bottom of the page |

## Deploying
- **Site changes:** push to `main`. GitHub Pages deploys straight from the branch (GitHub's own "pages build and deployment" run, no build step of ours), usually within a minute.
- **Bump the `?v=` stamp** in `index.html` (and in `app.js` for `greens.json`) for any file you change, or phones keep the old copy.
- **Pull right before pushing:** Claude and Antigravity both push to this repo.
- **Database changes:** run SQL in the Supabase SQL Editor. Edge functions are deployed to Supabase with JWT verification off (the phrase is the check).

### Database setup (already done for the live site)
1. supabase.com > new project (free plan, US East).
2. SQL Editor > paste all of `setup.sql` > Run. Then run the last commented statement with your phrase to set it.
3. Project Settings > API: copy the Project URL and the publishable (anon) key into `config.js`.
4. For alerts: run `supabase/push.sql`, deploy the `push` and `gallery` functions, and set `VAPID_PRIVATE_KEY`.

## Using it
- Tap **Enter scores** (top right), type the phrase, then the green **+** to start a live scorecard, post a final score, or schedule a match.
- Scheduled matches have a **Start scorecard** button on the day.
- To finish a match: Head to Head tab > the match > **Post results**. Scores go into each player's round log too.
- Edit names, colors, or the site title in `config.js`.

## Known issues
- The handicap and match math lives in two places (`app.js` and `supabase/functions/push/golf.ts`). A change to one needs the same change in the other, or alerts will disagree with the site.
