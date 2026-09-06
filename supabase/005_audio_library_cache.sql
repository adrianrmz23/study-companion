-- Companion v1.6 · Biblioteca de audio + progreso + caché privado de ElevenLabs

alter table public.study_documents
  add column if not exists audio_progress jsonb not null default '{}'::jsonb
  check (jsonb_typeof(audio_progress) = 'object');

alter table public.study_documents
  add column if not exists last_played_at timestamptz;

create index if not exists study_documents_user_last_played_idx
on public.study_documents (user_id, last_played_at desc nulls last);

-- Bucket privado. Los MP3 se guardan como:
-- <user_id>/<document_id>/<voice_version>-<hash_del_texto>.mp3
insert into storage.buckets (id, name, public)
values ('study-audio', 'study-audio', false)
on conflict (id) do update set public = false;

drop policy if exists "Users can read their own study audio" on storage.objects;
drop policy if exists "Users can upload their own study audio" on storage.objects;
drop policy if exists "Users can update their own study audio" on storage.objects;
drop policy if exists "Users can delete their own study audio" on storage.objects;

create policy "Users can read their own study audio"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'study-audio'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "Users can upload their own study audio"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'study-audio'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "Users can update their own study audio"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'study-audio'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'study-audio'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "Users can delete their own study audio"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'study-audio'
  and (storage.foldername(name))[1] = auth.uid()::text
);
