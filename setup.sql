-- McGrath Masters database setup.
-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Anyone can read (public site). Writes only go through the gt_* functions,
-- which check the family security phrase on the server. Set the phrase with the
-- last statement in this file (it's stored hashed, never in the site code).

create table if not exists courses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tee_name text,
  rating numeric(4,1) not null,
  slope int not null check (slope between 55 and 155),
  par int not null,
  city text,
  state text,
  ogapi_id text,
  created_at timestamptz not null default now()
);

create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  scheduled_for date not null,
  tee_time text,
  course_id uuid references courses(id) on delete set null,
  course_name text,
  tee_name text,
  rating numeric(4,1),
  slope int,
  par int,
  players text[] not null,
  status text not null default 'scheduled' check (status in ('scheduled','final')),
  scoring text not null default 'net' check (scoring in ('net','gross')),
  title_match boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

create table if not exists rounds (
  id uuid primary key default gen_random_uuid(),
  player text not null,
  played_on date not null,
  course_id uuid references courses(id) on delete set null,
  course_name text not null,
  tee_name text,
  rating numeric(4,1) not null,
  slope int not null check (slope between 55 and 155),
  par int not null,
  holes int not null default 18 check (holes in (9,18)),
  score int not null check (score between 18 and 200),
  match_id uuid references matches(id) on delete set null,
  notes text,
  creatcreate table if not exists players (
  slug text primary key,
  starting_index numeric(4,1),
  updated_at timestamptz not null default now()
);

alter table courses add column if not exists pars int[];
alter table courses add column if not exists lat double precision;
alter table courses add column if not exists lng double precision;
alter table rounds  add column if not exists hole_scores int[];

create table if not exists cards (
  id uuid primary key default gen_random_uuid(),
  played_on date not null,
  course_id uuid references courses(id) on delete set null,
  course_name text not null,
  tee_name text,
  rating numeric(4,1),
  slope int,
  par int,
  pars int[] not null,
  players text[] not null,
  scores jsonb not null default '{}'::jsonb,
  match_id uuid references matches(id) on delete set null,
  status text not null default 'live' check (status in ('live','done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Bets (front 9, back 9, game, presses) on live cards; stakes + money result on matches.
alter table cards   add column if not exists bets jsonb;
alter table matches add column if not exists bets jsonb;

-- Gallery: public "photos" storage bucket (read by anyone). Uploads and deletes go through
-- the "gallery" edge function, which checks the phrase and hands out signed upload URLs.
create table if not exists photos (
  id uuid primary key default gen_random_uuid(),
  path text not null, thumb text, caption text,
  taken_on date not null default current_date,
  match_id uuid references matches(id) on delete set null,
  width int, height int,
  created_at timestamptz not null default now()
);
alter table photos enable row level security;
drop policy if exists "public read" on photos;
create policy "public read" on photos for select to anon, authenticated using (true);
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 5242880, array['image/jpeg','image/png','image/webp']) on conflict (id) do nothing;

alter table courses enable row level security;
alter table matches enable row level security;
alter table rounds  enable row level security;
alter table players enable row level security;
alter table cards   enable row level security;

do $$
declare t text;
begin
  foreach t in array array['courses','matches','rounds','players','cards'] loop
    execute format('drop policy if exists "public read" on %I', t);
    execute format('drop policy if exists "members write" on %I', t);
    execute format('create policy "public read" on %I for select to anon, authenticated using (true)', t);
  end loop;
end $$;

-- ---------- security phrase ----------
create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from anon, authenticated, public;
create table if not exists private.app_secret (id int primary key default 1 check (id = 1), phrase_hash text not null);
create table if not exists private.failed_tries (at timestamptz not null default now());

-- Phrase check: case and outer spaces don't matter. 25 wrong tries in 10 minutes locks writes for 10 minutes.
create or replace function private.phrase_ok(p text) returns boolean
language plpgsql security definer set search_path = '' as $f$
declare ok boolean;
begin
  delete from private.failed_tries where at < now() - interval '10 minutes';
  if (select count(*) from private.failed_tries) >= 25 then raise exception 'Too many wrong tries. Wait 10 minutes.'; end if;
  select extensions.crypt(coalesce(lower(trim(p)),''), phrase_hash) = phrase_hash into ok from private.app_secret where id = 1;
  if not coalesce(ok,false) then insert into private.failed_tries default values; perform pg_sleep(0.7); return false; end if;
  return true;
end $f$;

create or replace function public.gt_check(p text) returns boolean
language sql security definer set search_path = '' as $f$ select private.phrase_ok(p) $f$;

create or replace function public.gt_save(p text, tbl text, data jsonb, rid uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $f$
declare cols text; out_id uuid;
begin
  if not private.phrase_ok(p) then raise exception 'Wrong security phrase.'; end if;
  if tbl not in ('courses','matches','rounds','cards','photos') then raise exception 'Bad table'; end if;
  select string_agg(quote_ident(c.column_name), ',') into cols from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = tbl and c.column_name in (select jsonb_object_keys(data))
     and c.column_name not in ('id','created_at','created_by');
  if tbl = 'cards' then data := data || jsonb_build_object('updated_at', now()); cols := coalesce(cols || ',', '') || 'updated_at'; end if;
  if cols is null then return rid; end if;
  if rid is null then
    execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1) returning id', tbl, cols, cols, tbl) using data into out_id;
  else
    execute format('update public.%I set (%s) = (select %s from jsonb_populate_record(null::public.%I, $1)) where id = $2 returning id', tbl, cols, cols, tbl) using data, rid into out_id;
  end if;
  return out_id;
end $f$;

create or replace function public.gt_delete(p text, tbl text, rid uuid) returns void
language plpgsql security definer set search_path = '' as $f$
begin
  if not private.phrase_ok(p) then raise exception 'Wrong security phrase.'; end if;
  if tbl not in ('courses','matches','rounds','cards') then raise exception 'Bad table'; end if;
  execute format('delete from public.%I where id = $1', tbl) using rid;
end $f$;

create or replace function public.gt_set_start(p text, slug text, v numeric) returns void
language plpgsql security definer set search_path = '' as $f$
begin
  if not private.phrase_ok(p) then raise exception 'Wrong security phrase.'; end if;
  insert into public.players (slug, starting_index, updated_at) values (slug, v, now())
  on conflict (slug) do update set starting_index = excluded.starting_index, updated_at = now();
end $f$;

-- One player's hole scores on a live card, so two phones can score the same card.
create or replace function public.gt_card_score(p text, cid uuid, slug text, vals jsonb, pars int[] default null) returns timestamptz
language plpgsql security definer set search_path = '' as $f$
declare t timestamptz;
begin
  if not private.phrase_ok(p) then raise exception 'Wrong security phrase.'; end if;
  update public.cards set scores = case when slug is null then scores else jsonb_set(scores, array[slug], vals, true) end,
         pars = coalesce(gt_card_score.pars, cards.pars), updated_at = now()
   where id = cid and status = 'live' returning updated_at into t;
  if t is null then raise exception 'That scorecard is already finished.'; end if;
  return t;
end $f$;

revoke all on function private.phrase_ok(text) from public, anon, authenticated;
grant execute on function public.gt_check(text), public.gt_save(text,text,jsonb,uuid), public.gt_delete(text,text,uuid),
  public.gt_set_start(text,text,numeric), public.gt_card_score(text,uuid,text,jsonb,int[]) to anon, authenticated;

-- Set or change the phrase (lowercase). Replace the text in quotes, run, then delete it from your SQL editor history.
-- insert into private.app_secret (id, phrase_hash) values (1, extensions.crypt('your phrase here', extensions.gen_salt('bf', 10)))
-- on conflict (id) do update set phrase_hash = excluded.phrase_hash;
