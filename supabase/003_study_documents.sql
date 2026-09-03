create extension if not exists pgcrypto;

create table if not exists public.study_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  file_name text not null,
  subject text not null default '',
  topic text not null default '',
  status text not null default 'processing'
    check (status in ('processing', 'complete', 'error')),
  page_count integer not null default 0 check (page_count >= 0),
  source_chars integer not null default 0 check (source_chars >= 0),
  settings jsonb not null default '{}'::jsonb
    check (jsonb_typeof(settings) = 'object'),
  sections jsonb not null default '[]'::jsonb
    check (jsonb_typeof(sections) = 'array'),
  glossary jsonb not null default '[]'::jsonb
    check (jsonb_typeof(glossary) = 'array'),
  coverage jsonb not null default '{}'::jsonb
    check (jsonb_typeof(coverage) = 'object'),
  last_section_index integer not null default 0 check (last_section_index >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.study_documents enable row level security;

drop policy if exists "Users can read their own study documents" on public.study_documents;
drop policy if exists "Users can insert their own study documents" on public.study_documents;
drop policy if exists "Users can update their own study documents" on public.study_documents;
drop policy if exists "Users can delete their own study documents" on public.study_documents;

create policy "Users can read their own study documents"
on public.study_documents
for select
to authenticated
using (auth.uid() = user_id);

create policy "Users can insert their own study documents"
on public.study_documents
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "Users can update their own study documents"
on public.study_documents
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "Users can delete their own study documents"
on public.study_documents
for delete
to authenticated
using (auth.uid() = user_id);

revoke all on table public.study_documents from anon;
grant select, insert, update, delete on table public.study_documents to authenticated;

create index if not exists study_documents_user_updated_idx
on public.study_documents (user_id, updated_at desc);

create index if not exists study_documents_user_status_idx
on public.study_documents (user_id, status, updated_at desc);
