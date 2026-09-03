-- Query opcional de verificación. Debe devolver la tabla con RLS habilitado.
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'learning_profiles';

-- Lista las políticas activas.
select
  policyname,
  cmd,
  roles,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'learning_profiles'
order by policyname;
