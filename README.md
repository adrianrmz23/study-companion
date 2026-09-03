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

## Documento explicado · v1.4

Nueva función para convertir PDFs académicos técnicos en una versión explicada completa (no resumen) y escucharla con ElevenLabs.

Flujo:
1. El PDF se lee localmente en el navegador con PDF.js; el archivo original no se envía ni se almacena.
2. Companion elimina la bibliografía final cuando la detecta y divide el contenido en bloques manejables.
3. Cheaper Inference reexplica cada bloque conservando conceptos, definiciones, condiciones, clasificaciones y matices.
4. Una segunda llamada independiente comprueba cobertura. Si detecta omisiones materiales, Companion intenta reparar la sección y la vuelve a verificar.
5. La versión explicada, el glosario, la cobertura y el capítulo donde te quedaste se guardan en Supabase si tienes sesión iniciada.
6. ElevenLabs genera el audio bajo demanda por fragmentos para poder escuchar documentos largos sin el límite de 9,500 caracteres por llamada.

### Migración nueva de Supabase

Ejecuta `supabase/003_study_documents.sql` en SQL Editor antes de usar el guardado entre dispositivos.

No requiere nuevas variables de entorno. Reutiliza las de Cheaper Inference, ElevenLabs y Supabase que ya usa Companion.


## v1.4.1 — Procesamiento resistente de documentos

- Divide PDFs en bloques más pequeños (aprox. 3,600–4,400 caracteres).
- Si una sección excede el tiempo, la divide automáticamente y continúa.
- Reintenta errores temporales del proveedor.
- Un timeout de cobertura ya no detiene todo el documento.
- Guarda la cola de procesamiento y checkpoints temporales en Supabase.
- Los documentos pausados pueden reanudarse desde la biblioteca.
- El texto fuente temporal se elimina de `settings.processing` al completar el documento.
- Vercel Function `api/index.mjs` usa `maxDuration: 120`.

## Companion v1.5

### Documento explicado: cobertura conceptual
El flujo de PDF ahora ofrece tres profundidades:
- **Repaso**: 15–25 min aprox. para volver a pasar por los conceptos centrales.
- **Aprender el documento**: 35–50 min aprox. y opción recomendada. Conserva los conceptos académicos importantes, elimina redundancias y explica tecnicismos sin profundizar más de lo necesario.
- **Profundizar**: 60–90+ min. Usa el documento como base y añade contexto y conexiones.

La duración es orientativa: Companion usa la densidad real del PDF y el audio muestra la estimación basada en el texto finalmente generado.

### Sesiones reales
Las sesiones del sidebar ya no son ejemplos fijos. Puedes:
- crear una nueva sesión;
- volver a una conversación previa;
- cambiar materia/tema y usar el tema como nombre automático de la sesión;
- eliminar sesiones;
- sincronizar conversaciones entre dispositivos con Supabase.

Ejecuta `supabase/004_study_sessions.sql` una sola vez antes de usar la sincronización de sesiones.
