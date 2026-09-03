-- Companion · sincronización de progreso por usuario, materia y tema.
-- Ejecuta este archivo completo en Supabase > SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.learning_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subject text not null,
  topic text not null,
  subject_key text not null,
  topic_key text not null,
  profile jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint learning_profiles_profile_is_object
    check (jsonb_typeof(profile) = 'object'),
  constraint learning_profiles_user_subject_topic_unique
    unique (user_id, subject_key, topic_key)
);

alter table public.learning_profiles enable row level security;

-- Permite volver a ejecutar la query sin errores de políticas duplicadas.
drop policy if exists "Users can read their own learning profiles" on public.learning_profiles;
drop policy if exists "Users can insert their own learning profiles" on public.learning_profiles;
drop policy if exists "Users can update their own learning profiles" on public.learning_profiles;
drop policy if exists "Users can delete their own learning profiles" on public.learning_profiles;

create policy "Users can read their own learning profiles"
on public.learning_profiles
for select
to authenticated
using (auth.uid() = user_id);

create policy "Users can insert their own learning profiles"
on public.learning_profiles
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "Users can update their own learning profiles"
on public.learning_profiles
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "Users can delete their own learning profiles"
on public.learning_profiles
for delete
to authenticated
using (auth.uid() = user_id);

create index if not exists learning_profiles_user_updated_idx
  on public.learning_profiles (user_id, updated_at desc);

create index if not exists learning_profiles_lookup_idx
  on public.learning_profiles (user_id, subject_key, topic_key);

-- No se otorgan permisos a anon. El acceso se hace únicamente como usuario autenticado.
revoke all on table public.learning_profiles from anon;
grant select, insert, update, delete on table public.learning_profiles to authenticated;
