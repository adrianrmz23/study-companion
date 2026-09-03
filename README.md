# Companion 1.2 — ElevenLabs + Vercel + Supabase

Versión de Companion con tutor IA, investigación, quiz adaptativo, ElevenLabs y progreso sincronizado entre dispositivos mediante Supabase.

## Qué añade Supabase

- Inicio de sesión por correo con código OTP de 6 dígitos.
- Sincronización del perfil de aprendizaje por **usuario + materia + tema**.
- Conserva localStorage como respaldo cuando no hay sesión o falla la red.
- Al iniciar sesión por primera vez, importa a Supabase el progreso local actual si todavía no existe en la nube.
- RLS: cada usuario únicamente puede leer y modificar su propio progreso.
- Estado visual: local / sincronizando / sincronizado / error.

## Variables de entorno

```env
CHEAPER_INFERENCE_API_KEY=...
CHEAPER_INFERENCE_MODEL=gpt-5.4

ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
ELEVENLABS_MODEL=eleven_flash_v2_5

CROSSREF_MAILTO=...

VITE_SUPABASE_URL=https://TU-PROYECTO.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

`VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY` son valores públicos del cliente. **Nunca uses la service role key en Vite/React.**

## 1. Crear la tabla

Ejecuta `supabase/001_learning_profiles.sql` en el SQL Editor del proyecto Supabase. Activa RLS y crea las políticas incluidas en el mismo archivo.

## 2. Configurar el código de 6 dígitos

En Supabase ve a **Authentication → Email Templates** y en la plantilla de inicio por email incluye `{{ .Token }}` para que el correo muestre el OTP que Companion solicita.

## 3. Vercel

Agrega las dos variables `VITE_SUPABASE_*` en **Production, Preview y Development** si quieres usar los tres entornos. Después haz un nuevo deployment porque Vite incorpora esas variables durante el build.

## 4. Probar

```bash
npm install
npm run dev
```

1. Abre Companion.
2. En la barra lateral pulsa **Sincronizar progreso**.
3. Introduce tu correo y el código recibido.
4. Completa un quiz o pulsa **No lo entendí**.
5. Comprueba que aparezca **Progreso sincronizado**.
6. Abre Companion en otro dispositivo, inicia sesión con el mismo correo y entra al mismo tema.
7. El dominio, quizzes, aciertos y conceptos deben aparecer automáticamente.

## Modelo de datos

Tabla `learning_profiles`:

- `user_id`
- `subject` / `topic`
- `subject_key` / `topic_key`
- `profile` JSONB
- `updated_at`

Hay una fila única por usuario + materia + tema.
