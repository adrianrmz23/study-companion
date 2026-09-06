import { useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  BookOpenCheck,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  FileAudio,
  FileText,
  Headphones,
  Library,
  LoaderCircle,
  Pause,
  Play,
  Rewind,
  FastForward,
  RefreshCcw,
  Sparkles,
  Square,
  Upload,
  X
} from "lucide-react";
import { supabase } from "./supabase";
import { getOrCreateAudioBlob } from "./audioCache";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

type GlossaryItem = {
  term: string;
  meaning: string;
};

export type ExplainedDocumentSection = {
  id: string;
  title: string;
  startPage: number;
  endPage: number;
  sourceChars: number;
  explainedText: string;
  glossary: GlossaryItem[];
  anchor: string;
  coverageScore: number;
  missingPoints: string[];
  repaired?: boolean;
  coveragePending?: boolean;
};

type ExplainedDocument = {
  id?: string;
  title: string;
  fileName: string;
  subject: string;
  topic: string;
  pageCount: number;
  sourceChars: number;
  sections: ExplainedDocumentSection[];
  glossary: GlossaryItem[];
  coverageScore: number;
  coveragePendingCount: number;
  createdAt: string;
  updatedAt: string;
  lastSectionIndex: number;
};

type SavedDocumentRow = {
  id: string;
  title: string;
  file_name: string;
  subject: string;
  topic: string;
  status: string;
  page_count: number;
  source_chars: number;
  sections: ExplainedDocumentSection[] | null;
  glossary: GlossaryItem[] | null;
  settings: DocumentSettings | null;
  coverage: { score?: number; pendingSections?: number; checkedSections?: number } | null;
  last_section_index: number | null;
  created_at: string;
  updated_at: string;
};

type SourcePage = { page: number; text: string };
type SourceChunk = { id: string; startPage: number; endPage: number; text: string };
type ProcessingState = {
  chunks: SourceChunk[];
  nextChunkIndex: number;
  totalChunks: number;
  sourceFileName: string;
  updatedAt?: string;
};
type DocumentSettings = {
  audience?: string;
  mode?: string;
  explainAcronyms?: boolean;
  preserveTechnicalTerms?: boolean;
  omitReferences?: boolean;
  processing?: ProcessingState;
};

type Props = {
  open: boolean;
  userId?: string | null;
  subject: string;
  topic: string;
  onClose: () => void;
  onUseInChat?: (title: string, text: string) => void;
};

type Stage = "idle" | "extracting" | "explaining" | "checking" | "saving" | "done" | "error";
type DocumentMode = "review" | "learn" | "deep";

const documentModes: Record<DocumentMode, { label: string; time: string; description: string }> = {
  review: {
    label: "Repaso",
    time: "15–25 min",
    description: "Para volver a pasar por el tema. Conserva los conceptos centrales y comprime ejemplos, historia y repeticiones."
  },
  learn: {
    label: "Aprender el documento",
    time: "35–50 min aprox.",
    description: "Recomendado. No salta conceptos académicos importantes; los explica en lenguaje humano sin profundizar más de lo necesario."
  },
  deep: {
    label: "Profundizar",
    time: "60–90+ min",
    description: "Usa el documento como base y añade contexto, conexiones y ejemplos para ir más allá de lo que explica el material."
  }
};

function normalizeDocumentMode(value?: string | null): DocumentMode {
  return value === "review" || value === "deep" ? value : "learn";
}

const rates = [0.8, 1, 1.25, 1.5];
const MAX_FILE_MB = 40;

function cleanPdfText(value: string) {
  return value
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stripReferences(pages: SourcePage[]) {
  const output: SourcePage[] = [];
  let stopped = false;
  const heading = /\b(?:referencias(?:\s+bibliogr[aá]ficas)?|bibliograf[ií]a|references)\b/i;
  const finalZoneStartsAt = Math.max(1, Math.floor(pages.length * 0.55));

  for (const page of pages) {
    if (stopped) break;
    const match = page.text.match(heading);
    const looksLikeFinalBibliography = match?.index !== undefined
      && page.page >= finalZoneStartsAt
      && match.index < Math.min(1200, Math.max(300, page.text.length * 0.45));
    if (looksLikeFinalBibliography && match?.index !== undefined) {
      const before = page.text.slice(0, match.index).trim();
      if (before.length > 120) output.push({ ...page, text: before });
      stopped = true;
      break;
    }
    output.push(page);
  }
  return output;
}

function splitLongText(text: string, maxChars = 4200) {
  if (text.length <= maxChars) return [text];
  const paragraphs = text.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const parts: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) parts.push(current.trim());
    current = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      flush();
      const sentences = paragraph.split(/(?<=[.!?])\s+/);
      let sentenceChunk = "";
      for (const sentence of sentences) {
        if ((sentenceChunk + " " + sentence).trim().length > maxChars && sentenceChunk.trim()) {
          parts.push(sentenceChunk.trim());
          sentenceChunk = sentence;
        } else {
          sentenceChunk = `${sentenceChunk} ${sentence}`.trim();
        }
      }
      if (sentenceChunk.trim()) parts.push(sentenceChunk.trim());
      continue;
    }

    if ((current + "\n\n" + paragraph).trim().length > maxChars && current.trim()) flush();
    current = `${current}${current ? "\n\n" : ""}${paragraph}`;
  }
  flush();
  return parts;
}

function buildChunks(pages: SourcePage[], targetChars = 3600, maxChars = 4400): SourceChunk[] {
  const chunks: SourceChunk[] = [];
  let currentText = "";
  let startPage = pages[0]?.page || 1;
  let endPage = startPage;

  const pushCurrent = () => {
    const text = currentText.trim();
    if (!text) return;
    chunks.push({ id: `source-${chunks.length + 1}`, startPage, endPage, text });
    currentText = "";
  };

  for (const page of pages) {
    const pageText = page.text.trim();
    if (!pageText) continue;

    if (pageText.length > maxChars) {
      pushCurrent();
      const pageParts = splitLongText(pageText, targetChars);
      pageParts.forEach((part) => {
        chunks.push({ id: `source-${chunks.length + 1}`, startPage: page.page, endPage: page.page, text: part });
      });
      startPage = page.page + 1;
      endPage = startPage;
      continue;
    }

    const combined = `${currentText}${currentText ? "\n\n" : ""}${pageText}`;
    if (combined.length > maxChars && currentText.trim()) {
      pushCurrent();
      startPage = page.page;
      endPage = page.page;
      currentText = pageText;
    } else {
      if (!currentText) startPage = page.page;
      endPage = page.page;
      currentText = combined;
    }

    if (currentText.length >= targetChars) {
      pushCurrent();
      startPage = page.page + 1;
      endPage = startPage;
    }
  }
  pushCurrent();
  return chunks;
}

function splitChunkForRetry(chunk: SourceChunk): SourceChunk[] {
  const text = chunk.text.trim();
  if (text.length < 1400) return [chunk];
  const midpoint = Math.floor(text.length / 2);
  const boundaries: number[] = [];
  const boundaryPattern = /\n{2,}|(?<=[.!?])\s+/g;
  let match: RegExpExecArray | null;
  while ((match = boundaryPattern.exec(text))) {
    const position = match.index + match[0].length;
    if (position > 500 && position < text.length - 500) boundaries.push(position);
  }
  const splitAt = boundaries.length
    ? boundaries.reduce((best, value) => Math.abs(value - midpoint) < Math.abs(best - midpoint) ? value : best, boundaries[0])
    : midpoint;
  const first = text.slice(0, splitAt).trim();
  const second = text.slice(splitAt).trim();
  if (first.length < 450 || second.length < 450) return [chunk];
  return [
    { ...chunk, id: `${chunk.id}-a`, text: first },
    { ...chunk, id: `${chunk.id}-b`, text: second }
  ];
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || `La solicitud falló con estado ${response.status}.`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return payload;
}

function errorStatus(error: unknown) {
  return Number((error as { status?: number })?.status || 0);
}

function isTimeoutLike(error: unknown) {
  const status = errorStatus(error);
  const message = error instanceof Error ? error.message.toLocaleLowerCase("es-MX") : "";
  return [408, 502, 504].includes(status)
    || message.includes("tardó demasiado")
    || message.includes("timeout")
    || message.includes("timed out")
    || message.includes("aborted");
}

function isRetryable(error: unknown) {
  return isTimeoutLike(error) || [425, 429, 500, 503].includes(errorStatus(error));
}

function verifiedCoverageAverage(sections: ExplainedDocumentSection[]) {
  const checked = sections.filter((section) => !section.coveragePending);
  if (!checked.length) return 0;
  return Math.round(checked.reduce((sum, section) => sum + section.coverageScore, 0) / checked.length);
}

function dedupeGlossary(items: GlossaryItem[]) {
  const map = new Map<string, GlossaryItem>();
  items.forEach((item) => {
    const term = String(item?.term || "").trim();
    const meaning = String(item?.meaning || "").trim();
    if (!term || !meaning) return;
    const key = term.toLocaleLowerCase("es-MX");
    if (!map.has(key)) map.set(key, { term, meaning });
  });
  return Array.from(map.values()).slice(0, 80);
}

function estimateMinutes(sections: ExplainedDocumentSection[]) {
  const words = sections.reduce((total, section) => total + section.explainedText.split(/\s+/).filter(Boolean).length, 0);
  return Math.max(1, Math.round(words / 150));
}

function estimateSpeechSeconds(text: string) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(4, (words / 150) * 60);
}

function formatAudioTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const total = Math.max(0, Math.round(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function splitSpeechText(text: string, maxChars = 2400) {
  const cleaned = text.trim();
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

function rowToDocument(row: SavedDocumentRow): ExplainedDocument {
  return {
    id: row.id,
    title: row.title,
    fileName: row.file_name,
    subject: row.subject,
    topic: row.topic,
    pageCount: row.page_count || 0,
    sourceChars: row.source_chars || 0,
    sections: Array.isArray(row.sections) ? row.sections : [],
    glossary: Array.isArray(row.glossary) ? row.glossary : [],
    coverageScore: Number(row.coverage?.score || 0),
    coveragePendingCount: Math.max(0, Number(row.coverage?.pendingSections) || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSectionIndex: Math.max(0, Number(row.last_section_index) || 0)
  };
}

export default function DocumentExplainerModal({ open, userId, subject, topic, onClose, onUseInChat }: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const playAllRef = useRef(false);
  const rateRef = useRef(1);

  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState(0);
  const [stageText, setStageText] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<ExplainedDocument | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [savedDocs, setSavedDocs] = useState<SavedDocumentRow[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [audience, setAudience] = useState("Profesional de informática");
  const [documentMode, setDocumentMode] = useState<DocumentMode>("learn");

  const [rate, setRate] = useState(1);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioPaused, setAudioPaused] = useState(false);
  const [audioSectionIndex, setAudioSectionIndex] = useState<number | null>(null);
  const [audioSegmentIndex, setAudioSegmentIndex] = useState(0);
  const [audioSegmentCount, setAudioSegmentCount] = useState(0);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioScrubValue, setAudioScrubValue] = useState<number | null>(null);
  const [audioError, setAudioError] = useState("");

  const estimatedMinutes = useMemo(() => result ? estimateMinutes(result.sections) : 0, [result]);

  const audioTimeline = useMemo(() => {
    if (!result) return [] as Array<{
      sectionIndex: number;
      segmentIndex: number;
      text: string;
      startSecond: number;
      endSecond: number;
      estimatedSeconds: number;
    }>;

    let cursor = 0;
    const items: Array<{
      sectionIndex: number;
      segmentIndex: number;
      text: string;
      startSecond: number;
      endSecond: number;
      estimatedSeconds: number;
    }> = [];

    result.sections.forEach((section, sectionIndex) => {
      splitSpeechText(section.explainedText).forEach((segment, segmentIndex) => {
        const estimatedSeconds = estimateSpeechSeconds(segment);
        items.push({
          sectionIndex,
          segmentIndex,
          text: segment,
          startSecond: cursor,
          endSecond: cursor + estimatedSeconds,
          estimatedSeconds
        });
        cursor += estimatedSeconds;
      });
    });

    return items;
  }, [result]);

  const audioEstimatedTotalSeconds = useMemo(
    () => audioTimeline.length ? audioTimeline[audioTimeline.length - 1].endSecond : 0,
    [audioTimeline]
  );

  const activeTimelineItem = useMemo(
    () => audioTimeline.find((item) => item.sectionIndex === audioSectionIndex && item.segmentIndex === audioSegmentIndex) || null,
    [audioTimeline, audioSectionIndex, audioSegmentIndex]
  );

  const audioEstimatedElapsedSeconds = useMemo(() => {
    if (!activeTimelineItem) {
      if (!result) return 0;
      const savedSection = Math.min(result.lastSectionIndex || 0, Math.max(0, result.sections.length - 1));
      return audioTimeline.find((item) => item.sectionIndex === savedSection)?.startSecond || 0;
    }
    const ratio = audioDuration > 0 ? Math.max(0, Math.min(1, audioCurrentTime / audioDuration)) : 0;
    return activeTimelineItem.startSecond + activeTimelineItem.estimatedSeconds * ratio;
  }, [activeTimelineItem, audioCurrentTime, audioDuration, audioTimeline, result]);

  const audioDisplayElapsedSeconds = audioScrubValue ?? audioEstimatedElapsedSeconds;
  const audioEstimatedRemainingSeconds = Math.max(0, audioEstimatedTotalSeconds - audioDisplayElapsedSeconds);
  const audioEstimatedWallRemainingSeconds = rate > 0 ? audioEstimatedRemainingSeconds / rate : audioEstimatedRemainingSeconds;

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
    setAudioPlaying(false);
    setAudioPaused(false);
    setAudioLoading(false);
    setAudioCurrentTime(0);
    setAudioDuration(0);
  };

  useEffect(() => {
    rateRef.current = rate;
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  useEffect(() => () => cleanupAudio(), []);

  const loadLibrary = async () => {
    if (!userId || !supabase) {
      setSavedDocs([]);
      return;
    }
    setLibraryLoading(true);
    setLibraryError("");
    const { data, error: fetchError } = await supabase
      .from("study_documents")
      .select("id,title,file_name,subject,topic,status,page_count,source_chars,sections,glossary,settings,coverage,last_section_index,created_at,updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(12);
    setLibraryLoading(false);
    if (fetchError) {
      setLibraryError(fetchError.message.includes("study_documents")
        ? "Falta ejecutar la migración 003_study_documents.sql en Supabase."
        : fetchError.message);
      return;
    }
    setSavedDocs((data || []) as SavedDocumentRow[]);
  };

  useEffect(() => {
    if (!open) return;
    setError("");
    void loadLibrary();
  }, [open, userId]);

  const reset = () => {
    cleanupAudio();
    playAllRef.current = false;
    setFile(null);
    setStage("idle");
    setProgress(0);
    setStageText("");
    setError("");
    setResult(null);
    setExpanded({});
  };

  const selectFile = (selected: File | null) => {
    if (!selected) return;
    if (selected.type !== "application/pdf" && !selected.name.toLowerCase().endsWith(".pdf")) {
      setError("Por ahora Documento explicado acepta archivos PDF.");
      return;
    }
    if (selected.size > MAX_FILE_MB * 1024 * 1024) {
      setError(`El PDF supera ${MAX_FILE_MB} MB. Reduce su tamaño antes de subirlo.`);
      return;
    }
    setError("");
    setFile(selected);
    setResult(null);
  };

  const extractPages = async (selected: File) => {
    const bytes = new Uint8Array(await selected.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const pages: SourcePage[] = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = cleanPdfText(content.items
        .map((item: any) => typeof item?.str === "string" ? `${item.str}${item?.hasEOL ? "\n" : " "}` : "")
        .join(""));
      pages.push({ page: pageNumber, text });
      setProgress(Math.max(2, Math.round((pageNumber / pdf.numPages) * 12)));
      setStageText(`Leyendo página ${pageNumber} de ${pdf.numPages}…`);
    }
    return { pages: stripReferences(pages), totalPages: pdf.numPages };
  };

  const baseSettings = (processing?: ProcessingState, modeOverride: DocumentMode = documentMode): DocumentSettings => ({
    audience,
    mode: modeOverride,
    explainAcronyms: true,
    preserveTechnicalTerms: true,
    omitReferences: true,
    ...(processing ? { processing } : {})
  });

  const createCloudRow = async (selected: File, totalPages: number, sourceChars: number, chunks: SourceChunk[]) => {
    if (!userId || !supabase) return null;
    const now = new Date().toISOString();
    const title = selected.name.replace(/\.pdf$/i, "");
    const processing: ProcessingState = {
      chunks,
      nextChunkIndex: 0,
      totalChunks: chunks.length,
      sourceFileName: selected.name,
      updatedAt: now
    };
    const { data, error: insertError } = await supabase
      .from("study_documents")
      .insert({
        user_id: userId,
        title,
        file_name: selected.name,
        subject,
        topic,
        status: "processing",
        page_count: totalPages,
        source_chars: sourceChars,
        settings: baseSettings(processing),
        sections: [],
        glossary: [],
        coverage: { score: 0, checkedSections: 0, pendingSections: 0 },
        last_section_index: 0,
        created_at: now,
        updated_at: now
      })
      .select("id")
      .single();
    if (insertError) throw new Error(`Supabase: ${insertError.message}`);
    return String(data.id);
  };

  const saveCloudProgress = async (
    documentId: string | null,
    sections: ExplainedDocumentSection[],
    glossary: GlossaryItem[],
    status: "processing" | "complete" | "error",
    processing?: ProcessingState,
    modeOverride: DocumentMode = documentMode
  ) => {
    if (!documentId || !supabase) return;
    const pendingSections = sections.filter((section) => section.coveragePending).length;
    const checkedSections = sections.length - pendingSections;
    const average = verifiedCoverageAverage(sections);
    const { error: updateError } = await supabase
      .from("study_documents")
      .update({
        sections,
        glossary,
        settings: baseSettings(status === "complete" ? undefined : processing, modeOverride),
        coverage: { score: average, checkedSections, pendingSections },
        status,
        updated_at: new Date().toISOString()
      })
      .eq("id", documentId);
    if (updateError) throw new Error(`Supabase: ${updateError.message}`);
  };

  const explainChunk = async (chunk: SourceChunk, index: number, totalChunks: number, modeOverride: DocumentMode) => {
    return postJson("/api/document-explain", {
      sourceText: chunk.text,
      startPage: chunk.startPage,
      endPage: chunk.endPage,
      chunkIndex: index,
      totalChunks,
      subject,
      topic,
      audience,
      documentMode: modeOverride
    });
  };

  const requestCoverage = async (sourceText: string, explainedText: string, modeOverride: DocumentMode) => {
    return postJson("/api/document-coverage", { sourceText, explainedText, documentMode: modeOverride });
  };

  const runProcessing = async ({
    cloudId,
    sourceChunks,
    startIndex,
    initialSections,
    initialGlossary,
    totalPages,
    sourceChars,
    title,
    fileName,
    processingMode
  }: {
    cloudId: string | null;
    sourceChunks: SourceChunk[];
    startIndex: number;
    initialSections: ExplainedDocumentSection[];
    initialGlossary: GlossaryItem[];
    totalPages: number;
    sourceChars: number;
    title: string;
    fileName: string;
    processingMode: DocumentMode;
  }) => {
    const queue = [...sourceChunks];
    const explainedSections = [...initialSections];
    let glossary = dedupeGlossary(initialGlossary);
    let index = Math.max(0, Math.min(startIndex, queue.length));

    while (index < queue.length) {
      const chunk = queue[index];
      const completedRatio = queue.length ? index / queue.length : 0;
      const baseProgress = 16 + Math.round(completedRatio * 76);
      setStage("explaining");
      setProgress(Math.min(92, baseProgress));
      setStageText(`Reexplicando ${index + 1} de ${queue.length} · páginas ${chunk.startPage}–${chunk.endPage}…`);

      let explanationPayload: any;
      try {
        explanationPayload = await explainChunk(chunk, index, queue.length, processingMode);
      } catch (firstError) {
        if (isTimeoutLike(firstError) && chunk.text.length > 1800) {
          const smaller = splitChunkForRetry(chunk);
          if (smaller.length > 1) {
            queue.splice(index, 1, ...smaller);
            setStageText(`La sección ${index + 1} tardó demasiado. La dividí automáticamente en partes más pequeñas para continuar…`);
            await saveCloudProgress(cloudId, explainedSections, glossary, "processing", {
              chunks: queue,
              nextChunkIndex: index,
              totalChunks: queue.length,
              sourceFileName: fileName,
              updatedAt: new Date().toISOString()
            }, processingMode);
            continue;
          }
        }

        if (isRetryable(firstError)) {
          setStageText(`Reintentando automáticamente la sección ${index + 1}…`);
          await wait(errorStatus(firstError) === 429 ? 2600 : 1200);
          try {
            explanationPayload = await explainChunk(chunk, index, queue.length, processingMode);
          } catch (secondError) {
            if (isTimeoutLike(secondError) && chunk.text.length > 1400) {
              const smaller = splitChunkForRetry(chunk);
              if (smaller.length > 1) {
                queue.splice(index, 1, ...smaller);
                await saveCloudProgress(cloudId, explainedSections, glossary, "processing", {
                  chunks: queue,
                  nextChunkIndex: index,
                  totalChunks: queue.length,
                  sourceFileName: fileName,
                  updatedAt: new Date().toISOString()
                }, processingMode);
                continue;
              }
            }
            throw secondError;
          }
        } else {
          throw firstError;
        }
      }

      let section = explanationPayload.section as Omit<ExplainedDocumentSection, "id" | "startPage" | "endPage" | "sourceChars" | "coverageScore" | "missingPoints">;

      setStage("checking");
      setStageText(`Comprobando que no falte contenido en la sección ${index + 1}…`);
      setProgress(Math.min(94, baseProgress + 2));

      let coverage: { score: number; missingPoints: string[]; verdict?: string } = { score: 0, missingPoints: [] };
      let coveragePending = false;
      try {
        const coveragePayload = await requestCoverage(chunk.text, section.explainedText, processingMode);
        coverage = coveragePayload.coverage;
      } catch (coverageError) {
        if (isRetryable(coverageError)) {
          setStageText(`La revisión de cobertura de la sección ${index + 1} está tardando. Reintentando una vez…`);
          await wait(errorStatus(coverageError) === 429 ? 2400 : 900);
          try {
            const retryCoverage = await requestCoverage(chunk.text, section.explainedText, processingMode);
            coverage = retryCoverage.coverage;
          } catch {
            coveragePending = true;
          }
        } else {
          coveragePending = true;
        }
      }

      let repaired = false;
      if (!coveragePending && (coverage.score || 0) < 90 && Array.isArray(coverage.missingPoints) && coverage.missingPoints.length) {
        setStageText(`Completando puntos faltantes de la sección ${index + 1}…`);
        try {
          const repairPayload = await postJson("/api/document-repair", {
            sourceText: chunk.text,
            currentExplanation: section.explainedText,
            missingPoints: coverage.missingPoints,
            subject,
            topic,
            audience,
            documentMode: processingMode
          });
          if (repairPayload?.section?.explainedText) {
            section = { ...section, ...repairPayload.section };
            repaired = true;
            try {
              const recheckPayload = await requestCoverage(chunk.text, section.explainedText, processingMode);
              if (recheckPayload?.coverage) coverage = recheckPayload.coverage;
            } catch {
              // Conservamos la última revisión válida; una caída de la re-comprobación no borra el trabajo terminado.
            }
          }
        } catch {
          // Si la reparación falla, conservamos la explicación y los puntos pendientes en vez de detener todo el documento.
        }
      }

      const normalized: ExplainedDocumentSection = {
        id: `section-${explainedSections.length + 1}`,
        title: String(section.title || `Sección ${explainedSections.length + 1}`),
        startPage: chunk.startPage,
        endPage: chunk.endPage,
        sourceChars: chunk.text.length,
        explainedText: String(section.explainedText || ""),
        glossary: Array.isArray(section.glossary) ? section.glossary : [],
        anchor: String(section.anchor || ""),
        coverageScore: coveragePending ? 0 : Math.max(0, Math.min(100, Math.round(Number(coverage.score) || 0))),
        missingPoints: coveragePending
          ? ["Revisión de cobertura pendiente: el verificador tardó demasiado, pero la explicación sí quedó guardada."]
          : Array.isArray(coverage.missingPoints) ? coverage.missingPoints.map(String).slice(0, 8) : [],
        repaired,
        coveragePending
      };
      explainedSections.push(normalized);
      glossary = dedupeGlossary([...glossary, ...normalized.glossary]);
      index += 1;

      await saveCloudProgress(cloudId, explainedSections, glossary, "processing", {
        chunks: queue,
        nextChunkIndex: index,
        totalChunks: queue.length,
        sourceFileName: fileName,
        updatedAt: new Date().toISOString()
      }, processingMode);
    }

    setStage("saving");
    setStageText("Guardando la versión explicada…");
    setProgress(96);
    await saveCloudProgress(cloudId, explainedSections, glossary, "complete", undefined, processingMode);

    const averageCoverage = verifiedCoverageAverage(explainedSections);
    const pendingCount = explainedSections.filter((section) => section.coveragePending).length;
    const now = new Date().toISOString();
    const completed: ExplainedDocument = {
      id: cloudId || undefined,
      title,
      fileName,
      subject,
      topic,
      pageCount: totalPages,
      sourceChars,
      sections: explainedSections,
      glossary,
      coverageScore: averageCoverage,
      coveragePendingCount: pendingCount,
      createdAt: now,
      updatedAt: now,
      lastSectionIndex: 0
    };
    setResult(completed);
    setExpanded({ [explainedSections[0]?.id || ""]: true });
    setStage("done");
    setStageText(pendingCount ? `Documento listo · ${pendingCount} revisión${pendingCount === 1 ? "" : "es"} de cobertura pendiente${pendingCount === 1 ? "" : "s"}` : "Documento listo");
    setProgress(100);
    void loadLibrary();
  };

  const process = async () => {
    if (!file || stage === "extracting" || stage === "explaining" || stage === "checking" || stage === "saving") return;
    cleanupAudio();
    setError("");
    setResult(null);
    setProgress(1);
    setStage("extracting");
    setStageText("Abriendo el PDF…");

    let cloudId: string | null = null;
    let chunks: SourceChunk[] = [];
    let sourceChars = 0;
    let totalPages = 0;
    try {
      const extracted = await extractPages(file);
      totalPages = extracted.totalPages;
      const usablePages = extracted.pages.filter((page) => page.text.trim().length > 25);
      if (!usablePages.length) throw new Error("No pude extraer texto del PDF. Si es un documento escaneado, primero necesita OCR.");

      chunks = buildChunks(usablePages);
      if (!chunks.length) throw new Error("El documento no contiene suficiente texto para procesarlo.");
      sourceChars = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);

      setStage("saving");
      setStageText(userId ? "Preparando un punto de recuperación en Supabase…" : "Preparando el documento…");
      setProgress(14);
      cloudId = await createCloudRow(file, totalPages, sourceChars, chunks);

      await runProcessing({
        cloudId,
        sourceChunks: chunks,
        startIndex: 0,
        initialSections: [],
        initialGlossary: [],
        totalPages,
        sourceChars,
        title: file.name.replace(/\.pdf$/i, ""),
        fileName: file.name,
        processingMode: documentMode
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "No pude preparar el documento explicado.";
      setError(message);
      setStage("error");
      setStageText("Proceso pausado");
      if (cloudId && supabase) {
        // runProcessing ya guardó cada avance confirmado. Aquí solo marcamos el intento como pausado
        // para no sobrescribir secciones o la cola de recuperación con estado antiguo del navegador.
        void supabase.from("study_documents")
          .update({ status: "error", updated_at: new Date().toISOString() })
          .eq("id", cloudId);
      }
      void loadLibrary();
    }
  };

  const resumeSaved = async (row: SavedDocumentRow) => {
    const processing = row.settings?.processing;
    if (!processing?.chunks?.length) {
      setError("Este intento se creó antes de la mejora de recuperación. Vuelve a seleccionar el PDF una vez; los siguientes intentos sí podrán reanudarse automáticamente.");
      return;
    }
    cleanupAudio();
    setError("");
    setResult(null);
    setStage("explaining");
    setProgress(Math.max(16, Math.round((processing.nextChunkIndex / Math.max(1, processing.chunks.length)) * 90)));
    setStageText(`Retomando desde la sección ${processing.nextChunkIndex + 1}…`);
    setAudience(row.settings?.audience || audience);

    const resumeMode = normalizeDocumentMode(row.settings?.mode);
    setDocumentMode(resumeMode);
    try {
      await runProcessing({
        cloudId: row.id,
        sourceChunks: processing.chunks,
        startIndex: processing.nextChunkIndex,
        initialSections: Array.isArray(row.sections) ? row.sections : [],
        initialGlossary: Array.isArray(row.glossary) ? row.glossary : [],
        totalPages: row.page_count,
        sourceChars: row.source_chars,
        title: row.title,
        fileName: row.file_name,
        processingMode: resumeMode
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "No pude continuar el documento.";
      setError(message);
      setStage("error");
      setStageText("Proceso pausado");
      if (supabase) {
        // Igual que en un procesamiento nuevo, conservamos el último checkpoint guardado por runProcessing.
        await supabase.from("study_documents")
          .update({ status: "error", updated_at: new Date().toISOString() })
          .eq("id", row.id);
      }
      void loadLibrary();
    }
  };

  const openSaved = (row: SavedDocumentRow) => {
    cleanupAudio();
    playAllRef.current = false;
    const document = rowToDocument(row);
    setDocumentMode(normalizeDocumentMode(row.settings?.mode));
    setResult(document);
    setFile(null);
    setStage("done");
    setProgress(100);
    setStageText("Documento recuperado de Supabase");
    const target = document.sections[Math.min(document.lastSectionIndex, Math.max(0, document.sections.length - 1))];
    setExpanded(target ? { [target.id]: true } : {});
  };

  const saveListeningProgress = async (sectionIndex: number) => {
    if (!result?.id || !userId || !supabase) return;
    const completedTimeline = audioTimeline.filter((item) => item.sectionIndex <= sectionIndex);
    const sectionEnd = completedTimeline.length ? completedTimeline[completedTimeline.length - 1].endSecond : 0;
    const complete = sectionIndex >= result.sections.length - 1;
    void supabase
      .from("study_documents")
      .update({
        last_section_index: sectionIndex,
        audio_progress: {
          sectionIndex,
          segmentIndex: 0,
          segmentRatio: complete ? 1 : 0,
          documentSecond: sectionEnd,
          completed: complete,
          rate,
          updatedAt: new Date().toISOString()
        },
        last_played_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", result.id)
      .eq("user_id", userId);
  };

  const createAudioForText = async (text: string) => {
    const audio = await getOrCreateAudioBlob({
      userId,
      documentId: result?.id || null,
      text
    });
    return audio.blob;
  };

  const playSegment = async (
    sectionIndex: number,
    segmentIndex: number,
    allMode: boolean,
    suppliedSegments?: string[],
    startRatio = 0,
    startPaused = false
  ) => {
    if (!result) return;
    const section = result.sections[sectionIndex];
    if (!section) return;
    const segments = suppliedSegments || splitSpeechText(section.explainedText);
    const segment = segments[segmentIndex];
    if (!segment) return;

    cleanupAudio();
    setAudioError("");
    setAudioLoading(true);
    setAudioSectionIndex(sectionIndex);
    setAudioSegmentIndex(segmentIndex);
    setAudioSegmentCount(segments.length);
    playAllRef.current = allMode;

    try {
      const blob = await createAudioForText(segment);
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      const audio = new Audio(url);
      audio.playbackRate = rateRef.current;
      audio.preload = "auto";

      let playbackStarted = false;
      const startPlayback = async () => {
        if (playbackStarted) return;
        playbackStarted = true;
        const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
        setAudioDuration(duration);
        if (duration > 0 && startRatio > 0) {
          audio.currentTime = Math.max(0, Math.min(duration - 0.05, duration * Math.max(0, Math.min(1, startRatio))));
          setAudioCurrentTime(audio.currentTime);
        }

        if (startPaused) {
          setAudioPlaying(true);
          setAudioPaused(true);
          setAudioLoading(false);
          return;
        }

        try {
          await audio.play();
          setAudioPlaying(true);
          setAudioPaused(false);
          setAudioLoading(false);
        } catch {
          setAudioPlaying(true);
          setAudioPaused(true);
          setAudioLoading(false);
          setAudioError("El navegador bloqueó la reproducción automática. Pulsa Continuar para seguir.");
        }
      };

      audio.onloadedmetadata = () => { void startPlayback(); };
      audio.ondurationchange = () => {
        if (Number.isFinite(audio.duration)) setAudioDuration(audio.duration);
      };
      audio.ontimeupdate = () => {
        setAudioCurrentTime(audio.currentTime || 0);
        if (Number.isFinite(audio.duration)) setAudioDuration(audio.duration);
      };
      audio.onended = () => {
        setAudioCurrentTime(audio.duration || 0);
        if (segmentIndex < segments.length - 1) {
          void playSegment(sectionIndex, segmentIndex + 1, allMode, segments);
          return;
        }
        void saveListeningProgress(sectionIndex);
        if (allMode && result.sections[sectionIndex + 1]) {
          void playSegment(sectionIndex + 1, 0, true);
          return;
        }
        setAudioPlaying(false);
        setAudioPaused(false);
        setAudioLoading(false);
      };
      audio.onerror = () => {
        setAudioPlaying(false);
        setAudioLoading(false);
        setAudioError("No pude reproducir este tramo del documento.");
      };
      audioRef.current = audio;
      audio.load();

      if (audio.readyState >= 1) {
        void startPlayback();
      }
    } catch (err) {
      cleanupAudio();
      setAudioError(err instanceof Error ? err.message : "No pude reproducir el documento.");
    }
  };

  const seekToDocumentSecond = (targetSecond: number) => {
    if (!result || !audioTimeline.length) return;
    const target = Math.max(0, Math.min(audioEstimatedTotalSeconds, targetSecond));
    const item = audioTimeline.find((timelineItem) => target < timelineItem.endSecond)
      || audioTimeline[audioTimeline.length - 1];
    const offset = Math.max(0, target - item.startSecond);
    const startRatio = item.estimatedSeconds > 0 ? offset / item.estimatedSeconds : 0;
    const keepPaused = audioPaused;
    const allMode = playAllRef.current || (!audioPlaying && !audioPaused);
    setAudioScrubValue(null);
    void playSegment(item.sectionIndex, item.segmentIndex, allMode, undefined, startRatio, keepPaused);
  };

  const seekRelative = (deltaSeconds: number) => {
    const audio = audioRef.current;
    if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
      const next = audio.currentTime + deltaSeconds;
      if (next >= 0 && next <= audio.duration) {
        audio.currentTime = next;
        setAudioCurrentTime(next);
        return;
      }
    }
    seekToDocumentSecond(audioEstimatedElapsedSeconds + deltaSeconds);
  };

  const commitScrub = () => {
    if (audioScrubValue === null) return;
    seekToDocumentSecond(audioScrubValue);
  };

  const toggleAudio = async () => {
    if (!result) return;
    if (audioRef.current && audioPlaying && !audioPaused) {
      audioRef.current.pause();
      setAudioPaused(true);
      return;
    }
    if (audioRef.current && audioPaused) {
      await audioRef.current.play();
      setAudioPaused(false);
      setAudioPlaying(true);
      return;
    }
    const startIndex = Math.min(result.lastSectionIndex || 0, Math.max(0, result.sections.length - 1));
    void playSegment(startIndex, 0, true);
  };

  const playOneSection = (index: number) => {
    playAllRef.current = false;
    void playSegment(index, 0, false);
  };

  const stopAudio = () => {
    playAllRef.current = false;
    cleanupAudio();
    setAudioSectionIndex(null);
    setAudioSegmentIndex(0);
    setAudioSegmentCount(0);
  };

  if (!open) return null;

  const busy = ["extracting", "explaining", "checking", "saving"].includes(stage);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) { stopAudio(); onClose(); }
    }}>
      <section className="document-modal" role="dialog" aria-modal="true" aria-label="Documento explicado">
        <header className="quiz-header document-modal-header">
          <div>
            <span className="mini-label">DOCUMENTO EXPLICADO</span>
            <h2>{result ? result.title : "Convierte un PDF técnico en una explicación completa"}</h2>
          </div>
          <button className="modal-close" onClick={() => { stopAudio(); onClose(); }} disabled={busy} aria-label="Cerrar"><X size={20} /></button>
        </header>

        {!result && !busy && (
          <div className="document-start">
            <section className="document-promise">
              <div className="document-promise-icon"><FileAudio size={28} /></div>
              <div>
                <span className="mini-label">COBERTURA CONCEPTUAL</span>
                <h3>Todos los conceptos importantes, sin el lenguaje pesado</h3>
                <p>Companion usa el documento como guía: elimina redundancias, explica siglas y tecnicismos, conserva las ideas académicas relevantes y solo amplía lo necesario para que puedas entenderlas.</p>
              </div>
            </section>

            <section
              className={`document-dropzone ${file ? "has-file" : ""}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                selectFile(event.dataTransfer.files?.[0] || null);
              }}
              onClick={() => fileInputRef.current?.click()}
            >
              <input ref={fileInputRef} type="file" accept="application/pdf,.pdf" hidden onChange={(event) => selectFile(event.target.files?.[0] || null)} />
              {file ? <FileText size={30} /> : <Upload size={30} />}
              <strong>{file ? file.name : "Suelta aquí tu PDF o haz clic para elegirlo"}</strong>
              <span>{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB · listo para procesar` : `PDF de hasta ${MAX_FILE_MB} MB · el archivo se lee en tu navegador`}</span>
            </section>

            <div className="document-settings">
              <label>
                <span>Explícamelo como</span>
                <select value={audience} onChange={(event) => setAudience(event.target.value)}>
                  <option>Profesional de informática</option>
                  <option>Universitario no especialista</option>
                  <option>Muy sencillo</option>
                  <option>Técnico</option>
                </select>
              </label>
              <div className="document-mode-picker">
                <span className="document-mode-title">¿Qué quieres obtener?</span>
                <div className="document-mode-options">
                  {(Object.entries(documentModes) as [DocumentMode, (typeof documentModes)[DocumentMode]][]).map(([key, option]) => (
                    <button type="button" key={key} className={documentMode === key ? "active" : ""} onClick={() => setDocumentMode(key)}>
                      <div><strong>{option.label}</strong><span>{option.time}</span></div>
                      <p>{option.description}</p>
                    </button>
                  ))}
                </div>
              </div>
              <div className="document-rules">
                <span><Check size={14} /> Cobertura conceptual</span>
                <span><Check size={14} /> Explicar todas las siglas</span>
                <span><Check size={14} /> Mantener términos técnicos importantes</span>
                <span><Check size={14} /> Evitar repeticiones innecesarias</span>
                <span><Check size={14} /> Omitir referencias</span>
              </div>
            </div>

            {error && <div className="document-error"><CircleAlert size={18} /><span>{error}</span></div>}

            <button className="primary-action document-process-button" disabled={!file} onClick={process}>
              <Sparkles size={18} /> Preparar · {documentModes[documentMode].label}
            </button>
            <p className="document-save-note">{userId
              ? "Tu versión explicada se guardará en Supabase para continuar en otros dispositivos."
              : "Puedes procesarlo sin iniciar sesión, pero no se guardará entre dispositivos."}</p>

            <section className="document-library">
              <div className="document-library-heading">
                <div><span className="mini-label">TU BIBLIOTECA</span><strong>Documentos explicados</strong></div>
                {userId && <button onClick={() => void loadLibrary()} disabled={libraryLoading}><RefreshCcw size={14} className={libraryLoading ? "spin" : ""} /> Actualizar</button>}
              </div>
              {!userId ? (
                <div className="document-library-empty"><Library size={20} /><span>Inicia sesión para guardar y recuperar tus documentos en otros dispositivos.</span></div>
              ) : libraryError ? (
                <div className="document-library-empty error"><CircleAlert size={20} /><span>{libraryError}</span></div>
              ) : libraryLoading ? (
                <div className="document-library-empty"><LoaderCircle size={20} className="spin" /><span>Cargando tu biblioteca…</span></div>
              ) : savedDocs.length ? (
                <div className="document-library-list">
                  {savedDocs.filter((doc) => doc.status !== "complete").map((doc) => {
                    const processing = doc.settings?.processing;
                    const completed = doc.sections?.length || 0;
                    const total = processing?.chunks?.length || processing?.totalChunks || 0;
                    return (
                      <button key={doc.id} onClick={() => void resumeSaved(doc)} disabled={!processing?.chunks?.length}>
                        <RefreshCcw size={18} />
                        <div><strong>{doc.title}</strong><span>{processing?.chunks?.length ? `Procesamiento pausado · ${completed} de ${total} partes guardadas` : "Intento anterior · vuelve a subir el PDF para reprocesarlo"}</span></div>
                        <span>{processing?.chunks?.length ? "Reanudar →" : "Sin recuperación"}</span>
                      </button>
                    );
                  })}
                  {savedDocs.filter((doc) => doc.status === "complete").map((doc) => (
                    <button key={doc.id} onClick={() => openSaved(doc)}>
                      <FileText size={18} />
                      <div><strong>{doc.title}</strong><span>{doc.page_count} páginas · {doc.sections?.length || 0} capítulos · {new Date(doc.updated_at).toLocaleDateString("es-MX")}</span></div>
                      <span>Continuar →</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="document-library-empty"><Library size={20} /><span>Todavía no tienes documentos explicados guardados.</span></div>
              )}
            </section>
          </div>
        )}

        {busy && (
          <div className="document-processing">
            <div className="document-processing-icon"><LoaderCircle size={34} className="spin" /></div>
            <span className="mini-label">PROCESANDO DOCUMENTO COMPLETO</span>
            <h3>{stageText}</h3>
            <div className="document-progress"><span style={{ width: `${progress}%` }} /></div>
            <div className="document-progress-label"><span>{progress}%</span><span>Puede tardar varios minutos porque verificamos que no se pierdan conceptos importantes.</span></div>
            <div className="document-stage-list">
              <span className={["extracting", "explaining", "checking", "saving"].indexOf(stage) >= 0 ? "active" : ""}><Check size={14} /> Leer estructura y quitar referencias</span>
              <span className={["explaining", "checking", "saving"].includes(stage) ? "active" : ""}><Sparkles size={14} /> Reexplicar sección por sección</span>
              <span className={["checking", "saving"].includes(stage) ? "active" : ""}><BookOpenCheck size={14} /> Comprobar cobertura</span>
              <span className={stage === "saving" ? "active" : ""}><Library size={14} /> Guardar para otros dispositivos</span>
            </div>
          </div>
        )}

        {stage === "error" && !result && (
          <div className="document-processing document-failed">
            <CircleAlert size={34} />
            <h3>No pude terminar el documento</h3>
            <p>{error}</p>
            <button className="secondary-action" onClick={() => { setStage("idle"); void loadLibrary(); }}><RefreshCcw size={17} /> Revisar recuperación</button>
          </div>
        )}

        {result && (
          <div className="document-result">
            <section className="document-overview">
              <div className="document-overview-main">
                <span className="mini-label">DOCUMENTO EXPLICADO · {documentModes[documentMode].label.toUpperCase()}</span>
                <h3>{result.title}</h3>
                <p>{result.pageCount} páginas originales · {result.sections.length} capítulos · ~{estimatedMinutes} min reales de audio generado</p>
              </div>
              <div className={`coverage-badge ${result.coverageScore >= 90 ? "good" : "review"}`}>
                <BookOpenCheck size={17} /><strong>{result.coveragePendingCount && !result.coverageScore ? "—" : `${result.coverageScore}%`}</strong><span>{result.coveragePendingCount ? `${result.coveragePendingCount} revisión${result.coveragePendingCount === 1 ? "" : "es"} pendiente${result.coveragePendingCount === 1 ? "" : "s"}` : "cobertura verificada"}</span>
              </div>
              <button className="document-new" onClick={reset}>Nuevo PDF</button>
            </section>

            <section className="document-audio-master">
              <div className="document-audio-header">
                <div>
                  <span className="mini-label">ELEVENLABS · REPRODUCTOR DEL DOCUMENTO</span>
                  <h3>{audioSectionIndex !== null ? result.sections[audioSectionIndex]?.title : "Escucha el documento en lenguaje humano"}</h3>
                  <p>{audioSectionIndex !== null ? `Capítulo ${audioSectionIndex + 1} de ${result.sections.length} · tramo ${audioSegmentIndex + 1} de ${Math.max(1, audioSegmentCount)}` : `Duración estimada ~${formatAudioTime(audioEstimatedTotalSeconds)}. Puedes saltar a cualquier parte.`}</p>
                </div>
                <div className="document-audio-time-summary">
                  <strong>{formatAudioTime(audioDisplayElapsedSeconds)}</strong>
                  <span>de ~{formatAudioTime(audioEstimatedTotalSeconds)}</span>
                </div>
              </div>

              <div className="document-audio-progress">
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, Math.round(audioEstimatedTotalSeconds))}
                  step={1}
                  value={Math.round(audioDisplayElapsedSeconds)}
                  aria-label="Posición aproximada en el documento"
                  onPointerDown={() => setAudioScrubValue(audioEstimatedElapsedSeconds)}
                  onChange={(event) => setAudioScrubValue(Number(event.target.value))}
                  onPointerUp={commitScrub}
                  onPointerCancel={() => setAudioScrubValue(null)}
                  onKeyUp={(event) => {
                    if (["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) commitScrub();
                  }}
                />
                <div className="document-audio-progress-meta">
                  <span>{audioDuration > 0 ? `Tramo actual ${formatAudioTime(audioCurrentTime)} / ${formatAudioTime(audioDuration)}` : "El primer tramo se genera al comenzar"}</span>
                  <span>Faltan ~{formatAudioTime(audioEstimatedRemainingSeconds)}{rate !== 1 ? ` · a ${rate}× ≈ ${formatAudioTime(audioEstimatedWallRemainingSeconds)} reales` : ""}</span>
                </div>
              </div>

              <div className="document-audio-toolbar">
                <div className="document-audio-transport">
                  <button className="audio-jump" onClick={() => seekRelative(-15)} disabled={audioLoading || (!audioPlaying && !audioPaused)} aria-label="Retroceder 15 segundos">
                    <Rewind size={17} /> 15
                  </button>
                  <button className="audio-main-control" onClick={toggleAudio} disabled={audioLoading}>
                    {audioLoading ? <LoaderCircle size={18} className="spin" /> : audioPlaying && !audioPaused ? <Pause size={18} /> : <Play size={18} />}
                    {audioLoading ? "Generando…" : audioPlaying && !audioPaused ? "Pausar" : audioPaused ? "Continuar" : "Escuchar todo"}
                  </button>
                  <button className="audio-jump" onClick={() => seekRelative(15)} disabled={audioLoading || (!audioPlaying && !audioPaused)} aria-label="Adelantar 15 segundos">
                    15 <FastForward size={17} />
                  </button>
                  <button className="audio-stop" onClick={stopAudio} disabled={!audioPlaying && !audioPaused}><Square size={15} /> Detener</button>
                </div>
                <div className="document-audio-speed">
                  <span>Velocidad</span>
                  <div className="audio-rates">
                    {rates.map((item) => <button key={item} className={rate === item ? "active" : ""} onClick={() => setRate(item)}>{item}x</button>)}
                  </div>
                </div>
              </div>
              <div className="document-audio-estimate-note">La línea de tiempo total es aproximada porque ElevenLabs genera los tramos bajo demanda. El tiempo del tramo actual sí es exacto.</div>
              {audioError && <div className="document-audio-error">{audioError}</div>}
            </section>

            {!!result.glossary.length && (
              <section className="document-glossary">
                <div className="document-section-heading"><div><span className="mini-label">DICCIONARIO DEL DOCUMENTO</span><h3>Siglas y términos que aparecen</h3></div><span>{result.glossary.length} conceptos</span></div>
                <div className="document-glossary-grid">
                  {result.glossary.map((item) => <div key={`${item.term}-${item.meaning}`}><strong>{item.term}</strong><span>{item.meaning}</span></div>)}
                </div>
              </section>
            )}

            <section className="document-sections">
              <div className="document-section-heading">
                <div><span className="mini-label">LECTURA EXPLICADA</span><h3>Los conceptos del documento, capítulo por capítulo</h3></div>
                <span>{result.sections.length} secciones</span>
              </div>
              {result.sections.map((section, index) => {
                const isOpen = Boolean(expanded[section.id]);
                const isCurrentAudio = audioSectionIndex === index && (audioPlaying || audioPaused || audioLoading);
                return (
                  <article className={`document-section-card ${isCurrentAudio ? "playing" : ""}`} key={section.id}>
                    <button className="document-section-toggle" onClick={() => setExpanded((current) => ({ ...current, [section.id]: !isOpen }))}>
                      <span className="document-section-number">{index + 1}</span>
                      <div><strong>{section.title}</strong><span>Páginas {section.startPage}–{section.endPage} · {section.coveragePending ? "cobertura pendiente" : `cobertura ${section.coverageScore}%`}{section.repaired ? " · revisada automáticamente" : ""}</span></div>
                      {isOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                    </button>
                    {isOpen && (
                      <div className="document-section-content">
                        <div className="document-anchor"><Sparkles size={15} /><div><strong>Antes de continuar, quédate con esto</strong><p>{section.anchor}</p></div></div>
                        <div className="document-explained-text">{section.explainedText.split(/\n{2,}/).map((paragraph, paragraphIndex) => <p key={paragraphIndex}>{paragraph}</p>)}</div>
                        {!!section.missingPoints.length && <div className="document-coverage-warning"><CircleAlert size={16} /><span>La comprobación todavía detectó: {section.missingPoints.join(" · ")}</span></div>}
                        <div className="document-section-actions">
                          <button onClick={() => playOneSection(index)}><Headphones size={15} /> Escuchar capítulo</button>
                          {onUseInChat && <button onClick={() => onUseInChat(section.title, section.explainedText)}><Sparkles size={15} /> Llevar al chat</button>}
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </section>
          </div>
        )}
      </section>
    </div>
  );
}
