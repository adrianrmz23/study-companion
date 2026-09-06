import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  BookOpen,
  ChevronDown,
  ChevronRight,
  FileAudio,
  Headphones,
  LoaderCircle,
  MessageCircle,
  RefreshCcw
} from "lucide-react";
import { supabase } from "./supabase";

type StudySessionLite = {
  id: string;
  title: string;
  subject: string;
  topic: string;
  updatedAt: string;
};

type DocumentRow = {
  id: string;
  title: string;
  subject: string;
  topic: string;
  sections: unknown[] | null;
  audio_progress: { completed?: boolean; documentSecond?: number } | null;
  updated_at: string;
};

type ProfileRow = {
  subject: string;
  topic: string;
  profile: { totalCorrect?: number; totalQuestions?: number } | null;
};

type TopicNode = {
  key: string;
  title: string;
  topic: string;
  unit: string;
  document?: DocumentRow;
  session?: StudySessionLite;
  mastery: number | null;
};

type Props = {
  userId?: string | null;
  sessions: StudySessionLite[];
  onOpenSession: (id: string) => void;
  onOpenAudio: (documentId: string) => void;
  onCreateDocument: () => void;
};

function normalize(value: string) {
  return value.trim().toLocaleLowerCase("es-MX").replace(/\s+/g, " ");
}

function unitFor(value: string) {
  const match = value.trim().match(/^(\d+)\.(\d+)(?:\.|\s|$)/);
  if (match) return `Unidad ${match[1]}`;
  const unitMatch = value.match(/\bunidad\s+(\d+)\b/i);
  return unitMatch ? `Unidad ${unitMatch[1]}` : "Otros temas";
}

function topicLabel(document: DocumentRow | undefined, session: StudySessionLite | undefined, fallback: string) {
  return document?.topic?.trim() || session?.topic?.trim() || document?.title?.trim() || session?.title?.trim() || fallback;
}

export default function SubjectsLibrary({ userId, sessions, onOpenSession, onOpenAudio, onCreateDocument }: Props) {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expandedSubjects, setExpandedSubjects] = useState<Record<string, boolean>>({});
  const [expandedUnits, setExpandedUnits] = useState<Record<string, boolean>>({});

  const load = async () => {
    if (!userId || !supabase) {
      setDocuments([]);
      setProfiles([]);
      return;
    }
    setLoading(true);
    setError("");
    const [{ data: docs, error: docsError }, { data: profileRows, error: profileError }] = await Promise.all([
      supabase.from("study_documents")
        .select("id,title,subject,topic,sections,audio_progress,updated_at")
        .eq("user_id", userId)
        .eq("status", "complete")
        .order("updated_at", { ascending: false })
        .limit(500),
      supabase.from("learning_profiles")
        .select("subject,topic,profile")
        .eq("user_id", userId)
        .limit(500)
    ]);
    setLoading(false);
    if (docsError || profileError) {
      setError(docsError?.message || profileError?.message || "No pude cargar tus materias.");
      return;
    }
    setDocuments((docs || []) as DocumentRow[]);
    setProfiles((profileRows || []) as ProfileRow[]);
  };

  useEffect(() => { void load(); }, [userId]);

  const hierarchy = useMemo(() => {
    const subjects = new Map<string, Map<string, Map<string, TopicNode>>>();
    const profileMap = new Map<string, number>();
    profiles.forEach((row) => {
      const total = Math.max(0, Number(row.profile?.totalQuestions) || 0);
      const correct = Math.max(0, Number(row.profile?.totalCorrect) || 0);
      profileMap.set(`${normalize(row.subject)}::${normalize(row.topic)}`, total ? Math.round((correct / total) * 100) : 0);
    });

    const ensure = (subject: string, unit: string) => {
      const subjectKey = subject || "Sin materia";
      if (!subjects.has(subjectKey)) subjects.set(subjectKey, new Map());
      const units = subjects.get(subjectKey)!;
      if (!units.has(unit)) units.set(unit, new Map());
      return units.get(unit)!;
    };

    documents.forEach((document) => {
      const subject = document.subject || "Sin materia";
      const rawTopic = document.topic || document.title;
      const unit = unitFor(rawTopic || document.title);
      const key = normalize(rawTopic || document.title);
      const bucket = ensure(subject, unit);
      const current = bucket.get(key);
      bucket.set(key, {
        key,
        title: topicLabel(document, current?.session, document.title),
        topic: rawTopic || document.title,
        unit,
        document,
        session: current?.session,
        mastery: profileMap.get(`${normalize(subject)}::${normalize(rawTopic || document.title)}`) ?? current?.mastery ?? null
      });
    });

    sessions.forEach((session) => {
      const subject = session.subject || "Sin materia";
      const rawTopic = session.topic || session.title;
      const unit = unitFor(rawTopic || session.title);
      const key = normalize(rawTopic || session.title);
      const bucket = ensure(subject, unit);
      const current = bucket.get(key);
      bucket.set(key, {
        key,
        title: topicLabel(current?.document, session, session.title),
        topic: rawTopic || session.title,
        unit,
        document: current?.document,
        session,
        mastery: profileMap.get(`${normalize(subject)}::${normalize(rawTopic || session.title)}`) ?? current?.mastery ?? null
      });
    });

    profiles.forEach((profile) => {
      const subject = profile.subject || "Sin materia";
      const rawTopic = profile.topic || "Tema sin nombre";
      const unit = unitFor(rawTopic);
      const key = normalize(rawTopic);
      const bucket = ensure(subject, unit);
      if (!bucket.has(key)) {
        bucket.set(key, {
          key,
          title: rawTopic,
          topic: rawTopic,
          unit,
          mastery: profileMap.get(`${normalize(subject)}::${normalize(rawTopic)}`) ?? null
        });
      }
    });

    return Array.from(subjects.entries())
      .sort(([a], [b]) => a.localeCompare(b, "es"))
      .map(([subject, units]) => ({
        subject,
        units: Array.from(units.entries())
          .sort(([a], [b]) => {
            if (a === "Otros temas") return 1;
            if (b === "Otros temas") return -1;
            return a.localeCompare(b, "es", { numeric: true });
          })
          .map(([unit, topics]) => ({
            unit,
            topics: Array.from(topics.values()).sort((a, b) => a.title.localeCompare(b.title, "es", { numeric: true }))
          }))
      }));
  }, [documents, profiles, sessions]);

  useEffect(() => {
    if (hierarchy.length && !Object.keys(expandedSubjects).length) {
      setExpandedSubjects({ [hierarchy[0].subject]: true });
    }
  }, [hierarchy]);

  return (
    <div className="subjects-page">
      <header className="subjects-page-header">
        <div>
          <span className="eyebrow">MI MAESTRÍA</span>
          <h1>Materias y temas</h1>
          <p>Una vista más ordenada de tus documentos, audios, sesiones y dominio por tema.</p>
        </div>
        <div>
          <button onClick={() => void load()} disabled={loading}><RefreshCcw size={16} className={loading ? "spin" : ""} /> Actualizar</button>
          <button className="primary" onClick={onCreateDocument}><FileAudio size={16} /> Nuevo documento</button>
        </div>
      </header>

      {error && <div className="subjects-error">{error}</div>}

      {!loading && !hierarchy.length ? (
        <section className="subjects-empty"><BookOpen size={27} /><strong>Todavía no hay materias para organizar.</strong><span>Crea sesiones, procesa documentos o completa quizzes y aparecerán aquí.</span></section>
      ) : (
        <div className="subjects-tree">
          {hierarchy.map((subjectNode) => {
            const subjectOpen = expandedSubjects[subjectNode.subject] ?? false;
            const topicCount = subjectNode.units.reduce((sum, unit) => sum + unit.topics.length, 0);
            return (
              <section key={subjectNode.subject} className="subject-group">
                <button className="subject-group-head" onClick={() => setExpandedSubjects((current) => ({ ...current, [subjectNode.subject]: !subjectOpen }))}>
                  <div className="subject-group-icon"><BookOpen size={20} /></div>
                  <div><strong>{subjectNode.subject}</strong><span>{subjectNode.units.length} bloque{subjectNode.units.length === 1 ? "" : "s"} · {topicCount} tema{topicCount === 1 ? "" : "s"}</span></div>
                  {subjectOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                </button>
                {subjectOpen && (
                  <div className="subject-units">
                    {subjectNode.units.map((unitNode) => {
                      const unitKey = `${subjectNode.subject}::${unitNode.unit}`;
                      const unitOpen = expandedUnits[unitKey] ?? true;
                      return (
                        <div key={unitKey} className="subject-unit">
                          <button className="subject-unit-head" onClick={() => setExpandedUnits((current) => ({ ...current, [unitKey]: !unitOpen }))}>
                            <span>{unitNode.unit}</span><small>{unitNode.topics.length} tema{unitNode.topics.length === 1 ? "" : "s"}</small>{unitOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                          </button>
                          {unitOpen && (
                            <div className="subject-topic-grid">
                              {unitNode.topics.map((node) => (
                                <article key={node.key} className="subject-topic-card">
                                  <div className="subject-topic-copy">
                                    <span>{unitNode.unit}</span>
                                    <h3>{node.title}</h3>
                                    <div className="subject-topic-badges">
                                      {node.document && <small><Headphones size={12} /> Audio</small>}
                                      {node.session && <small><MessageCircle size={12} /> Sesión</small>}
                                      {node.mastery !== null && <small><BarChart3 size={12} /> {node.mastery}%</small>}
                                    </div>
                                  </div>
                                  <div className="subject-topic-actions">
                                    {node.document && <button className="audio" onClick={() => onOpenAudio(node.document!.id)}><Headphones size={14} /> Escuchar</button>}
                                    {node.session && <button onClick={() => onOpenSession(node.session!.id)}><MessageCircle size={14} /> Abrir sesión</button>}
                                  </div>
                                </article>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
      {loading && <div className="subjects-loading"><LoaderCircle size={18} className="spin" /> Organizando tus materias…</div>}
    </div>
  );
}
