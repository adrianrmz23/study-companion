import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  BookMarked,
  CircleAlert,
  Globe2,
  LoaderCircle,
  Search,
  Sparkles,
  X
} from "lucide-react";

export type ResearchSource = {
  id: string;
  title: string;
  url: string;
  provider: "Wikipedia" | "Crossref";
  kind: "encyclopedia" | "academic";
  snippet: string;
  meta?: string;
};

export type ResearchKeyPoint = {
  text: string;
  sourceIds: string[];
};

export type ResearchResult = {
  query: string;
  answer: string;
  keyPoints: ResearchKeyPoint[];
  studyBridge: string;
  limits?: string;
  sources: ResearchSource[];
};

type Props = {
  open: boolean;
  subject: string;
  topic: string;
  onClose: () => void;
  onUseInChat: (result: ResearchResult) => void;
};

function InlineText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("**") && part.endsWith("**")
          ? <strong key={index}>{part.slice(2, -2)}</strong>
          : part
      )}
    </>
  );
}

function ResearchText({ text }: { text: string }) {
  return (
    <div className="research-answer-text">
      {text.split("\n").map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return <div className="text-spacer" key={index} />;
        if (/^[-•]\s/.test(trimmed)) {
          return <div className="research-answer-bullet" key={index}><span>•</span><span><InlineText text={trimmed.replace(/^[-•]\s/, "")} /></span></div>;
        }
        return <p key={index}><InlineText text={line} /></p>;
      })}
    </div>
  );
}

export default function ResearchModal({ open, subject, topic, onClose, onUseInChat }: Props) {
  const [query, setQuery] = useState(topic);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ResearchResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery(topic || "");
    setError("");
    setResult(null);
  }, [open, topic]);

  const sourceMap = useMemo(() => {
    return new Map((result?.sources || []).map((source) => [source.id, source]));
  }, [result]);

  const runResearch = async (event?: FormEvent) => {
    event?.preventDefault();
    const cleanQuery = query.trim();
    if (!cleanQuery || loading) return;

    setLoading(true);
    setError("");
    setResult(null);

    try {
      const response = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: cleanQuery, subject, topic })
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "No pude investigar el tema.");
      setResult(data.research);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No pude investigar el tema.");
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="research-modal" role="dialog" aria-modal="true" aria-label="Investigación con fuentes externas">
        <header className="quiz-header research-modal-header">
          <div>
            <span className="mini-label">INVESTIGACIÓN EXTERNA</span>
            <h2>Amplía lo que estás estudiando</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Cerrar investigación"><X size={20} /></button>
        </header>

        <form className="research-search" onSubmit={runResearch}>
          <div className="research-search-field">
            <Search size={18} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Ej. ¿Cómo se usa la inferencia lógica en sistemas expertos?"
              autoFocus
            />
          </div>
          <button className="primary-action" type="submit" disabled={loading || !query.trim()}>
            {loading ? <LoaderCircle size={18} className="spin" /> : <Sparkles size={18} />}
            {loading ? "Investigando…" : "Investigar"}
          </button>
        </form>

        <div className="research-provider-strip">
          <span><Globe2 size={15} /> Wikipedia</span>
          <span><BookMarked size={15} /> Crossref académico</span>
          <small>Companion sintetiza únicamente lo que encuentra en estas fuentes.</small>
        </div>

        {!result && !loading && !error && (
          <div className="research-empty">
            <div className="research-empty-icon"><Globe2 size={28} /></div>
            <h3>No necesitas abandonar el chat para investigar</h3>
            <p>Busca una duda concreta. Companion combinará una fuente explicativa con literatura académica cuando haya resultados relevantes.</p>
            <div className="research-examples">
              <button type="button" onClick={() => setQuery(`${topic}: explicación y aplicaciones`)}>Explicación + aplicaciones</button>
              <button type="button" onClick={() => setQuery(`${topic}: ejemplos en inteligencia artificial`)}>Ejemplos en IA</button>
              <button type="button" onClick={() => setQuery(`${topic}: investigación académica`)}>Investigación académica</button>
            </div>
          </div>
        )}

        {loading && (
          <div className="research-loading">
            <LoaderCircle size={25} className="spin" />
            <strong>Buscando y comparando fuentes…</strong>
            <span>Primero recupero fuentes; después el tutor prepara una explicación apoyada en ellas.</span>
          </div>
        )}

        {error && !loading && (
          <div className="research-error">
            <CircleAlert size={23} />
            <div><strong>No pude completar la investigación</strong><span>{error}</span></div>
          </div>
        )}

        {result && !loading && (
          <div className="research-result">
            <section className="research-synthesis-card">
              <span className="mini-label">SÍNTESIS BASADA EN FUENTES</span>
              <h3>{result.query}</h3>
              <ResearchText text={result.answer} />
            </section>

            {!!result.keyPoints.length && (
              <section className="research-keypoints">
                <span className="mini-label">IDEAS CLAVE</span>
                <div className="research-keypoint-list">
                  {result.keyPoints.map((point, index) => (
                    <div className="research-keypoint" key={`${point.text}-${index}`}>
                      <span className="research-keypoint-number">{index + 1}</span>
                      <div>
                        <p>{point.text}</p>
                        <div className="research-citations">
                          {point.sourceIds.map((sourceId) => {
                            const source = sourceMap.get(sourceId);
                            if (!source) return null;
                            return <a key={sourceId} href={source.url} target="_blank" rel="noreferrer">{sourceId} · {source.provider}</a>;
                          })}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="research-study-bridge">
              <Sparkles size={19} />
              <div>
                <span className="mini-label">PARA TU ESTUDIO</span>
                <p>{result.studyBridge}</p>
              </div>
            </section>

            <section className="research-sources-section">
              <div className="research-section-heading">
                <div>
                  <span className="mini-label">FUENTES CONSULTADAS</span>
                  <h3>{result.sources.length} fuentes encontradas</h3>
                </div>
                {result.limits && <small>{result.limits}</small>}
              </div>

              <div className="research-source-list">
                {result.sources.map((source) => (
                  <a className="research-source" href={source.url} target="_blank" rel="noreferrer" key={source.id}>
                    <span className={`source-kind ${source.kind}`}>
                      {source.kind === "academic" ? <BookMarked size={15} /> : <Globe2 size={15} />}
                    </span>
                    <div>
                      <div className="source-title-row"><strong>{source.title}</strong><ArrowUpRight size={15} /></div>
                      <span className="source-meta">{source.id} · {source.provider}{source.meta ? ` · ${source.meta}` : ""}</span>
                      <p>{source.snippet}</p>
                    </div>
                  </a>
                ))}
              </div>
            </section>

            <footer className="research-footer">
              <span>Al llevarlo al chat, Companion conserva la síntesis y los nombres de las fuentes para continuar la conversación.</span>
              <button className="primary-action" onClick={() => onUseInChat(result)}><Sparkles size={17} /> Usar en el chat</button>
            </footer>
          </div>
        )}
      </section>
    </div>
  );
}
