-- Companion v1.5 · sesiones de estudio sincronizadas entre dispositivos.
-- Ejecuta todo este archivo en Supabase > SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.study_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Nueva sesión',
  subject text not null default '',
  topic text not null default '',
  messages jsonb not null default '[]'::jsonb
    check (jsonb_typeof(messages) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.study_sessions enable row level security;

drop policy if exists "Users can read their own study sessions" on public.study_sessions;
drop policy if exists "Users can insert their own study sessions" on public.study_sessions;
drop policy if exists "Users can update their own study sessions" on public.study_sessions;
drop policy if exists "Users can delete their own study sessions" on public.study_sessions;

create policy "Users can read their own study sessions"
on public.study_sessions for select to authenticated
using (auth.uid() = user_id);

create policy "Users can insert their own study sessions"
on public.study_sessions for insert to authenticated
with check (auth.uid() = user_id);

create policy "Users can update their own study sessions"
on public.study_sessions for update to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "Users can delete their own study sessions"
on public.study_sessions for delete to authenticated
using (auth.uid() = user_id);

revoke all on table public.study_sessions from anon;
grant select, insert, update, delete on table public.study_sessions to authenticated;

create index if not exists study_sessions_user_updated_idx
on public.study_sessions (user_id, updated_at desc);
