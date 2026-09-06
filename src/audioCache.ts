import { supabase } from "./supabase";

const AUDIO_BUCKET = "study-audio";
let cacheVersionPromise: Promise<string> | null = null;

async function getCacheVersion() {
  if (!cacheVersionPromise) {
    cacheVersionPromise = fetch("/api/audio-health")
      .then((res) => res.ok ? res.json() : null)
      .then((data) => String(data?.cacheVersion || "voice-v1").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "voice-v1")
      .catch(() => "voice-v1");
  }
  return cacheVersionPromise;
}

async function digestText(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function getAudioCachePath({
  userId,
  documentId,
  text
}: {
  userId: string;
  documentId: string;
  text: string;
}) {
  const version = await getCacheVersion();
  const digest = await digestText(`${version}\n${text.trim()}`);
  return `${userId}/${documentId}/${version}-${digest}.mp3`;
}

async function generateSpeechBlob(text: string) {
  const response = await fetch("/api/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error || "No pude generar este tramo con ElevenLabs.");
  }
  return response.blob();
}

export async function getOrCreateAudioBlob({
  userId,
  documentId,
  text
}: {
  userId?: string | null;
  documentId?: string | null;
  text: string;
}): Promise<{ blob: Blob; source: "supabase" | "elevenlabs" }> {
  if (!userId || !documentId || !supabase) {
    return { blob: await generateSpeechBlob(text), source: "elevenlabs" };
  }

  const path = await getAudioCachePath({ userId, documentId, text });
  const { data: cached, error: downloadError } = await supabase.storage
    .from(AUDIO_BUCKET)
    .download(path);

  if (!downloadError && cached) {
    return { blob: cached, source: "supabase" };
  }

  const blob = await generateSpeechBlob(text);
  const { error: uploadError } = await supabase.storage
    .from(AUDIO_BUCKET)
    .upload(path, blob, {
      contentType: "audio/mpeg",
      cacheControl: "31536000",
      upsert: true
    });

  if (uploadError) {
    console.warn("No pude guardar el audio en Supabase Storage; la reproducción continuará sin caché:", uploadError.message);
  }

  return { blob, source: "elevenlabs" };
}

export async function deleteCachedDocumentAudio(userId: string, documentId: string) {
  if (!supabase) return;
  const folder = `${userId}/${documentId}`;
  const paths: string[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase.storage
      .from(AUDIO_BUCKET)
      .list(folder, { limit: 100, offset, sortBy: { column: "name", order: "asc" } });
    if (error) {
      // Si aún no existe el bucket o no hay objetos, la eliminación del documento puede continuar.
      console.warn("No pude listar el caché del documento:", error.message);
      break;
    }
    if (!data?.length) break;
    for (const item of data) {
      if (item.name) paths.push(`${folder}/${item.name}`);
    }
    if (data.length < 100) break;
    offset += data.length;
  }

  if (paths.length) {
    const { error } = await supabase.storage.from(AUDIO_BUCKET).remove(paths);
    if (error) console.warn("No pude limpiar todos los MP3 cacheados:", error.message);
  }
}
