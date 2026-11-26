-- Guests (Nov 26, 2026). Additive: one new table, and gt_save / gt_delete also accept 'guests'.
-- Nothing existing is dropped or changed. Run once in Supabase > SQL Editor.
create table if not exists public.guests (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text,
  handicap numeric(4,1) check (handicap between -10 and 54),
  created_at timestamptz not null default now()
);
alter table public.guests enable row level security;
drop policy if exists "public read" on public.guests;
create policy "public read" on public.guests for select to anon, authenticated using (true);

create or replace function public.gt_save(p text, tbl text, data jsonb, rid uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $f$
declare cols text; out_id uuid;
begin
  if not private.phrase_ok(p) then raise exception 'Wrong security phrase.'; end if;
  if tbl not in ('courses','matches','rounds','cards','photos','guests') then raise exception 'Bad table'; end if;
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
  if tbl not in ('courses','matches','rounds','cards','guests') then raise exception 'Bad table'; end if;
  execute format('delete from public.%I where id = $1', tbl) using rid;
end $f$;
