import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  BookmarkPlus,
  Check,
  CheckCircle2,
  CircleHelp,
  Clock3,
  FastForward,
  FileAudio,
  GraduationCap,
  Headphones,
  Library,
  LoaderCircle,
  MessageCircle,
  NotebookPen,
  Pause,
  Pencil,
  Play,
  RefreshCcw,
  Rewind,
  Search,
  Send,
  Sparkles,
  Square,
  Trash2,
  X
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

type AudioNote = {
  id: string;
  document_id: string;
  section_index: number;
  segment_index: number;
  segment_second: number;
  document_second: number;
  kind: "bookmark" | "note";
  note: string;
  created_at: string;
};

type StudyCheck = {
  question: string;
  options: string[];
  answerIndex: number;
  explanation: string;
  concept: string;
};

type QuizQuestion = StudyCheck;
type FinalQuiz = { title: string; questions: QuizQuestion[] };

type Props = {
  userId?: string | null;
  onRequireAuth?: () => void;
  onCreateAudio?: () => void;
  focusDocumentId?: string | null;
  onFocusHandled?: () => void;
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
      output.push({ sectionIndex, segmentIndex, text, startSecond: cursor, endSecond: cursor + estimatedSeconds, estimatedSeconds });
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

function chapterSeconds(section: AudioSection) {
  return splitSpeechText(section.explainedText).reduce((sum, text) => sum + estimateSpeechSeconds(text), 0);
}

function buildGuidedSections(document: AudioDocument, durationMinutes: 20 | 40 | 60) {
  const start = document.audio_progress?.completed ? 0 : Math.max(0, Math.min(document.sections.length - 1, Number(document.audio_progress?.sectionIndex) || 0));
  const audioBudget = durationMinutes * 60 * 0.72;
  const selected: number[] = [];
  let used = 0;
  for (let offset = 0; offset < document.sections.length; offset += 1) {
    const index = (start + offset) % document.sections.length;
    const seconds = chapterSeconds(document.sections[index]);
    if (selected.length && used + seconds > audioBudget) break;
    selected.push(index);
    used += seconds;
    if (used >= audioBudget) break;
  }
  return selected.length ? selected : [start];
}

export default function AudioLibrary({ userId, onRequireAuth, onCreateAudio, focusDocumentId, onFocusHandled }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const persistAtRef = useRef(0);
  const rateRef = useRef(1);
  const guidedRef = useRef<{ active: boolean; sections: number[]; step: number }>({ active: false, sections: [], step: 0 });

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

  const [notes, setNotes] = useState<AudioNote[]>([]);
  const [notesOpen, setNotesOpen] = useState(false);
  const [noteComposerOpen, setNoteComposerOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteLoading, setNoteLoading] = useState(false);

  const [askOpen, setAskOpen] = useState(false);
  const [askQuestion, setAskQuestion] = useState("");
  const [askAnswer, setAskAnswer] = useState("");
  const [askRemember, setAskRemember] = useState("");
  const [askLoading, setAskLoading] = useState(false);
  const [askError, setAskError] = useState("");

  const [guidedOpen, setGuidedOpen] = useState(false);
  const [guidedDuration, setGuidedDuration] = useState<20 | 40 | 60>(40);
  const [guidedRunId, setGuidedRunId] = useState<string | null>(null);
  const [guidedSections, setGuidedSections] = useState<number[]>([]);
  const [guidedStep, setGuidedStep] = useState(0);
  const [guidedCheck, setGuidedCheck] = useState<StudyCheck | null>(null);
  const [guidedCheckLoading, setGuidedCheckLoading] = useState(false);
  const [guidedAnswer, setGuidedAnswer] = useState<number | null>(null);
  const [guidedFinalQuiz, setGuidedFinalQuiz] = useState<FinalQuiz | null>(null);
  const [guidedFinalIndex, setGuidedFinalIndex] = useState(0);
  const [guidedFinalAnswers, setGuidedFinalAnswers] = useState<number[]>([]);
  const [guidedFinalSelected, setGuidedFinalSelected] = useState<number | null>(null);
  const [guidedDone, setGuidedDone] = useState(false);
  const [guidedError, setGuidedError] = useState("");

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

  const subjects = useMemo(() => Array.from(new Set(documents.map((doc) => doc.subject).filter(Boolean))).sort((a, b) => a.localeCompare(b, "es")), [documents]);

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
      setError(fetchError.message.includes("audio_progress") ? "Falta ejecutar la migración 005_audio_library_cache.sql en Supabase." : fetchError.message);
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

  useEffect(() => { void loadDocuments(); }, [userId]);

  useEffect(() => {
    if (!focusDocumentId || !documents.length) return;
    const document = documents.find((item) => item.id === focusDocumentId);
    if (document) {
      cleanupAudio();
      setSelected(document);
      setExpandedChapters(false);
      onFocusHandled?.();
    }
  }, [focusDocumentId, documents]);

  const loadNotes = async (documentId: string) => {
    if (!userId || !supabase) return;
    const { data, error: notesError } = await supabase
      .from("audio_notes")
      .select("id,document_id,section_index,segment_index,segment_second,document_second,kind,note,created_at")
      .eq("user_id", userId)
      .eq("document_id", documentId)
      .order("document_second", { ascending: true });
    if (notesError) {
      if (notesError.message.includes("audio_notes")) setError("Falta ejecutar la migración 006_guided_study_notes_review.sql en Supabase.");
      return;
    }
    setNotes((data || []) as AudioNote[]);
  };

  useEffect(() => {
    if (!selected) {
      setNotes([]);
      return;
    }
    void loadNotes(selected.id);
  }, [selected?.id, userId]);

  const persistProgress = async (document: AudioDocument, next: AudioProgress, force = false) => {
    if (!userId || !supabase) return;
    const nowMs = Date.now();
    if (!force && nowMs - persistAtRef.current < 8000) return;
    persistAtRef.current = nowMs;
    const normalized: AudioProgress = { ...next, rate: rateRef.current, updatedAt: new Date().toISOString() };
    const lastPlayedAt = new Date().toISOString();
    setDocuments((current) => current.map((item) => item.id === document.id ? { ...item, audio_progress: normalized, last_played_at: lastPlayedAt } : item));
    if (selected?.id === document.id) setSelected((current) => current ? { ...current, audio_progress: normalized, last_played_at: lastPlayedAt } : current);
    const { error: updateError } = await supabase.from("study_documents")
      .update({ audio_progress: normalized, last_played_at: lastPlayedAt })
      .eq("id", document.id)
      .eq("user_id", userId);
    if (updateError) console.warn("No pude guardar el punto de escucha:", updateError.message);
  };

  const updateGuidedRun = async (changes: Record<string, unknown>) => {
    if (!guidedRunId || !userId || !supabase) return;
    const client = supabase;
    await client.from("guided_study_runs")
      .update({ ...changes, updated_at: new Date().toISOString() })
      .eq("id", guidedRunId)
      .eq("user_id", userId);
  };

  const prepareGuidedCheckpoint = async (document: AudioDocument, targetSection: number) => {
    cleanupAudio();
    setGuidedCheck(null);
    setGuidedAnswer(null);
    setGuidedCheckLoading(true);
    setGuidedError("");
    const section = document.sections[targetSection];
    try {
      const response = await fetch("/api/study-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: document.subject, topic: document.topic, sectionTitle: section.title, sectionText: section.explainedText })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "No pude crear la comprobación.");
      setGuidedCheck(payload.question as StudyCheck);
    } catch (err) {
      setGuidedError(err instanceof Error ? err.message : "No pude crear la comprobación.");
    } finally {
      setGuidedCheckLoading(false);
    }
  };

  const prepareFinalQuiz = async (document: AudioDocument) => {
    setGuidedCheck(null);
    setGuidedAnswer(null);
    setGuidedCheckLoading(true);
    setGuidedError("");
    const sourceText = guidedRef.current.sections.map((index) => `# ${document.sections[index]?.title}\n${document.sections[index]?.explainedText || ""}`).join("\n\n");
    try {
      const response = await fetch("/api/study-final-quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: document.subject, topic: document.topic, sourceText })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "No pude preparar el cierre.");
      setGuidedFinalQuiz(payload.quiz as FinalQuiz);
      setGuidedFinalIndex(0);
      setGuidedFinalAnswers([]);
      setGuidedFinalSelected(null);
    } catch (err) {
      setGuidedError(err instanceof Error ? err.message : "No pude preparar el cierre.");
    } finally {
      setGuidedCheckLoading(false);
    }
  };

  const playSegment = async (document: AudioDocument, targetSection: number, targetSegment: number, startRatio = 0, startPaused = false) => {
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
      audio.ondurationchange = () => { if (Number.isFinite(audio.duration)) setDuration(audio.duration); };
      audio.ontimeupdate = () => {
        const mediaTime = audio.currentTime || 0;
        setCurrentTime(mediaTime);
        if (Number.isFinite(audio.duration)) setDuration(audio.duration);
        const item = buildTimeline(document).find((candidate) => candidate.sectionIndex === targetSection && candidate.segmentIndex === targetSegment);
        const ratio = audio.duration > 0 ? Math.max(0, Math.min(1, mediaTime / audio.duration)) : 0;
        const documentSecond = item ? item.startSecond + item.estimatedSeconds * ratio : 0;
        void persistProgress(document, { sectionIndex: targetSection, segmentIndex: targetSegment, segmentRatio: ratio, documentSecond, completed: false });
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

        const guided = guidedRef.current;
        if (guided.active && guided.sections[guided.step] === targetSection) {
          void persistProgress(document, { sectionIndex: targetSection, segmentIndex: targetSegment, segmentRatio: 1, documentSecond: endSecond, completed: false }, true);
          void updateGuidedRun({ current_step: guided.step });
          void prepareGuidedCheckpoint(document, targetSection);
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
    guidedRef.current = { active: false, sections: [], step: 0 };
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
    guidedRef.current = { active: false, sections: [], step: 0 };
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

  const addNote = async (kind: "bookmark" | "note", text = "") => {
    if (!selected || !userId || !supabase) return;
    setNoteLoading(true);
    const { data, error: insertError } = await supabase.from("audio_notes").insert({
      user_id: userId,
      document_id: selected.id,
      section_index: sectionIndex,
      segment_index: segmentIndex,
      segment_second: Math.max(0, currentTime),
      document_second: Math.max(0, estimatedElapsed),
      kind,
      note: text.trim(),
      updated_at: new Date().toISOString()
    }).select("id,document_id,section_index,segment_index,segment_second,document_second,kind,note,created_at").single();
    setNoteLoading(false);
    if (insertError) {
      setError(insertError.message.includes("audio_notes") ? "Falta ejecutar la migración 006_guided_study_notes_review.sql en Supabase." : insertError.message);
      return;
    }
    setNotes((current) => [...current, data as AudioNote].sort((a, b) => a.document_second - b.document_second));
    setNoteComposerOpen(false);
    setNoteDraft("");
  };

  const deleteNote = async (note: AudioNote) => {
    if (!userId || !supabase) return;
    const { error: deleteError } = await supabase.from("audio_notes").delete().eq("id", note.id).eq("user_id", userId);
    if (!deleteError) setNotes((current) => current.filter((item) => item.id !== note.id));
  };

  const openAsk = () => {
    if (audioRef.current && playing && !paused) {
      audioRef.current.pause();
      setPaused(true);
    }
    setAskOpen(true);
    setAskAnswer("");
    setAskRemember("");
    setAskError("");
  };

  const submitAsk = async () => {
    if (!selected || !activeTimeline || !askQuestion.trim()) return;
    setAskLoading(true);
    setAskError("");
    try {
      const response = await fetch("/api/audio-question", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: selected.subject,
          topic: selected.topic,
          sectionTitle: selected.sections[sectionIndex]?.title,
          segmentText: activeTimeline.text,
          question: askQuestion.trim()
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "No pude responder la duda.");
      setAskAnswer(String(payload.answer || ""));
      setAskRemember(String(payload.remember || ""));
    } catch (err) {
      setAskError(err instanceof Error ? err.message : "No pude responder la duda.");
    } finally {
      setAskLoading(false);
    }
  };

  const startGuidedSession = async () => {
    if (!selected || !userId || !supabase) return;
    const sections = buildGuidedSections(selected, guidedDuration);
    setGuidedSections(sections);
    setGuidedStep(0);
    setGuidedCheck(null);
    setGuidedAnswer(null);
    setGuidedFinalQuiz(null);
    setGuidedDone(false);
    setGuidedError("");
    guidedRef.current = { active: true, sections, step: 0 };
    const plan = { sectionIndices: sections, titles: sections.map((index) => selected.sections[index]?.title || `Capítulo ${index + 1}`) };
    const { data, error: runError } = await supabase.from("guided_study_runs").insert({
      user_id: userId,
      document_id: selected.id,
      duration_minutes: guidedDuration,
      plan,
      current_step: 0,
      status: "active",
      updated_at: new Date().toISOString()
    }).select("id").single();
    if (runError) {
      setGuidedError(runError.message.includes("guided_study_runs") ? "Falta ejecutar la migración 006_guided_study_notes_review.sql en Supabase." : runError.message);
      guidedRef.current = { active: false, sections: [], step: 0 };
      return;
    }
    setGuidedRunId(String(data.id));
    setGuidedOpen(false);
    void playSegment(selected, sections[0], 0);
  };

  const continueGuided = () => {
    if (!selected) return;
    const nextStep = guidedStep + 1;
    if (nextStep < guidedSections.length) {
      setGuidedStep(nextStep);
      guidedRef.current = { active: true, sections: guidedSections, step: nextStep };
      setGuidedCheck(null);
      setGuidedAnswer(null);
      void updateGuidedRun({ current_step: nextStep });
      void playSegment(selected, guidedSections[nextStep], 0);
      return;
    }
    guidedRef.current = { active: false, sections: guidedSections, step: guidedStep };
    void prepareFinalQuiz(selected);
  };

  const chooseFinalAnswer = (answerIndex: number) => {
    if (!guidedFinalQuiz || guidedFinalSelected !== null) return;
    setGuidedFinalSelected(answerIndex);
    setGuidedFinalAnswers((current) => [...current, answerIndex]);
  };

  const nextFinalQuestion = async () => {
    if (!guidedFinalQuiz || guidedFinalSelected === null) return;
    if (guidedFinalIndex < guidedFinalQuiz.questions.length - 1) {
      setGuidedFinalIndex((value) => value + 1);
      setGuidedFinalSelected(null);
      return;
    }
    setGuidedDone(true);
    setGuidedFinalSelected(null);
    await updateGuidedRun({ status: "complete", current_step: guidedSections.length, completed_at: new Date().toISOString() });
  };

  const renameDocument = async (document: AudioDocument) => {
    if (!userId || !supabase) return;
    const next = window.prompt("Nuevo nombre del audio:", document.title)?.trim();
    if (!next || next === document.title) return;
    const { error: updateError } = await supabase.from("study_documents").update({ title: next, updated_at: new Date().toISOString() }).eq("id", document.id).eq("user_id", userId);
    if (updateError) { setError(updateError.message); return; }
    setDocuments((current) => current.map((item) => item.id === document.id ? { ...item, title: next } : item));
    if (selected?.id === document.id) setSelected((current) => current ? { ...current, title: next } : current);
  };

  const deleteDocument = async (document: AudioDocument) => {
    if (!userId || !supabase) return;
    const ok = window.confirm(`¿Eliminar “${document.title}”?\n\nSe quitará también su documento explicado, notas, sesiones guiadas y los MP3 cacheados. El PDF original no se almacena en Companion.`);
    if (!ok) return;
    if (selected?.id === document.id) { cleanupAudio(); setSelected(null); }
    await deleteCachedDocumentAudio(userId, document.id);
    const { error: deleteError } = await supabase.from("study_documents").delete().eq("id", document.id).eq("user_id", userId);
    if (deleteError) { setError(deleteError.message); return; }
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

  const currentFinalQuestion = guidedFinalQuiz?.questions[guidedFinalIndex];
  const finalCorrect = guidedFinalQuiz ? guidedFinalQuiz.questions.reduce((sum, question, index) => sum + (guidedFinalAnswers[index] === question.answerIndex ? 1 : 0), 0) : 0;

  return (
    <div className="audio-library-page">
      <header className="audio-library-page-header">
        <div>
          <span className="eyebrow">BIBLIOTECA DE AUDIO</span>
          <h1>Mis audios</h1>
          <p>Tus documentos explicados listos para escuchar, estudiar, preguntar y administrar.</p>
        </div>
        <div className="audio-library-header-actions">
          <button className="audio-library-refresh" onClick={() => void loadDocuments()} disabled={loading}><RefreshCcw size={16} className={loading ? "spin" : ""} /> Actualizar</button>
          <button className="audio-library-new" onClick={onCreateAudio}><FileAudio size={17} /> Crear desde PDF</button>
        </div>
      </header>

      <section className="audio-library-cache-note">
        <div><Library size={18} /></div>
        <p><strong>Caché inteligente activo.</strong> La primera escucha genera el tramo con ElevenLabs; después se reutiliza desde Supabase, incluso en otro dispositivo.</p>
      </section>

      <section className="audio-library-controls">
        <label className="audio-library-search"><Search size={17} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por tema, materia o documento…" /></label>
        <div className="audio-library-filters">
          {(["all", "progress", "done"] as const).map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item === "all" ? "Todos" : item === "progress" ? "En progreso" : "Terminados"}</button>)}
        </div>
        <select value={subjectFilter} onChange={(e) => setSubjectFilter(e.target.value)}><option value="all">Todas las materias</option>{subjects.map((subject) => <option key={subject} value={subject}>{subject}</option>)}</select>
      </section>

      {error && <div className="audio-library-error">{error}</div>}

      {selected && (
        <>
          <section className="audio-library-player">
            <div className="audio-library-player-top">
              <div className="audio-library-player-art"><Headphones size={28} /></div>
              <div className="audio-library-player-title"><span>{selected.subject || "Documento explicado"}</span><h2>{selected.title}</h2><p>{selected.sections[sectionIndex]?.title || "Listo para continuar"} · capítulo {sectionIndex + 1} de {selected.sections.length}</p></div>
              <div className="audio-library-player-time"><strong>{formatTime(displayElapsed)}</strong><span>de ~{formatTime(totalSeconds)}</span></div>
            </div>

            <div className="audio-library-timeline">
              <input type="range" min={0} max={Math.max(1, totalSeconds)} step={1} value={Math.min(totalSeconds || 1, scrubValue ?? displayElapsed)} onChange={(e) => setScrubValue(Number(e.target.value))} onMouseUp={() => scrubValue !== null && seekDocument(scrubValue)} onTouchEnd={() => scrubValue !== null && seekDocument(scrubValue)} />
              <div><span>Tramo {formatTime(currentTime)} / {formatTime(duration)}</span><span>Faltan ~{formatTime(remaining)}{rate !== 1 ? ` · a ${rate}x ≈ ${formatTime(remaining / rate)} reales` : ""}</span></div>
            </div>

            <div className="audio-library-player-controls">
              <div className="audio-library-transport">
                <button onClick={() => seekRelative(-15)} disabled={audioLoading}><Rewind size={17} />15</button>
                <button className="primary" onClick={() => void toggleAudio()} disabled={audioLoading}>{audioLoading ? <LoaderCircle size={18} className="spin" /> : playing && !paused ? <Pause size={18} /> : <Play size={18} />}{audioLoading ? "Preparando" : playing && !paused ? "Pausar" : paused ? "Continuar" : "Reproducir"}</button>
                <button onClick={() => seekRelative(15)} disabled={audioLoading}>15<FastForward size={17} /></button>
                <button onClick={stopAudio} disabled={!playing && !paused}><Square size={15} /> Detener</button>
              </div>
              <div className="audio-library-speed"><span>Velocidad</span>{rates.map((item) => <button key={item} className={rate === item ? "active" : ""} onClick={() => setRate(item)}>{item}x</button>)}</div>
            </div>

            <div className="audio-learning-actions">
              <button onClick={() => void addNote("bookmark")} disabled={noteLoading}><BookmarkPlus size={15} /> Marcar {formatTime(estimatedElapsed)}</button>
              <button onClick={() => setNoteComposerOpen(true)}><NotebookPen size={15} /> Añadir nota</button>
              <button onClick={openAsk}><MessageCircle size={15} /> Preguntar sobre esto</button>
              <button onClick={() => setGuidedOpen(true)}><GraduationCap size={15} /> Sesión de estudio</button>
            </div>

            {noteComposerOpen && (
              <div className="audio-note-composer">
                <div><strong>Nota en {formatTime(estimatedElapsed)}</strong><span>{selected.sections[sectionIndex]?.title}</span></div>
                <textarea value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="Escribe qué quieres recordar de este momento…" rows={2} autoFocus />
                <div><button onClick={() => { setNoteComposerOpen(false); setNoteDraft(""); }}><X size={14} /> Cancelar</button><button className="primary" onClick={() => void addNote("note", noteDraft)} disabled={!noteDraft.trim() || noteLoading}><Check size={14} /> Guardar nota</button></div>
              </div>
            )}

            {askOpen && (
              <div className="audio-ask-panel">
                <div className="audio-ask-head"><div><span className="mini-label">PREGUNTA MIENTRAS ESCUCHAS</span><strong>{selected.sections[sectionIndex]?.title}</strong></div><button onClick={() => setAskOpen(false)}><X size={15} /></button></div>
                <div className="audio-ask-input"><textarea value={askQuestion} onChange={(e) => setAskQuestion(e.target.value)} placeholder="Ej. No entendí la diferencia entre RDF y RDFS…" rows={2} /><button onClick={() => void submitAsk()} disabled={askLoading || !askQuestion.trim()}>{askLoading ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}</button></div>
                {askError && <div className="audio-library-player-error">{askError}</div>}
                {askAnswer && <div className="audio-ask-answer"><p>{askAnswer}</p>{askRemember && <strong>Quédate con esto: {askRemember}</strong>}<button onClick={() => { setAskOpen(false); if (paused) void toggleAudio(); }}><Play size={14} /> Continuar audio</button></div>}
              </div>
            )}

            <div className="audio-library-player-meta">
              <span>{audioSource === "supabase" ? "☁️ Reproduciendo desde caché de Supabase" : audioSource === "elevenlabs" ? "✨ Generado con ElevenLabs y guardado para próximas escuchas" : "Selecciona reproducir para comenzar"}</span>
              <div><button onClick={() => setNotesOpen((value) => !value)}><NotebookPen size={15} /> Notas ({notes.length})</button><button onClick={() => setExpandedChapters((value) => !value)}><BookOpen size={15} /> {expandedChapters ? "Ocultar capítulos" : "Ver capítulos"}</button></div>
            </div>
            {audioError && <div className="audio-library-player-error">{audioError}</div>}

            {notesOpen && (
              <div className="audio-notes-list">
                {!notes.length ? <span>Todavía no tienes marcadores en este audio.</span> : notes.map((note) => (
                  <div key={note.id}>
                    <button className="audio-note-jump" onClick={() => seekDocument(note.document_second)}><span>{formatTime(note.document_second)}</span><div><strong>{note.kind === "bookmark" ? "Marcador" : note.note}</strong><small>{selected.sections[note.section_index]?.title || "Capítulo"}</small></div></button>
                    <button className="audio-note-delete" onClick={() => void deleteNote(note)}><Trash2 size={13} /></button>
                  </div>
                ))}
              </div>
            )}

            {expandedChapters && (
              <div className="audio-library-chapters">
                {selected.sections.map((section, index) => <button key={section.id || index} className={sectionIndex === index ? "active" : ""} onClick={() => void playSegment(selected, index, 0)}><span>{index + 1}</span><div><strong>{section.title}</strong><small>Páginas {section.startPage}–{section.endPage} · ~{formatTime(chapterSeconds(section))}</small></div><Play size={15} /></button>)}
              </div>
            )}
          </section>

          {(guidedOpen || guidedSections.length > 0 || guidedFinalQuiz || guidedDone) && (
            <section className="guided-study-panel">
              {guidedOpen ? (
                <>
                  <div className="guided-study-head"><div><span className="mini-label">SESIÓN DE ESTUDIO</span><h2>¿Cuánto tiempo tienes?</h2><p>Companion combinará audio, comprobaciones rápidas y un quiz final.</p></div><button onClick={() => setGuidedOpen(false)}><X size={16} /></button></div>
                  <div className="guided-duration-options">{([20, 40, 60] as const).map((minutes) => <button key={minutes} className={guidedDuration === minutes ? "active" : ""} onClick={() => setGuidedDuration(minutes)}><strong>{minutes} min</strong><span>{minutes === 20 ? "Sesión corta" : minutes === 40 ? "Sesión recomendada" : "Sesión profunda"}</span></button>)}</div>
                  <button className="guided-start" onClick={() => void startGuidedSession()}><GraduationCap size={16} /> Comenzar sesión</button>
                </>
              ) : guidedDone ? (
                <div className="guided-finish"><CheckCircle2 size={28} /><span className="mini-label">SESIÓN COMPLETADA</span><h2>Buen cierre de estudio</h2><p>Terminaste {guidedSections.length} capítulo{guidedSections.length === 1 ? "" : "s"} y obtuviste {finalCorrect}/{guidedFinalQuiz?.questions.length || 3} en el quiz final.</p><button onClick={() => { setGuidedSections([]); setGuidedFinalQuiz(null); setGuidedDone(false); setGuidedRunId(null); }}>Cerrar sesión guiada</button></div>
              ) : guidedFinalQuiz && currentFinalQuestion ? (
                <div className="guided-checkpoint">
                  <div className="guided-progress-label"><span>Quiz final</span><strong>{guidedFinalIndex + 1}/{guidedFinalQuiz.questions.length}</strong></div>
                  <h3>{currentFinalQuestion.question}</h3>
                  <div className="guided-options">{currentFinalQuestion.options.map((option, index) => <button key={index} className={guidedFinalSelected === null ? "" : index === currentFinalQuestion.answerIndex ? "correct" : guidedFinalSelected === index ? "wrong" : ""} disabled={guidedFinalSelected !== null} onClick={() => chooseFinalAnswer(index)}>{option}</button>)}</div>
                  {guidedFinalSelected !== null && <div className="guided-feedback"><strong>{guidedFinalSelected === currentFinalQuestion.answerIndex ? "Correcto" : "Casi"}</strong><p>{currentFinalQuestion.explanation}</p><button onClick={() => void nextFinalQuestion()}>{guidedFinalIndex === guidedFinalQuiz.questions.length - 1 ? "Terminar sesión" : "Siguiente pregunta"}</button></div>}
                </div>
              ) : guidedCheckLoading ? (
                <div className="guided-loading"><LoaderCircle size={20} className="spin" /> Preparando una comprobación antes de continuar…</div>
              ) : guidedCheck ? (
                <div className="guided-checkpoint">
                  <div className="guided-progress-label"><span>Capítulo {guidedStep + 1} de {guidedSections.length}</span><strong>{guidedCheck.concept}</strong></div>
                  <h3>{guidedCheck.question}</h3>
                  <div className="guided-options">{guidedCheck.options.map((option, index) => <button key={index} className={guidedAnswer === null ? "" : index === guidedCheck.answerIndex ? "correct" : guidedAnswer === index ? "wrong" : ""} disabled={guidedAnswer !== null} onClick={() => setGuidedAnswer(index)}>{option}</button>)}</div>
                  {guidedAnswer !== null && <div className="guided-feedback"><strong>{guidedAnswer === guidedCheck.answerIndex ? "Correcto" : "Revisemos"}</strong><p>{guidedCheck.explanation}</p><button onClick={continueGuided}>{guidedStep < guidedSections.length - 1 ? "Continuar con el audio" : "Ir al quiz final"}</button></div>}
                </div>
              ) : guidedError ? <div className="guided-error"><CircleHelp size={18} /><span>{guidedError}</span><button onClick={continueGuided}>Continuar sin comprobación</button></div> : guidedSections.length ? (
                <div className="guided-running"><LoaderCircle size={18} className="spin" /><span>Sesión guiada activa · capítulo {guidedStep + 1} de {guidedSections.length}</span></div>
              ) : null}
            </section>
          )}
        </>
      )}

      <section className="audio-library-results">
        <div className="audio-library-results-title"><div><span className="mini-label">TU COLECCIÓN</span><strong>{filtered.length} audio{filtered.length === 1 ? "" : "s"}</strong></div>{loading && <LoaderCircle size={18} className="spin" />}</div>
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
                  <div className="audio-library-card-top"><div className="audio-library-card-icon"><Headphones size={20} /></div><div className="audio-library-card-copy"><span>{document.subject || "Sin materia"}</span><h3>{document.title}</h3><p>{modeLabel(document.settings?.mode)} · {document.sections.length} capítulos · ~{formatTime(docTotal)}</p></div></div>
                  <div className="audio-library-card-progress"><span style={{ width: `${percent}%` }} /></div>
                  <div className="audio-library-card-progress-meta"><span>{percent >= 100 ? <><CheckCircle2 size={13} /> Terminado</> : percent > 0 ? <><Clock3 size={13} /> {percent}% · {formatTime(elapsed)}</> : "Sin comenzar"}</span><span>{percent < 100 && docTotal ? `~${formatTime(Math.max(0, docTotal - elapsed))} restantes` : ""}</span></div>
                  <div className="audio-library-card-actions"><button className="primary" onClick={() => continueDocument(document)}><Play size={15} /> {percent > 0 && percent < 100 ? "Continuar" : percent >= 100 ? "Escuchar de nuevo" : "Escuchar"}</button><button onClick={() => { cleanupAudio(); setSelected(document); setExpandedChapters(true); }}><BookOpen size={15} /> Capítulos</button><button title="Renombrar" onClick={() => void renameDocument(document)}><Pencil size={15} /></button><button className="danger" title="Eliminar" onClick={() => void deleteDocument(document)}><Trash2 size={15} /></button></div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
