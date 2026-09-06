# Companion v1.7

Tutor de estudio con chat, documentos explicados, biblioteca de audio con caché de ElevenLabs, sesiones reales y sincronización con Supabase.

## Novedades v1.7

- Sesiones guiadas de estudio de 20, 40 o 60 minutos desde la biblioteca de audio.
- Marcadores y notas ligados al minuto exacto de una audioclase.
- Preguntas al tutor mientras escuchas, usando el fragmento de audio actual como contexto.
- Repaso espaciado automático a partir de los conceptos medidos en quizzes.
- Vista de Materias que agrupa documentos, audios, sesiones y dominio por unidad/tema.
- Se conserva el caché privado de MP3 en Supabase para evitar llamadas repetidas a ElevenLabs.

## Supabase

Ejecuta las migraciones en orden. Para esta versión es nueva:

```text
supabase/006_guided_study_notes_review.sql
```

No requiere nuevas variables de entorno.

## Desarrollo

```bash
npm install
npm run dev
```

## Producción

```bash
npm run build
```
