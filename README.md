# McGrath Masters (golf tracker)

Live site: https://kingtrentz.github.io/golf-tracker/

Trent vs Dad vs Logan: rounds, handicaps, head to head, upcoming matches, and the Master Champ belt.
by kingtrentz⚡️ x claude

## How it works
- Plain static site on GitHub Pages: `index.html`, `style.css`, `app.js`, `config.js`.
- Data lives in a free Supabase database. Anyone can view. Adding or editing needs the family security phrase, which is checked inside the database (stored hashed, never in this code). Each phone remembers it until you tap Lock.
- Courses near me: uses your phone's location to list saved courses, OpenGolfAPI courses, and OpenStreetMap golf courses nearby. OpenGolfAPI fills tee rating, slope, par, and hole pars when it has them; otherwise type them once from the scorecard and the course is saved with its location.
- Live scorecard: score hole by hole while you play. Every tap saves; with no signal, scores stay on the phone and save when it reconnects. Anyone with the link can follow along. Finish round posts each player's total to their log (and the match result if it's linked to a match).
- Handicaps use USGA World Handicap System math (best 8 of last 20 differentials, with the fewer-than-20 table) on final scores. Unofficial: no hole-by-hole caps or daily conditions adjustment.
- `.github/workflows/keepalive.yml` pings the database every 3 days so Supabase doesn't pause it in the off-season.

## Database setup (already done for the live site)
1. supabase.com > new project (free plan, US East).
2. SQL Editor > paste all of `setup.sql` > Run. Then run the last commented statement with your phrase to set it.
3. Project Settings > API: copy the Project URL and the publishable (anon) key into `config.js`.

## Using it
- Tap **Enter scores** (top right), type the phrase, then the green **+** to start a live scorecard, post a final score, or schedule a match.
- Scheduled matches have a **Start scorecard** button on the day.
- To finish a match: Head to Head tab > the match > **Post results**. Scores go into each player's round log too.
- Edit names, colors, or the site title in `config.js`.
