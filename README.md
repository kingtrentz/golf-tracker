# McGrath Masters (golf tracker)

Live site: https://kingtrentz.github.io/golf-tracker/

Trent vs Dad vs Logan: rounds, handicaps, head to head, upcoming matches, and the Master Champ belt.
by kingtrentz⚡️ x claude

## How it works
- Plain static site on GitHub Pages: `index.html`, `style.css`, `app.js`, `config.js`.
- Data lives in a free Supabase database. Anyone can view; only the 3 logins can add or edit.
- Course lookup uses OpenGolfAPI (free, no key) to fill in tee rating, slope, and par. Courses you use get saved for next time.
- Handicaps use USGA World Handicap System math (best 8 of last 20 differentials, with the fewer-than-20 table) on final scores. Unofficial: no hole-by-hole caps or daily conditions adjustment.
- `.github/workflows/keepalive.yml` pings the database every 3 days so Supabase doesn't pause it in the off-season.

## One-time database setup (about 10 minutes)
1. Go to supabase.com, sign in with GitHub, and create a new project (name it `golf`, free plan, any region in the US East).
2. SQL Editor > New query > paste all of `setup.sql` > Run.
3. Authentication > Sign In / Providers: turn **off** "Allow new users to sign up". Keep Email enabled.
4. Authentication > Users > Add user > Create new user, three times (Trent, Dad, Logan). Give each an email and password and check "Auto Confirm User".
5. Project Settings > API (or Data API): copy the Project URL and the `anon` public key into `config.js`.
6. Upload the new `config.js` to the repo. The site goes live with real data a minute later.

## Using it
- Tap **Sign in** (top right), then the green **+** to post a round or schedule a match.
- To finish a match: Head to Head tab > the match > **Post results**. Scores go into each player's round log too.
- Edit names, colors, or the site title in `config.js`.
