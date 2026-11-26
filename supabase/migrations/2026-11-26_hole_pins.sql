-- Hole pins (Nov 26, 2026). Additive: one new table and one new write function.
-- A tee and/or green point tapped on the satellite for a hole the map data is missing or has wrong.
-- Keyed by course name (the same name the live card and greens.json use) and hole number.
-- Saved points win over OpenStreetMap. Nothing existing is dropped or changed. Run once in Supabase > SQL Editor.
create table if not exists public.hole_pins (
  id uuid primary key default gen_random_uuid(),
  course_name text not null check (length(course_name) between 1 and 200),
  hole int not null check (hole between 1 and 36),
  tee_lat double precision, tee_lng double precision,
  green_lat double precision, green_lng double precision,
  updated_at timestamptz not null default now(),
  unique (course_name, hole)
);
alter table public.hole_pins enable row level security;
drop policy if exists "public read" on public.hole_pins;
create policy "public read" on public.hole_pins for select to anon, authenticated using (true);

-- Save one hole's tee and/or green (phrase checked). A null pair keeps the map's own point.
-- Both pairs null removes the saved hole, so the map data shows again.
create or replace function public.gt_pin(p text, course text, hole_no int, tlat double precision, tlng double precision,
  glat double precision, glng double precision) returns void
language plpgsql security definer set search_path = '' as $f$
begin
  if not private.phrase_ok(p) then raise exception 'Wrong security phrase.'; end if;
  if (tlat is null) <> (tlng is null) or (glat is null) <> (glng is null) then raise exception 'Bad point'; end if;
  if tlat is null and glat is null then
    delete from public.hole_pins where course_name = course and hole = hole_no; return;
  end if;
  insert into public.hole_pins (course_name, hole, tee_lat, tee_lng, green_lat, green_lng, updated_at)
  values (course, hole_no, tlat, tlng, glat, glng, now())
  on conflict (course_name, hole) do update set tee_lat = excluded.tee_lat, tee_lng = excluded.tee_lng,
    green_lat = excluded.green_lat, green_lng = excluded.green_lng, updated_at = now();
end $f$;
grant execute on function public.gt_pin(text,text,int,double precision,double precision,double precision,double precision) to anon, authenticated;
