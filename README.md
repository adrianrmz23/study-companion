# Companion 1.1 — ElevenLabs + Vercel

Versión final del tutor de estudio preparada para producción en Vercel.

## Incluye
- Chat pedagógico con Cheaper Inference.
- Modos Explicar, Sintetizar, Ejemplo y No lo entendí.
- Quiz y perfil de aprendizaje.
- Investigación con fuentes externas.
- Tutor adaptativo.
- Audio de respuestas y repaso hablado con ElevenLabs.
- Backend Express compatible con desarrollo local y Vercel Functions.

## ElevenLabs
Se reutiliza la misma convención de Maestría Lab:

```env
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
ELEVENLABS_MODEL=eleven_flash_v2_5
```

También puedes usar `eleven_multilingual_v2`. La salida es `mp3_44100_128`.

## Variables de entorno
Copia `.env.example` a `.env` para desarrollo local. En Vercel configura las mismas variables desde Project Settings → Environment Variables.

```env
CHEAPER_INFERENCE_API_KEY=...
CHEAPER_INFERENCE_MODEL=gpt-5.4
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
ELEVENLABS_MODEL=eleven_flash_v2_5
CROSSREF_MAILTO=tu-correo@ejemplo.com
```

## Desarrollo local
```bash
npm install
npm run dev
```

## Producción
```bash
npm run build
```

La API se sirve bajo `/api/*` mediante una función Express en Vercel.

## Supabase
No es obligatorio para esta versión: el progreso actual permanece en localStorage y el audio se genera bajo demanda. Si después quieres login/sincronización entre dispositivos o cache persistente de MP3, Supabase es el siguiente paso natural.
