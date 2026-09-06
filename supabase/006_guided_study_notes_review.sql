-- Companion v1.7: sesiones guiadas, notas/marcadores y repaso espaciado

create extension if not exists pgcrypto;

create table if not exists public.audio_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid not null references public.study_documents(id) on delete cascade,
  section_index integer not null default 0 check (section_index >= 0),
  segment_index integer not null default 0 check (segment_index >= 0),
  segment_second double precision not null default 0 check (segment_second >= 0),
  document_second double precision not null default 0 check (document_second >= 0),
  kind text not null default 'bookmark' check (kind in ('bookmark','note')),
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.audio_notes enable row level security;

drop policy if exists "Users can read own audio notes" on public.audio_notes;
drop policy if exists "Users can insert own audio notes" on public.audio_notes;
drop policy if exists "Users can update own audio notes" on public.audio_notes;
drop policy if exists "Users can delete own audio notes" on public.audio_notes;

create policy "Users can read own audio notes"
on public.audio_notes for select to authenticated
using (auth.uid() = user_id);

create policy "Users can insert own audio notes"
on public.audio_notes for insert to authenticated
with check (auth.uid() = user_id);

create policy "Users can update own audio notes"
on public.audio_notes for update to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "Users can delete own audio notes"
on public.audio_notes for delete to authenticated
using (auth.uid() = user_id);

create index if not exists audio_notes_user_document_idx
on public.audio_notes(user_id, document_id, document_second);

revoke all on table public.audio_notes from anon;
grant select, insert, update, delete on table public.audio_notes to authenticated;


create table if not exists public.review_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subject text not null,
  topic text not null,
  concept text not null,
  subject_key text not null,
  topic_key text not null,
  concept_key text not null,
  source_document_id uuid null references public.study_documents(id) on delete set null,
  mastery_score integer not null default 0 check (mastery_score between 0 and 100),
  repetitions integer not null default 0 check (repetitions >= 0),
  interval_days integer not null default 1 check (interval_days >= 1),
  ease_factor double precision not null default 2.3 check (ease_factor >= 1.3),
  next_review_at timestamptz not null default now(),
  last_result text null check (last_result is null or last_result in ('again','hard','good','easy')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint review_items_unique_concept unique(user_id, subject_key, topic_key, concept_key)
);

alter table public.review_items enable row level security;

drop policy if exists "Users can read own review items" on public.review_items;
drop policy if exists "Users can insert own review items" on public.review_items;
drop policy if exists "Users can update own review items" on public.review_items;
drop policy if exists "Users can delete own review items" on public.review_items;

create policy "Users can read own review items"
on public.review_items for select to authenticated
using (auth.uid() = user_id);

create policy "Users can insert own review items"
on public.review_items for insert to authenticated
with check (auth.uid() = user_id);

create policy "Users can update own review items"
on public.review_items for update to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "Users can delete own review items"
on public.review_items for delete to authenticated
using (auth.uid() = user_id);

create index if not exists review_items_due_idx
on public.review_items(user_id, next_review_at);

revoke all on table public.review_items from anon;
grant select, insert, update, delete on table public.review_items to authenticated;


create table if not exists public.guided_study_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid not null references public.study_documents(id) on delete cascade,
  duration_minutes integer not null check (duration_minutes in (20,40,60)),
  plan jsonb not null default '{}'::jsonb,
  current_step integer not null default 0 check (current_step >= 0),
  status text not null default 'active' check (status in ('active','complete','abandoned')),
  started_at timestamptz not null default now(),
  completed_at timestamptz null,
  updated_at timestamptz not null default now()
);

alter table public.guided_study_runs enable row level security;

drop policy if exists "Users can read own guided runs" on public.guided_study_runs;
drop policy if exists "Users can insert own guided runs" on public.guided_study_runs;
drop policy if exists "Users can update own guided runs" on public.guided_study_runs;
drop policy if exists "Users can delete own guided runs" on public.guided_study_runs;

create policy "Users can read own guided runs"
on public.guided_study_runs for select to authenticated
using (auth.uid() = user_id);

create policy "Users can insert own guided runs"
on public.guided_study_runs for insert to authenticated
with check (auth.uid() = user_id);

create policy "Users can update own guided runs"
on public.guided_study_runs for update to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "Users can delete own guided runs"
on public.guided_study_runs for delete to authenticated
using (auth.uid() = user_id);

create index if not exists guided_study_runs_user_status_idx
on public.guided_study_runs(user_id, status, updated_at desc);

revoke all on table public.guided_study_runs from anon;
grant select, insert, update, delete on table public.guided_study_runs to authenticated;
