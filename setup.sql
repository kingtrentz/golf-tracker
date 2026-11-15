-- McGrath Masters database setup.
-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Anyone can read (public site). Only signed-in users can add, edit, or delete,
-- and the only accounts are the 3 you create with signups turned off.

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
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

alter table courses enable row level security;
alter table matches enable row level security;
alter table rounds  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['courses','matches','rounds'] loop
    execute format('drop policy if exists "public read" on %I', t);
    execute format('drop policy if exists "members write" on %I', t);
    execute format('create policy "public read" on %I for select to anon, authenticated using (true)', t);
    execute format('create policy "members write" on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;
