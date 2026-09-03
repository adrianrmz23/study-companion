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
  RefreshCcw,
  Sparkles,
  Square,
  Upload,
  X
} from "lucide-react";
import { supabase } from "./supabase";

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
  coverage: { score?: number } | null;
  last_section_index: number | null;
  created_at: string;
  updated_at: string;
};

type SourcePage = { page: number; text: string };
type SourceChunk = { id: string; startPage: number; endPage: number; text: string };

type Props = {
  open: boolean;
  userId?: string | null;
  subject: string;
  topic: string;
  onClose: () => void;
  onUseInChat?: (title: string, text: string) => void;
};

type Stage = "idle" | "extracting" | "explaining" | "checking" | "saving" | "done" | "error";

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

function splitLongText(text: string, maxChars = 7600) {
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

function buildChunks(pages: SourcePage[], targetChars = 6800, maxChars = 8200): SourceChunk[] {
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

function splitSpeechText(text: string, maxChars = 8200) {
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

  const [rate, setRate] = useState(1);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioPaused, setAudioPaused] = useState(false);
  const [audioSectionIndex, setAudioSectionIndex] = useState<number | null>(null);
  const [audioSegmentIndex, setAudioSegmentIndex] = useState(0);
  const [audioSegmentCount, setAudioSegmentCount] = useState(0);
  const [audioError, setAudioError] = useState("");

  const estimatedMinutes = useMemo(() => result ? estimateMinutes(result.sections) : 0, [result]);

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
      .select("id,title,file_name,subject,topic,status,page_count,source_chars,sections,glossary,coverage,last_section_index,created_at,updated_at")
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

  const createCloudRow = async (selected: File, totalPages: number, sourceChars: number) => {
    if (!userId || !supabase) return null;
    const now = new Date().toISOString();
    const title = selected.name.replace(/\.pdf$/i, "");
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
        settings: {
          audience,
          mode: "complete_not_summary",
          explainAcronyms: true,
          preserveTechnicalTerms: true,
          omitReferences: true
        },
        sections: [],
        glossary: [],
        coverage: {},
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
    status: "processing" | "complete" | "error"
  ) => {
    if (!documentId || !supabase) return;
    const average = sections.length
      ? Math.round(sections.reduce((sum, section) => sum + (section.coverageScore || 0), 0) / sections.length)
      : 0;
    const { error: updateError } = await supabase
      .from("study_documents")
      .update({
        sections,
        glossary,
        coverage: { score: average, checkedSections: sections.length },
        status,
        updated_at: new Date().toISOString()
      })
      .eq("id", documentId);
    if (updateError) throw new Error(`Supabase: ${updateError.message}`);
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
    try {
      const { pages, totalPages } = await extractPages(file);
      const usablePages = pages.filter((page) => page.text.trim().length > 25);
      if (!usablePages.length) throw new Error("No pude extraer texto del PDF. Si es un documento escaneado, primero necesita OCR.");

      const chunks = buildChunks(usablePages);
      if (!chunks.length) throw new Error("El documento no contiene suficiente texto para procesarlo.");
      const sourceChars = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);

      setStage("saving");
      setStageText(userId ? "Preparando el documento en Supabase…" : "Preparando el documento…");
      setProgress(14);
      cloudId = await createCloudRow(file, totalPages, sourceChars);

      const explainedSections: ExplainedDocumentSection[] = [];
      let glossary: GlossaryItem[] = [];

      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        const baseProgress = 16 + Math.round((index / chunks.length) * 76);
        setStage("explaining");
        setProgress(baseProgress);
        setStageText(`Reexplicando ${index + 1} de ${chunks.length} · páginas ${chunk.startPage}–${chunk.endPage}…`);

        const explanationResponse = await fetch("/api/document-explain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceText: chunk.text,
            startPage: chunk.startPage,
            endPage: chunk.endPage,
            chunkIndex: index,
            totalChunks: chunks.length,
            subject,
            topic,
            audience
          })
        });
        const explanationPayload = await explanationResponse.json().catch(() => ({}));
        if (!explanationResponse.ok) throw new Error(explanationPayload?.error || `No pude explicar la sección ${index + 1}.`);

        let section = explanationPayload.section as Omit<ExplainedDocumentSection, "id" | "startPage" | "endPage" | "sourceChars" | "coverageScore" | "missingPoints">;

        setStage("checking");
        setStageText(`Comprobando que no falte contenido en la sección ${index + 1}…`);
        setProgress(Math.min(94, baseProgress + Math.max(1, Math.round(35 / chunks.length))));

        const coverageResponse = await fetch("/api/document-coverage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceText: chunk.text, explainedText: section.explainedText })
        });
        const coveragePayload = await coverageResponse.json().catch(() => ({}));
        if (!coverageResponse.ok) throw new Error(coveragePayload?.error || `No pude comprobar la sección ${index + 1}.`);
        let coverage = coveragePayload.coverage as { score: number; missingPoints: string[]; verdict?: string };
        let repaired = false;

        if ((coverage.score || 0) < 90 && Array.isArray(coverage.missingPoints) && coverage.missingPoints.length) {
          setStageText(`Completando puntos faltantes de la sección ${index + 1}…`);
          const repairResponse = await fetch("/api/document-repair", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sourceText: chunk.text,
              currentExplanation: section.explainedText,
              missingPoints: coverage.missingPoints,
              subject,
              topic,
              audience
            })
          });
          const repairPayload = await repairResponse.json().catch(() => ({}));
          if (repairResponse.ok && repairPayload?.section?.explainedText) {
            section = { ...section, ...repairPayload.section };
            repaired = true;
            const recheckResponse = await fetch("/api/document-coverage", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sourceText: chunk.text, explainedText: section.explainedText })
            });
            const recheckPayload = await recheckResponse.json().catch(() => ({}));
            if (recheckResponse.ok && recheckPayload?.coverage) coverage = recheckPayload.coverage;
          }
        }

        const normalized: ExplainedDocumentSection = {
          id: `section-${index + 1}`,
          title: String(section.title || `Sección ${index + 1}`),
          startPage: chunk.startPage,
          endPage: chunk.endPage,
          sourceChars: chunk.text.length,
          explainedText: String(section.explainedText || ""),
          glossary: Array.isArray(section.glossary) ? section.glossary : [],
          anchor: String(section.anchor || ""),
          coverageScore: Math.max(0, Math.min(100, Math.round(Number(coverage.score) || 0))),
          missingPoints: Array.isArray(coverage.missingPoints) ? coverage.missingPoints.map(String).slice(0, 8) : [],
          repaired
        };
        explainedSections.push(normalized);
        glossary = dedupeGlossary([...glossary, ...normalized.glossary]);
        await saveCloudProgress(cloudId, explainedSections, glossary, "processing");
      }

      setStage("saving");
      setStageText("Guardando la versión explicada…");
      setProgress(96);
      await saveCloudProgress(cloudId, explainedSections, glossary, "complete");

      const averageCoverage = Math.round(explainedSections.reduce((sum, section) => sum + section.coverageScore, 0) / explainedSections.length);
      const now = new Date().toISOString();
      const completed: ExplainedDocument = {
        id: cloudId || undefined,
        title: file.name.replace(/\.pdf$/i, ""),
        fileName: file.name,
        subject,
        topic,
        pageCount: totalPages,
        sourceChars,
        sections: explainedSections,
        glossary,
        coverageScore: averageCoverage,
        createdAt: now,
        updatedAt: now,
        lastSectionIndex: 0
      };
      setResult(completed);
      setExpanded({ [explainedSections[0]?.id || ""]: true });
      setStage("done");
      setStageText("Documento listo");
      setProgress(100);
      void loadLibrary();
    } catch (err) {
      const message = err instanceof Error ? err.message : "No pude preparar el documento explicado.";
      setError(message);
      setStage("error");
      setStageText("Proceso detenido");
      if (cloudId && supabase) {
        void supabase.from("study_documents").update({ status: "error", updated_at: new Date().toISOString() }).eq("id", cloudId);
      }
    }
  };

  const openSaved = (row: SavedDocumentRow) => {
    cleanupAudio();
    playAllRef.current = false;
    const document = rowToDocument(row);
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
    void supabase
      .from("study_documents")
      .update({ last_section_index: sectionIndex, updated_at: new Date().toISOString() })
      .eq("id", result.id)
      .eq("user_id", userId);
  };

  const createAudioForText = async (text: string) => {
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
  };

  const playSegment = async (sectionIndex: number, segmentIndex: number, allMode: boolean, suppliedSegments?: string[]) => {
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
      audio.onended = () => {
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
      await audio.play();
      setAudioPlaying(true);
      setAudioPaused(false);
      setAudioLoading(false);
    } catch (err) {
      cleanupAudio();
      setAudioError(err instanceof Error ? err.message : "No pude reproducir el documento.");
    }
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
                <span className="mini-label">NO ES UN RESUMEN</span>
                <h3>El mismo contenido, pero explicado para entenderlo</h3>
                <p>Companion recorre todo el documento, omite las referencias finales, explica siglas y tecnicismos, añade ejemplos cuando ayudan y después verifica que no haya desaparecido contenido importante.</p>
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
              <div className="document-rules">
                <span><Check size={14} /> No resumir</span>
                <span><Check size={14} /> Explicar todas las siglas</span>
                <span><Check size={14} /> Mantener términos técnicos importantes</span>
                <span><Check size={14} /> Omitir referencias</span>
              </div>
            </div>

            {error && <div className="document-error"><CircleAlert size={18} /><span>{error}</span></div>}

            <button className="primary-action document-process-button" disabled={!file} onClick={process}>
              <Sparkles size={18} /> Preparar documento completo
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
              ) : savedDocs.filter((doc) => doc.status === "complete").length ? (
                <div className="document-library-list">
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
            <div className="document-progress-label"><span>{progress}%</span><span>Puede tardar varios minutos porque no estamos resumiendo.</span></div>
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
            <button className="secondary-action" onClick={() => setStage("idle")}><RefreshCcw size={17} /> Volver a intentar</button>
          </div>
        )}

        {result && (
          <div className="document-result">
            <section className="document-overview">
              <div className="document-overview-main">
                <span className="mini-label">VERSIÓN EXPLICADA COMPLETA</span>
                <h3>{result.title}</h3>
                <p>{result.pageCount} páginas originales · {result.sections.length} capítulos explicados · ~{estimatedMinutes} min de audio</p>
              </div>
              <div className={`coverage-badge ${result.coverageScore >= 90 ? "good" : "review"}`}>
                <BookOpenCheck size={17} /><strong>{result.coverageScore}%</strong><span>cobertura verificada</span>
              </div>
              <button className="document-new" onClick={reset}>Nuevo PDF</button>
            </section>

            <section className="document-audio-master">
              <div>
                <span className="mini-label">ELEVENLABS · ESCUCHAR TODO</span>
                <h3>{audioSectionIndex !== null ? result.sections[audioSectionIndex]?.title : "Reproduce el documento como una clase"}</h3>
                <p>{audioSectionIndex !== null ? `Capítulo ${audioSectionIndex + 1} de ${result.sections.length} · tramo ${audioSegmentIndex + 1} de ${Math.max(1, audioSegmentCount)}` : `Aproximadamente ${estimatedMinutes} minutos. Puedes pausar y continuar por capítulos.`}</p>
              </div>
              <div className="document-audio-controls">
                <button className="audio-main-control" onClick={toggleAudio} disabled={audioLoading}>
                  {audioLoading ? <LoaderCircle size={18} className="spin" /> : audioPlaying && !audioPaused ? <Pause size={18} /> : <Play size={18} />}
                  {audioLoading ? "Generando…" : audioPlaying && !audioPaused ? "Pausar" : audioPaused ? "Continuar" : "Escuchar todo"}
                </button>
                <button className="audio-stop" onClick={stopAudio} disabled={!audioPlaying && !audioPaused}><Square size={15} /> Detener</button>
                <div className="audio-rates">
                  {rates.map((item) => <button key={item} className={rate === item ? "active" : ""} onClick={() => setRate(item)}>{item}x</button>)}
                </div>
              </div>
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
                <div><span className="mini-label">LECTURA EXPLICADA</span><h3>Todo el documento, capítulo por capítulo</h3></div>
                <span>{result.sections.length} secciones</span>
              </div>
              {result.sections.map((section, index) => {
                const isOpen = Boolean(expanded[section.id]);
                const isCurrentAudio = audioSectionIndex === index && (audioPlaying || audioPaused || audioLoading);
                return (
                  <article className={`document-section-card ${isCurrentAudio ? "playing" : ""}`} key={section.id}>
                    <button className="document-section-toggle" onClick={() => setExpanded((current) => ({ ...current, [section.id]: !isOpen }))}>
                      <span className="document-section-number">{index + 1}</span>
                      <div><strong>{section.title}</strong><span>Páginas {section.startPage}–{section.endPage} · cobertura {section.coverageScore}%{section.repaired ? " · revisada automáticamente" : ""}</span></div>
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
