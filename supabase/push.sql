-- Push alerts (phone + Apple Watch). Applied to the "golf" Supabase project on Nov 23, 2026.
-- Subscriptions are private: the browser can only add/remove its own through gt_push_sub.
-- The "push" edge function sends; it's pinged by the cards trigger and a 1-minute sweep while a round is live.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create table if not exists public.push_subs (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  player text,                       -- which player this phone is (stays quiet for rounds they play)
  prefs jsonb not null default '{"start": true, "holes": "big", "end": true}',  -- holes: big (big moments) | all | off
  welcomed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.push_sent (key text primary key, at timestamptz not null default now());
alter table public.push_subs enable row level security;
alter table public.push_sent enable row level security;
revoke all on public.push_subs, public.push_sent from anon, authenticated;

-- op 'sub' adds or updates this phone; 'unsub' removes it. Only real push services, max 40 phones.
create or replace function public.gt_push_sub(op text, sub jsonb, prefs jsonb default '{}', me text default null)
returns boolean language plpgsql security definer set search_path = '' as $f$
declare ep text := sub->>'endpoint'; host text; k text := sub#>>'{keys,p256dh}'; a text := sub#>>'{keys,auth}';
begin
  if ep is null or length(ep) > 1000 or ep !~ '^https://[A-Za-z0-9.-]+(:443)?/' then raise exception 'Bad subscription'; end if;
  host := lower(substring(ep from '^https://([A-Za-z0-9.-]+)'));
  if not (host = 'web.push.apple.com' or host like '%.push.apple.com' or host = 'fcm.googleapis.com'
          or host = 'updates.push.services.mozilla.com' or host like '%.push.services.mozilla.com' or host like '%.notify.windows.com') then
    raise exception 'Unsupported push service';
  end if;
  if op = 'unsub' then delete from public.push_subs where endpoint = ep; return true; end if;
  if op <> 'sub' then raise exception 'Bad op'; end if;
  if k is null or a is null or k !~ '^[A-Za-z0-9_-]{80,100}=*$' or a !~ '^[A-Za-z0-9_-]{16,30}=*$' then raise exception 'Bad subscription keys'; end if;
  if me is not null and not exists (select 1 from public.players where slug = me) then raise exception 'Unknown player'; end if;
  if not exists (select 1 from public.push_subs where endpoint = ep) then
    if (select count(*) from public.push_subs) >= 40 then raise exception 'Alert list is full'; end if;
    if (select count(*) from public.push_subs where created_at > now() - interval '1 hour') >= 15 then raise exception 'Too many sign-ups, try later'; end if;
  end if;
  insert into public.push_subs (endpoint, p256dh, auth, player, prefs)
  values (ep, k, a, me, jsonb_build_object(
    'start', coalesce(prefs->>'start', 'true') = 'true',
    'holes', case when prefs->>'holes' in ('all', 'big', 'off') then prefs->>'holes' else 'big' end,
    'end',   coalesce(prefs->>'end',   'true') = 'true'))
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, player = excluded.player,
    prefs = excluded.prefs, updated_at = now();
  return true;
end $f$;
revoke all on function public.gt_push_sub(text, jsonb, jsonb, text) from public;
grant execute on function public.gt_push_sub(text, jsonb, jsonb, text) to anon, authenticated;

-- Tee off (card created), every saved score, round submitted (status -> done): ping the push function.
-- Never lets an alert problem block a score from saving.
create or replace function private.push_ping() returns trigger language plpgsql security definer set search_path = '' as $f$
begin
  if (tg_op = 'INSERT' and new.status = 'live')
     or (tg_op = 'UPDATE' and (new.scores is distinct from old.scores or new.status is distinct from old.status)) then
    begin
      perform net.http_post(url := 'https://vqgyeqrjvghrzxrirkff.supabase.co/functions/v1/push',
        body := jsonb_build_object('card', new.id), headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 8000);
    exception when others then null;
    end;
  end if;
  return null;
end $f$;
revoke all on function private.push_ping() from public, anon, authenticated;
drop trigger if exists cards_push on public.cards;
create trigger cards_push after insert or update on public.cards for each row execute function private.push_ping();

-- Every minute while a round is live: catches the last hole and holes nobody moved on from.
select cron.unschedule(jobid) from cron.job where jobname in ('golf-push-sweep', 'golf-push-cleanup');
select cron.schedule('golf-push-sweep', '* * * * *', $c$
  select net.http_post(url := 'https://vqgyeqrjvghrzxrirkff.supabase.co/functions/v1/push',
    body := '{"sweep": true}'::jsonb, headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 8000)
  where exists (select 1 from public.cards where status = 'live' and updated_at > now() - interval '3 hours')
$c$);
select cron.schedule('golf-push-cleanup', '23 9 * * *', $c$
  delete from public.push_sent where at < now() - interval '60 days' and key <> '__init';
  delete from cron.job_run_details where end_time < now() - interval '3 days';
$c$);
