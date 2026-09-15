-- Daily weigh-in log for The Plastic Fork.
-- Run this once in Supabase → SQL Editor.
--
-- Creates a `weigh_ins` table where each user logs their weight over time,
-- with Row Level Security so a user can only see and write their OWN rows.

create table if not exists public.weigh_ins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  weight numeric not null,
  logged_on date not null default current_date,
  created_at timestamptz not null default now()
);

-- One weigh-in per user per day (a second save that day updates the value).
create unique index if not exists weigh_ins_user_day
  on public.weigh_ins (user_id, logged_on);

-- Lock it down: users only touch their own data.
alter table public.weigh_ins enable row level security;

drop policy if exists "own weigh-ins select" on public.weigh_ins;
create policy "own weigh-ins select"
  on public.weigh_ins for select
  using (auth.uid() = user_id);

drop policy if exists "own weigh-ins insert" on public.weigh_ins;
create policy "own weigh-ins insert"
  on public.weigh_ins for insert
  with check (auth.uid() = user_id);

drop policy if exists "own weigh-ins update" on public.weigh_ins;
create policy "own weigh-ins update"
  on public.weigh_ins for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
