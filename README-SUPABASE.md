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

## Sesiones de estudio (v1.5)
Ejecuta también `supabase/004_study_sessions.sql` para activar las sesiones reales del sidebar y sincronizar sus conversaciones entre dispositivos.

La tabla `study_sessions` tiene RLS: cada usuario autenticado solo puede leer, crear, actualizar o borrar sus propias sesiones.

## Companion v1.6 · Biblioteca de audio y caché de ElevenLabs

Ejecuta `supabase/005_audio_library_cache.sql` una sola vez en Supabase SQL Editor. Esta migración añade progreso de escucha a `study_documents` y crea el bucket privado `study-audio` con políticas RLS por usuario.

La primera reproducción de cada tramo usa ElevenLabs. Después el MP3 se guarda en Supabase Storage y las siguientes reproducciones reutilizan ese archivo, incluso en otros dispositivos con la misma cuenta. Si cambias `ELEVENLABS_VOICE_ID` o `ELEVENLABS_MODEL`, Companion genera una nueva versión de caché automáticamente.

La sección **Audios** del sidebar permite buscar, filtrar, continuar, abrir capítulos, renombrar y eliminar documentos de audio. Al eliminar uno también se limpian sus MP3 cacheados.


## Companion v1.7 · Sesiones guiadas, notas y repaso espaciado

Ejecuta `supabase/006_guided_study_notes_review.sql` después de la migración 005.

Crea tres tablas protegidas con RLS:

- `audio_notes`: marcadores y notas ligados al minuto/capítulo de una audioclase.
- `review_items`: cola de repaso espaciado derivada de los conceptos medidos en quizzes.
- `guided_study_runs`: progreso de las sesiones guiadas de 20, 40 o 60 minutos.

No requiere nuevas variables de entorno ni buckets adicionales.
