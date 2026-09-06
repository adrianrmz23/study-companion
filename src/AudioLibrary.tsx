import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  Clock3,
  FastForward,
  FileAudio,
  Headphones,
  Library,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  RefreshCcw,
  Rewind,
  Search,
  Square,
  Trash2
} from "lucide-react";
import { deleteCachedDocumentAudio, getOrCreateAudioBlob } from "./audioCache";
import { supabase } from "./supabase";

type GlossaryItem = { term: string; meaning: string };
type AudioSection = {
  id: string;
  title: string;
  startPage: number;
  endPage: number;
  explainedText: string;
  glossary?: GlossaryItem[];
};

type AudioProgress = {
  sectionIndex?: number;
  segmentIndex?: number;
  segmentRatio?: number;
  documentSecond?: number;
  completed?: boolean;
  rate?: number;
  updatedAt?: string;
};

type AudioDocument = {
  id: string;
  title: string;
  file_name: string;
  subject: string;
  topic: string;
  page_count: number;
  sections: AudioSection[];
  settings: { mode?: string } | null;
  audio_progress: AudioProgress | null;
  last_played_at: string | null;
  created_at: string;
  updated_at: string;
};

type TimelineItem = {
  sectionIndex: number;
  segmentIndex: number;
  text: string;
  startSecond: number;
  endSecond: number;
  estimatedSeconds: number;
};

type Props = {
  userId?: string | null;
  onRequireAuth?: () => void;
  onCreateAudio?: () => void;
};

const rates = [0.8, 1, 1.25, 1.5];

function splitSpeechText(text: string, maxChars = 2400) {
  const cleaned = text.trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxChars) return [cleaned];
  const paragraphs = cleaned.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if ((current + "\n\n" + paragraph).trim().length <= maxChars) {
      current = `${current}${current ? "\n\n" : ""}${paragraph}`;
      continue;
    }
    if (current.trim()) chunks.push(current.trim());
    current = "";
    if (paragraph.length <= maxChars) {
      current = paragraph;
      continue;
    }
    const sentences = paragraph.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      if ((current + " " + sentence).trim().length > maxChars && current.trim()) {
        chunks.push(current.trim());
        current = sentence;
      } else {
        current = `${current} ${sentence}`.trim();
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function estimateSpeechSeconds(text: string) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(4, (words / 150) * 60);
}

function buildTimeline(document: AudioDocument | null): TimelineItem[] {
  if (!document) return [];
  let cursor = 0;
  const output: TimelineItem[] = [];
  document.sections.forEach((section, sectionIndex) => {
    splitSpeechText(section.explainedText).forEach((text, segmentIndex) => {
      const estimatedSeconds = estimateSpeechSeconds(text);
      output.push({
        sectionIndex,
        segmentIndex,
        text,
        startSecond: cursor,
        endSecond: cursor + estimatedSeconds,
        estimatedSeconds
      });
      cursor += estimatedSeconds;
    });
  });
  return output;
}

function formatTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const total = Math.round(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function modeLabel(mode?: string | null) {
  if (mode === "review") return "Repaso";
  if (mode === "deep") return "Profundizar";
  return "Aprender el documento";
}

function progressFor(document: AudioDocument, totalSeconds: number) {
  const progress = document.audio_progress || {};
  if (progress.completed) return 100;
  const elapsed = Math.max(0, Number(progress.documentSecond) || 0);
  if (!totalSeconds) return 0;
  return Math.max(0, Math.min(99, Math.round((elapsed / totalSeconds) * 100)));
}

export default function AudioLibrary({ userId, onRequireAuth, onCreateAudio }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const persistAtRef = useRef(0);
  const rateRef = useRef(1);

  const [documents, setDocuments] = useState<AudioDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "progress" | "done">("all");
  const [subjectFilter, setSubjectFilter] = useState("all");
  const [selected, setSelected] = useState<AudioDocument | null>(null);
  const [expandedChapters, setExpandedChapters] = useState(false);

  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioError, setAudioError] = useState("");
  const [audioSource, setAudioSource] = useState<"supabase" | "elevenlabs" | null>(null);
  const [sectionIndex, setSectionIndex] = useState(0);
  const [segmentIndex, setSegmentIndex] = useState(0);
  const [segmentCount, setSegmentCount] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [scrubValue, setScrubValue] = useState<number | null>(null);
  const [rate, setRate] = useState(1);

  const timeline = useMemo(() => buildTimeline(selected), [selected]);
  const totalSeconds = timeline.length ? timeline[timeline.length - 1].endSecond : 0;
  const activeTimeline = useMemo(
    () => timeline.find((item) => item.sectionIndex === sectionIndex && item.segmentIndex === segmentIndex) || null,
    [timeline, sectionIndex, segmentIndex]
  );
  const estimatedElapsed = useMemo(() => {
    if (!activeTimeline) return Number(selected?.audio_progress?.documentSecond) || 0;
    const ratio = duration > 0 ? Math.max(0, Math.min(1, currentTime / duration)) : 0;
    return activeTimeline.startSecond + activeTimeline.estimatedSeconds * ratio;
  }, [activeTimeline, currentTime, duration, selected]);
  const displayElapsed = scrubValue ?? estimatedElapsed;
  const remaining = Math.max(0, totalSeconds - displayElapsed);

  const subjects = useMemo(() => {
    return Array.from(new Set(documents.map((doc) => doc.subject).filter(Boolean))).sort((a, b) => a.localeCompare(b, "es"));
  }, [documents]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("es-MX");
    return documents.filter((doc) => {
      const docTimeline = buildTimeline(doc);
      const docTotal = docTimeline.length ? docTimeline[docTimeline.length - 1].endSecond : 0;
      const percent = progressFor(doc, docTotal);
      if (filter === "progress" && !(percent > 0 && percent < 100)) return false;
      if (filter === "done" && percent < 100) return false;
      if (subjectFilter !== "all" && doc.subject !== subjectFilter) return false;
      if (!needle) return true;
      return [doc.title, doc.subject, doc.topic, doc.file_name].join(" ").toLocaleLowerCase("es-MX").includes(needle);
    });
  }, [documents, filter, query, subjectFilter]);

  const cleanupAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setPlaying(false);
    setPaused(false);
    setAudioLoading(false);
    setCurrentTime(0);
    setDuration(0);
  };

  useEffect(() => {
    rateRef.current = rate;
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  useEffect(() => () => cleanupAudio(), []);

  const loadDocuments = async () => {
    if (!userId || !supabase) {
      setDocuments([]);
      return;
    }
    setLoading(true);
    setError("");
    const { data, error: fetchError } = await supabase
      .from("study_documents")
      .select("id,title,file_name,subject,topic,page_count,sections,settings,audio_progress,last_played_at,created_at,updated_at")
      .eq("user_id", userId)
      .eq("status", "complete")
      .order("last_played_at", { ascending: false, nullsFirst: false })
      .order("updated_at", { ascending: false })
      .limit(500);
    setLoading(false);
    if (fetchError) {
      setError(fetchError.message.includes("audio_progress")
        ? "Falta ejecutar la migración 005_audio_library_cache.sql en Supabase."
        : fetchError.message);
      return;
    }
    const rows = (data || []).map((row: any) => ({
      ...row,
      sections: Array.isArray(row.sections) ? row.sections : [],
      audio_progress: row.audio_progress && typeof row.audio_progress === "object" ? row.audio_progress : {}
    })) as AudioDocument[];
    setDocuments(rows);
    if (selected) {
      const refreshed = rows.find((item) => item.id === selected.id);
      if (refreshed) setSelected(refreshed);
    }
  };

  useEffect(() => {
    void loadDocuments();
  }, [userId]);

  const persistProgress = async (
    document: AudioDocument,
    next: AudioProgress,
    force = false
  ) => {
    if (!userId || !supabase) return;
    const nowMs = Date.now();
    if (!force && nowMs - persistAtRef.current < 8000) return;
    persistAtRef.current = nowMs;
    const normalized: AudioProgress = {
      ...next,
      rate: rateRef.current,
      updatedAt: new Date().toISOString()
    };
    const lastPlayedAt = new Date().toISOString();
    setDocuments((current) => current.map((item) => item.id === document.id
      ? { ...item, audio_progress: normalized, last_played_at: lastPlayedAt }
      : item));
    if (selected?.id === document.id) setSelected((current) => current ? { ...current, audio_progress: normalized, last_played_at: lastPlayedAt } : current);
    const { error: updateError } = await supabase
      .from("study_documents")
      .update({ audio_progress: normalized, last_played_at: lastPlayedAt })
      .eq("id", document.id)
      .eq("user_id", userId);
    if (updateError) console.warn("No pude guardar el punto de escucha:", updateError.message);
  };

  const playSegment = async (
    document: AudioDocument,
    targetSection: number,
    targetSegment: number,
    startRatio = 0,
    startPaused = false
  ) => {
    const section = document.sections[targetSection];
    if (!section) return;
    const segments = splitSpeechText(section.explainedText);
    const text = segments[targetSegment];
    if (!text) return;

    cleanupAudio();
    setSelected(document);
    setSectionIndex(targetSection);
    setSegmentIndex(targetSegment);
    setSegmentCount(segments.length);
    setAudioLoading(true);
    setAudioError("");
    setAudioSource(null);

    try {
      const result = await getOrCreateAudioBlob({ userId, documentId: document.id, text });
      setAudioSource(result.source);
      const url = URL.createObjectURL(result.blob);
      objectUrlRef.current = url;
      const audio = new Audio(url);
      audio.playbackRate = rateRef.current;
      audio.preload = "auto";
      let started = false;

      const startPlayback = async () => {
        if (started) return;
        started = true;
        const mediaDuration = Number.isFinite(audio.duration) ? audio.duration : 0;
        setDuration(mediaDuration);
        if (mediaDuration > 0 && startRatio > 0) {
          audio.currentTime = Math.max(0, Math.min(mediaDuration - 0.05, mediaDuration * Math.max(0, Math.min(1, startRatio))));
          setCurrentTime(audio.currentTime);
        }
        if (startPaused) {
          setPlaying(true);
          setPaused(true);
          setAudioLoading(false);
          return;
        }
        try {
          await audio.play();
          setPlaying(true);
          setPaused(false);
          setAudioLoading(false);
        } catch {
          setPlaying(true);
          setPaused(true);
          setAudioLoading(false);
          setAudioError("El navegador bloqueó la reproducción automática. Pulsa Continuar.");
        }
      };

      audio.onloadedmetadata = () => { void startPlayback(); };
      audio.ondurationchange = () => {
        if (Number.isFinite(audio.duration)) setDuration(audio.duration);
      };
      audio.ontimeupdate = () => {
        const mediaTime = audio.currentTime || 0;
        setCurrentTime(mediaTime);
        if (Number.isFinite(audio.duration)) setDuration(audio.duration);
        const item = buildTimeline(document).find((candidate) => candidate.sectionIndex === targetSection && candidate.segmentIndex === targetSegment);
        const ratio = audio.duration > 0 ? Math.max(0, Math.min(1, mediaTime / audio.duration)) : 0;
        const documentSecond = item ? item.startSecond + item.estimatedSeconds * ratio : 0;
        void persistProgress(document, {
          sectionIndex: targetSection,
          segmentIndex: targetSegment,
          segmentRatio: ratio,
          documentSecond,
          completed: false
        });
      };
      audio.onended = () => {
        const docTimeline = buildTimeline(document);
        const item = docTimeline.find((candidate) => candidate.sectionIndex === targetSection && candidate.segmentIndex === targetSegment);
        const endSecond = item?.endSecond || 0;
        if (targetSegment < segments.length - 1) {
          void persistProgress(document, { sectionIndex: targetSection, segmentIndex: targetSegment + 1, segmentRatio: 0, documentSecond: endSecond, completed: false }, true);
          void playSegment(document, targetSection, targetSegment + 1);
          return;
        }
        if (document.sections[targetSection + 1]) {
          void persistProgress(document, { sectionIndex: targetSection + 1, segmentIndex: 0, segmentRatio: 0, documentSecond: endSecond, completed: false }, true);
          void playSegment(document, targetSection + 1, 0);
          return;
        }
        void persistProgress(document, { sectionIndex: targetSection, segmentIndex: targetSegment, segmentRatio: 1, documentSecond: docTimeline.length ? docTimeline[docTimeline.length - 1].endSecond : endSecond, completed: true }, true);
        setPlaying(false);
        setPaused(false);
      };
      audio.onerror = () => {
        setPlaying(false);
        setAudioLoading(false);
        setAudioError("No pude reproducir este tramo.");
      };
      audioRef.current = audio;
      audio.load();
      if (audio.readyState >= 1) void startPlayback();
    } catch (err) {
      cleanupAudio();
      setAudioError(err instanceof Error ? err.message : "No pude reproducir el audio.");
    }
  };

  const continueDocument = (document: AudioDocument) => {
    const progress = document.audio_progress || {};
    setRate(Number(progress.rate) || 1);
    rateRef.current = Number(progress.rate) || 1;
    if (progress.completed) {
      void playSegment(document, 0, 0, 0);
      return;
    }
    const targetSection = Math.max(0, Math.min(document.sections.length - 1, Number(progress.sectionIndex) || 0));
    const segments = splitSpeechText(document.sections[targetSection]?.explainedText || "");
    const targetSegment = Math.max(0, Math.min(Math.max(0, segments.length - 1), Number(progress.segmentIndex) || 0));
    void playSegment(document, targetSection, targetSegment, Number(progress.segmentRatio) || 0);
  };

  const toggleAudio = async () => {
    if (!selected) return;
    if (audioRef.current && playing && !paused) {
      audioRef.current.pause();
      setPaused(true);
      const ratio = duration > 0 ? currentTime / duration : 0;
      void persistProgress(selected, { sectionIndex, segmentIndex, segmentRatio: ratio, documentSecond: estimatedElapsed, completed: false }, true);
      return;
    }
    if (audioRef.current && paused) {
      await audioRef.current.play();
      setPaused(false);
      setPlaying(true);
      return;
    }
    continueDocument(selected);
  };

  const stopAudio = () => {
    if (selected) {
      const ratio = duration > 0 ? currentTime / duration : 0;
      void persistProgress(selected, { sectionIndex, segmentIndex, segmentRatio: ratio, documentSecond: estimatedElapsed, completed: false }, true);
    }
    cleanupAudio();
  };

  const seekDocument = (targetSecond: number) => {
    if (!selected || !timeline.length) return;
    const target = Math.max(0, Math.min(totalSeconds, targetSecond));
    const item = timeline.find((candidate) => target < candidate.endSecond) || timeline[timeline.length - 1];
    const ratio = item.estimatedSeconds > 0 ? (target - item.startSecond) / item.estimatedSeconds : 0;
    const keepPaused = paused;
    setScrubValue(null);
    void playSegment(selected, item.sectionIndex, item.segmentIndex, ratio, keepPaused);
  };

  const seekRelative = (seconds: number) => {
    const audio = audioRef.current;
    if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
      const next = audio.currentTime + seconds;
      if (next >= 0 && next <= audio.duration) {
        audio.currentTime = next;
        setCurrentTime(next);
        return;
      }
    }
    seekDocument(estimatedElapsed + seconds);
  };

  const renameDocument = async (document: AudioDocument) => {
    if (!userId || !supabase) return;
    const next = window.prompt("Nuevo nombre del audio:", document.title)?.trim();
    if (!next || next === document.title) return;
    const { error: updateError } = await supabase.from("study_documents")
      .update({ title: next, updated_at: new Date().toISOString() })
      .eq("id", document.id)
      .eq("user_id", userId);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setDocuments((current) => current.map((item) => item.id === document.id ? { ...item, title: next } : item));
    if (selected?.id === document.id) setSelected((current) => current ? { ...current, title: next } : current);
  };

  const deleteDocument = async (document: AudioDocument) => {
    if (!userId || !supabase) return;
    const ok = window.confirm(`¿Eliminar “${document.title}”?\n\nSe quitará también su documento explicado de Companion y se borrarán los MP3 cacheados. El PDF original no se almacena en Companion.`);
    if (!ok) return;
    if (selected?.id === document.id) {
      cleanupAudio();
      setSelected(null);
    }
    await deleteCachedDocumentAudio(userId, document.id);
    const { error: deleteError } = await supabase.from("study_documents")
      .delete()
      .eq("id", document.id)
      .eq("user_id", userId);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    setDocuments((current) => current.filter((item) => item.id !== document.id));
  };

  if (!userId) {
    return (
      <section className="audio-library-empty-auth">
        <div className="audio-library-empty-icon"><Headphones size={26} /></div>
        <span className="eyebrow">BIBLIOTECA DE AUDIO</span>
        <h1>Tus clases explicadas, en un solo lugar</h1>
        <p>Inicia sesión para ver tus audios, continuar donde te quedaste y reutilizar los MP3 guardados en Supabase sin volver a llamar a ElevenLabs.</p>
        <button onClick={onRequireAuth}><Headphones size={17} /> Iniciar sesión</button>
      </section>
    );
  }

  return (
    <div className="audio-library-page">
      <header className="audio-library-page-header">
        <div>
          <span className="eyebrow">BIBLIOTECA DE AUDIO</span>
          <h1>Mis audios</h1>
          <p>Tus documentos explicados listos para escuchar, continuar o administrar.</p>
        </div>
        <div className="audio-library-header-actions">
          <button className="audio-library-refresh" onClick={() => void loadDocuments()} disabled={loading}>
            <RefreshCcw size={16} className={loading ? "spin" : ""} /> Actualizar
          </button>
          <button className="audio-library-new" onClick={onCreateAudio}><FileAudio size={17} /> Crear desde PDF</button>
        </div>
      </header>

      <section className="audio-library-cache-note">
        <div><Library size={18} /></div>
        <p><strong>Caché inteligente activo.</strong> La primera vez un tramo se genera con ElevenLabs y se guarda de forma privada en Supabase. Las siguientes escuchas reutilizan ese MP3, incluso desde otro dispositivo.</p>
      </section>

      <section className="audio-library-controls">
        <label className="audio-library-search">
          <Search size={17} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por tema, materia o documento…" />
        </label>
        <div className="audio-library-filters">
          {(["all", "progress", "done"] as const).map((item) => (
            <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>
              {item === "all" ? "Todos" : item === "progress" ? "En progreso" : "Terminados"}
            </button>
          ))}
        </div>
        <select value={subjectFilter} onChange={(e) => setSubjectFilter(e.target.value)}>
          <option value="all">Todas las materias</option>
          {subjects.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
        </select>
      </section>

      {error && <div className="audio-library-error">{error}</div>}

      {selected && (
        <section className="audio-library-player">
          <div className="audio-library-player-top">
            <div className="audio-library-player-art"><Headphones size={28} /></div>
            <div className="audio-library-player-title">
              <span>{selected.subject || "Documento explicado"}</span>
              <h2>{selected.title}</h2>
              <p>{selected.sections[sectionIndex]?.title || "Listo para continuar"} · capítulo {sectionIndex + 1} de {selected.sections.length}</p>
            </div>
            <div className="audio-library-player-time">
              <strong>{formatTime(displayElapsed)}</strong>
              <span>de ~{formatTime(totalSeconds)}</span>
            </div>
          </div>

          <div className="audio-library-timeline">
            <input
              type="range"
              min={0}
              max={Math.max(1, totalSeconds)}
              step={1}
              value={Math.min(totalSeconds || 1, scrubValue ?? displayElapsed)}
              onChange={(e) => setScrubValue(Number(e.target.value))}
              onMouseUp={() => scrubValue !== null && seekDocument(scrubValue)}
              onTouchEnd={() => scrubValue !== null && seekDocument(scrubValue)}
            />
            <div><span>Tramo {formatTime(currentTime)} / {formatTime(duration)}</span><span>Faltan ~{formatTime(remaining)}{rate !== 1 ? ` · a ${rate}x ≈ ${formatTime(remaining / rate)} reales` : ""}</span></div>
          </div>

          <div className="audio-library-player-controls">
            <div className="audio-library-transport">
              <button onClick={() => seekRelative(-15)} disabled={audioLoading}><Rewind size={17} />15</button>
              <button className="primary" onClick={() => void toggleAudio()} disabled={audioLoading}>
                {audioLoading ? <LoaderCircle size={18} className="spin" /> : playing && !paused ? <Pause size={18} /> : <Play size={18} />}
                {audioLoading ? "Preparando" : playing && !paused ? "Pausar" : paused ? "Continuar" : "Reproducir"}
              </button>
              <button onClick={() => seekRelative(15)} disabled={audioLoading}>15<FastForward size={17} /></button>
              <button onClick={stopAudio} disabled={!playing && !paused}><Square size={15} /> Detener</button>
            </div>
            <div className="audio-library-speed">
              <span>Velocidad</span>
              {rates.map((item) => <button key={item} className={rate === item ? "active" : ""} onClick={() => setRate(item)}>{item}x</button>)}
            </div>
          </div>

          <div className="audio-library-player-meta">
            <span>{audioSource === "supabase" ? "☁️ Reproduciendo desde caché de Supabase" : audioSource === "elevenlabs" ? "✨ Generado con ElevenLabs y guardado para próximas escuchas" : "Selecciona reproducir para comenzar"}</span>
            <button onClick={() => setExpandedChapters((value) => !value)}><BookOpen size={15} /> {expandedChapters ? "Ocultar capítulos" : "Ver capítulos"}</button>
          </div>
          {audioError && <div className="audio-library-player-error">{audioError}</div>}

          {expandedChapters && (
            <div className="audio-library-chapters">
              {selected.sections.map((section, index) => (
                <button key={section.id || index} className={sectionIndex === index ? "active" : ""} onClick={() => void playSegment(selected, index, 0)}>
                  <span>{index + 1}</span>
                  <div><strong>{section.title}</strong><small>Páginas {section.startPage}–{section.endPage} · ~{formatTime(splitSpeechText(section.explainedText).reduce((sum, text) => sum + estimateSpeechSeconds(text), 0))}</small></div>
                  <Play size={15} />
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="audio-library-results">
        <div className="audio-library-results-title">
          <div><span className="mini-label">TU COLECCIÓN</span><strong>{filtered.length} audio{filtered.length === 1 ? "" : "s"}</strong></div>
          {loading && <LoaderCircle size={18} className="spin" />}
        </div>

        {!loading && !filtered.length ? (
          <div className="audio-library-empty"><Headphones size={24} /><strong>No encontré audios con estos filtros.</strong><span>Procesa un PDF o cambia la búsqueda.</span></div>
        ) : (
          <div className="audio-library-grid">
            {filtered.map((document) => {
              const docTimeline = buildTimeline(document);
              const docTotal = docTimeline.length ? docTimeline[docTimeline.length - 1].endSecond : 0;
              const percent = progressFor(document, docTotal);
              const elapsed = Math.max(0, Number(document.audio_progress?.documentSecond) || 0);
              return (
                <article key={document.id} className={`audio-library-card ${selected?.id === document.id ? "selected" : ""}`}>
                  <div className="audio-library-card-top">
                    <div className="audio-library-card-icon"><Headphones size={20} /></div>
                    <div className="audio-library-card-copy">
                      <span>{document.subject || "Sin materia"}</span>
                      <h3>{document.title}</h3>
                      <p>{modeLabel(document.settings?.mode)} · {document.sections.length} capítulos · ~{formatTime(docTotal)}</p>
                    </div>
                  </div>
                  <div className="audio-library-card-progress"><span style={{ width: `${percent}%` }} /></div>
                  <div className="audio-library-card-progress-meta">
                    <span>{percent >= 100 ? <><CheckCircle2 size={13} /> Terminado</> : percent > 0 ? <><Clock3 size={13} /> {percent}% · {formatTime(elapsed)}</> : "Sin comenzar"}</span>
                    <span>{percent < 100 && docTotal ? `~${formatTime(Math.max(0, docTotal - elapsed))} restantes` : ""}</span>
                  </div>
                  <div className="audio-library-card-actions">
                    <button className="primary" onClick={() => continueDocument(document)}><Play size={15} /> {percent > 0 && percent < 100 ? "Continuar" : percent >= 100 ? "Escuchar de nuevo" : "Escuchar"}</button>
                    <button onClick={() => { cleanupAudio(); setSelected(document); setExpandedChapters(true); }}><BookOpen size={15} /> Capítulos</button>
                    <button title="Renombrar" onClick={() => void renameDocument(document)}><Pencil size={15} /></button>
                    <button className="danger" title="Eliminar" onClick={() => void deleteDocument(document)}><Trash2 size={15} /></button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
