# Companion · Supabase Login + Registro

## 1. Ejecuta SQL

En Supabase > SQL Editor ejecuta:

1. `supabase/001_learning_profiles.sql`
2. Opcional: `supabase/002_verify_setup.sql`

## 2. Authentication

En Supabase > Authentication > Providers:

- Email debe estar habilitado.
- Para producción se recomienda mantener **Confirm email** activado.

En Authentication > URL Configuration:

- **Site URL:** la URL de producción de Companion en Vercel.
- **Redirect URLs:** agrega la URL de producción y, para desarrollo, `http://localhost:5173/**`.

## 3. Variables en Vercel

```env
VITE_SUPABASE_URL=https://TU-PROYECTO.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Usa la publishable key, no la secret/service-role key.

## 4. Flujo

### Crear cuenta
Nombre opcional + correo + contraseña (mínimo 8 caracteres).

Si Confirm email está activo, el usuario debe confirmar el correo antes de iniciar sesión.

### Iniciar sesión
Correo + contraseña.

Al iniciar sesión, Companion:

1. lee el progreso local del navegador;
2. consulta el progreso de Supabase para la materia/tema actual;
3. conserva la versión más reciente;
4. sube automáticamente el progreso local si es más nuevo;
5. guarda nuevos quizzes y señales de dificultad en Supabase.

La tabla usa Row Level Security para que cada cuenta solo pueda leer y modificar sus propias filas.

## Documentos explicados

Ejecuta también `supabase/003_study_documents.sql`. Crea `public.study_documents` con RLS por `auth.uid()` para guardar únicamente la versión explicada, glosario, cobertura y progreso de reproducción. El PDF original no se persiste.
