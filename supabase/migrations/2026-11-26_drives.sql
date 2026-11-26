-- Drives (Nov 26, 2026). Additive: one new nullable column, nothing existing changes.
-- "Mark drive" on the live card measures a drive by GPS (tap on the tee, tap at the ball). While the round is
-- live the yards sit in cards.scores.__drives; when the card is submitted each round keeps its own list here,
-- one entry per hole (yards or null), like hole_scores. gt_save writes it with no change (it reads the columns).
alter table public.rounds add column if not exists drives int[];
