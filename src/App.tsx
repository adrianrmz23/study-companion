import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import {
  BarChart3,
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  CircleAlert,
  CircleHelp,
  Clock3,
  Cloud,
  CloudOff,
  FileAudio,
  Headphones,
  Lightbulb,
  LogIn,
  LogOut,
  LoaderCircle,
  MessageCircle,
  Plus,
  Route,
  RefreshCcw,
  Send,
  Sparkles,
  Trophy,
  Trash2,
  WandSparkles,
  X,
  XCircle
} from "lucide-react";
import ResearchModal, { ResearchResult, ResearchSource } from "./ResearchModal";
import AudioModal from "./AudioModal";
import AdaptiveModal from "./AdaptiveModal";
import SpeakButton from "./SpeakButton";
import AuthModal from "./AuthModal";
import DocumentExplainerModal from "./DocumentExplainerModal";
import AudioLibrary from "./AudioLibrary";
import { supabase, supabaseConfigured } from "./supabase";

type Mode = "Explicar" | "Sintetizar" | "Ejemplo" | "Otra forma";
type Role = "user" | "assistant";

type Message = {
  id: string;
  role: Role;
  content: string;
  mode?: Mode;
  streaming?: boolean;
  researched?: boolean;
  sources?: ResearchSource[];
};

type Health = {
  ok: boolean;
  provider: string;
  configured: boolean;
  model: string;
};

type QuizQuestion = {
  question: string;
  options: string[];
  answerIndex: number;
  explanation: string;
  concept: string;
};

type Quiz = {
  title: string;
  questions: QuizQuestion[];
};

type ConceptStat = {
  correct: number;
  total: number;
};

type LearningProfile = {
  quizzesCompleted: number;
  totalCorrect: number;
  totalQuestions: number;
  difficultySignals: number;
  concepts: Record<string, ConceptStat>;
  lastQuizAt?: string;
  updatedAt?: string;
};

type StudySession = {
  id: string;
  title: string;
  subject: string;
  topic: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
};

const SESSION_STORAGE_KEY = "companion-sessions:v1";
const ACTIVE_SESSION_KEY = "companion-active-session:v1";

const modeCopy: Record<Mode, { label: string; placeholder: string }> = {
  Explicar: {
    label: "Explícame fácil",
    placeholder: "Ej. No entiendo por qué esto se considera una inferencia válida..."
  },
  Sintetizar: {
    label: "Sintetiza",
    placeholder: "Ej. Acabo de ver modus ponens y modus tollens. ¿Con qué me debo quedar?"
  },
  Ejemplo: {
    label: "Dame un ejemplo",
    placeholder: "Ej. Dame un ejemplo cotidiano y otro relacionado con programación..."
  },
  "Otra forma": {
    label: "No lo entendí",
    placeholder: "Dime qué parte siguió sin quedarte clara y probaré otra estrategia..."
  }
};

const initialMessage: Message = {
  id: "welcome",
  role: "assistant",
  content:
    "Hola. Dime qué estás estudiando y qué parte no te queda clara. Puedo explicarlo fácil, sintetizarlo, darte ejemplos o probar otra forma de enseñarlo."
};

const emptyProfile: LearningProfile = {
  quizzesCompleted: 0,
  totalCorrect: 0,
  totalQuestions: 0,
  difficultySignals: 0,
  concepts: {}
};

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeSessionId() {
  return crypto.randomUUID();
}

function sessionMessages(messages: Message[]) {
  return messages
    .filter((item) => !item.streaming && item.content.trim())
    .slice(-80)
    .map((item) => ({ ...item, content: item.content.slice(0, 24000) }));
}

function createFreshSession(subjectSeed = "Inteligencia Artificial", topicSeed = ""): StudySession {
  const now = new Date().toISOString();
  return {
    id: makeSessionId(),
    title: topicSeed.trim() || "Nueva sesión",
    subject: subjectSeed || "Inteligencia Artificial",
    topic: topicSeed,
    messages: [{ ...initialMessage }],
    createdAt: now,
    updatedAt: now
  };
}

function parseStoredSessions(): StudySession[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStoredSessions(sessions: StudySession[]) {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions.slice(0, 30)));
  } catch {
    // La aplicación puede seguir sin almacenamiento local.
  }
}

function normalizeKey(value: string) {
  return value.trim().toLocaleLowerCase("es-MX").replace(/\s+/g, " ");
}

function profileKey(subject: string, topic: string) {
  return `companion-profile:${normalizeKey(subject)}::${normalizeKey(topic)}`;
}

function profileTimestamp(profile: LearningProfile | null | undefined) {
  const value = profile?.updatedAt ? Date.parse(profile.updatedAt) : 0;
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function MarkdownLite({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="markdown-lite">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return <div className="text-spacer" key={i} />;
        if (/^#{1,3}\s/.test(trimmed)) {
          return <strong className="md-heading" key={i}>{trimmed.replace(/^#{1,3}\s/, "")}</strong>;
        }
        if (/^[-•]\s/.test(trimmed)) {
          return <div className="md-bullet" key={i}><span>•</span><span>{renderInline(trimmed.replace(/^[-•]\s/, ""))}</span></div>;
        }
        if (/^\d+[.)]\s/.test(trimmed)) {
          const match = trimmed.match(/^(\d+)[.)]\s(.*)$/);
          return <div className="md-bullet numbered" key={i}><span>{match?.[1]}.</span><span>{renderInline(match?.[2] || trimmed)}</span></div>;
        }
        return <p key={i}>{renderInline(line)}</p>;
      })}
    </div>
  );
}

function renderInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part
  );
}

export default function App() {
  const [subject, setSubject] = useState("Inteligencia Artificial");
  const [topic, setTopic] = useState("Inferencia lógica");
  const [mode, setMode] = useState<Mode>("Explicar");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([initialMessage]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [quizOpen, setQuizOpen] = useState(false);
  const [quizLoading, setQuizLoading] = useState(false);
  const [quizError, setQuizError] = useState("");
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [quizIndex, setQuizIndex] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [quizAnswers, setQuizAnswers] = useState<number[]>([]);
  const [quizFinished, setQuizFinished] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);
  const [audioFocusText, setAudioFocusText] = useState("");
  const [adaptiveOpen, setAdaptiveOpen] = useState(false);
  const [documentOpen, setDocumentOpen] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<"study" | "audio">("study");
  const [profile, setProfile] = useState<LearningProfile>(emptyProfile);
  const [user, setUser] = useState<User | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [syncStatus, setSyncStatus] = useState<"local" | "syncing" | "synced" | "error">("local");
  const [syncMessage, setSyncMessage] = useState("");
  const [sessions, setSessions] = useState<StudySession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [sessionsReady, setSessionsReady] = useState(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const sessionHydratingRef = useRef(false);
  const sessionSaveTimerRef = useRef<number | null>(null);

  const contextLabel = useMemo(() => {
    const parts = [subject.trim(), topic.trim()].filter(Boolean);
    return parts.join(" · ") || "Sin contexto";
  }, [subject, topic]);

  const mastery = useMemo(() => {
    if (!profile.totalQuestions) return null;
    const quizAccuracy = profile.totalCorrect / profile.totalQuestions;
    const difficultyPenalty = Math.min(profile.difficultySignals * 0.025, 0.15);
    return Math.round(clamp((quizAccuracy - difficultyPenalty) * 100, 0, 100));
  }, [profile]);

  const conceptRows = useMemo(() => {
    return Object.entries(profile.concepts)
      .map(([name, stat]) => ({
        name,
        correct: stat.correct,
        total: stat.total,
        score: stat.total ? Math.round((stat.correct / stat.total) * 100) : 0
      }))
      .sort((a, b) => a.score - b.score || b.total - a.total);
  }, [profile.concepts]);

  const learningSnapshot = useMemo(() => ({
    mastery,
    quizzesCompleted: profile.quizzesCompleted,
    difficultySignals: profile.difficultySignals,
    concepts: conceptRows.map(({ name, score, total }) => ({ name, score, total }))
  }), [mastery, profile.quizzesCompleted, profile.difficultySignals, conceptRows]);

  const weakestConcept = conceptRows[0] || null;
  const adaptiveHint = useMemo(() => {
    if (!profile.totalQuestions) {
      return { title: "Primero necesito conocerte", text: "Haz un quiz corto para que pueda detectar qué conviene reforzar.", tone: "diagnose" };
    }
    if (weakestConcept && weakestConcept.score < 60) {
      return { title: `Reforzar ${weakestConcept.name}`, text: `Es el concepto con menor dominio (${weakestConcept.score}%). Te conviene trabajarlo antes de avanzar.`, tone: "reinforce" };
    }
    if ((mastery ?? 0) >= 85 && (!weakestConcept || weakestConcept.score >= 75)) {
      return { title: "Puedes profundizar", text: "Tus resultados son sólidos. El siguiente paso puede ser aplicación, conexiones o mayor dificultad.", tone: "advance" };
    }
    return { title: `Consolidar ${topic || "el tema"}`, text: "Vas bien, pero todavía conviene una micro-sesión de práctica antes de darlo por dominado.", tone: "consolidate" };
  }, [profile.totalQuestions, weakestConcept, mastery, topic]);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true);
      return;
    }

    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setUser(data.session?.user ?? null);
      setAuthReady(true);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setUser(session?.user ?? null);
      setAuthReady(true);
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const hydrateSession = (session: StudySession) => {
    sessionHydratingRef.current = true;
    setActiveSessionId(session.id);
    setSubject(session.subject || "Inteligencia Artificial");
    setTopic(session.topic || "");
    setMessages(session.messages?.length ? session.messages : [{ ...initialMessage, id: makeId() }]);
    setInput("");
    setError("");
    try { localStorage.setItem(ACTIVE_SESSION_KEY, session.id); } catch {}
    window.setTimeout(() => { sessionHydratingRef.current = false; }, 0);
  };

  const sessionToCloudRow = (session: StudySession, userId: string) => ({
    id: session.id,
    user_id: userId,
    title: session.title,
    subject: session.subject,
    topic: session.topic,
    messages: sessionMessages(session.messages),
    created_at: session.createdAt,
    updated_at: session.updatedAt
  });

  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;

    const loadSessions = async () => {
      setSessionsReady(false);
      let localSessions = parseStoredSessions();
      let available = localSessions;

      if (user && supabase) {
        const { data, error: sessionError } = await supabase
          .from("study_sessions")
          .select("id,title,subject,topic,messages,created_at,updated_at")
          .eq("user_id", user.id)
          .order("updated_at", { ascending: false })
          .limit(30);

        if (!sessionError && Array.isArray(data)) {
          const cloudSessions: StudySession[] = data.map((row: any) => ({
            id: String(row.id),
            title: String(row.title || row.topic || "Nueva sesión"),
            subject: String(row.subject || "Inteligencia Artificial"),
            topic: String(row.topic || ""),
            messages: Array.isArray(row.messages) && row.messages.length ? row.messages as Message[] : [{ ...initialMessage }],
            createdAt: String(row.created_at || new Date().toISOString()),
            updatedAt: String(row.updated_at || new Date().toISOString())
          }));

          if (cloudSessions.length) {
            available = cloudSessions;
          } else if (localSessions.length) {
            await supabase.from("study_sessions").upsert(localSessions.map((session) => sessionToCloudRow(session, user.id)), { onConflict: "id" });
            available = localSessions;
          }
        } else if (sessionError) {
          console.warn("No pude cargar study_sessions; usaré las sesiones locales:", sessionError.message);
        }
      }

      if (!available.length) {
        const fresh = createFreshSession(subject || "Inteligencia Artificial", topic);
        available = [fresh];
        if (user && supabase) {
          await supabase.from("study_sessions").upsert(sessionToCloudRow(fresh, user.id), { onConflict: "id" });
        }
      }

      if (cancelled) return;
      available = [...available].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      setSessions(available);
      writeStoredSessions(available);
      const preferred = (() => { try { return localStorage.getItem(ACTIVE_SESSION_KEY); } catch { return null; } })();
      const selected = available.find((session) => session.id === preferred) || available[0];
      setSessionsReady(true);
      hydrateSession(selected);
    };

    void loadSessions();
    return () => { cancelled = true; };
  }, [authReady, user?.id]);

  useEffect(() => {
    if (!sessionsReady || !activeSessionId || sessionHydratingRef.current) return;
    const now = new Date().toISOString();
    const cleanMessages = sessionMessages(messages);
    const nextTitle = topic.trim() || "Nueva sesión";

    const currentSession = sessions.find((session) => session.id === activeSessionId);
    if (!currentSession) return;
    const snapshot: StudySession = {
      ...currentSession,
      title: nextTitle,
      subject,
      topic,
      messages: cleanMessages.length ? cleanMessages : [{ ...initialMessage }],
      updatedAt: now
    };
    setSessions((current) => {
      const next = current.map((session) => session.id === activeSessionId ? snapshot : session);
      const sorted = [...next].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      writeStoredSessions(sorted);
      return sorted;
    });

    if (sessionSaveTimerRef.current) window.clearTimeout(sessionSaveTimerRef.current);
    if (user && supabase) {
      const supabaseClient = supabase;
      const userId = user.id;
      sessionSaveTimerRef.current = window.setTimeout(() => {
        void supabaseClient.from("study_sessions")
          .upsert(sessionToCloudRow(snapshot, userId), { onConflict: "id" })
          .then(({ error: sessionError }) => {
            if (sessionError) console.warn("No pude guardar la sesión:", sessionError.message);
          });
      }, 700);
    }

    return () => {
      if (sessionSaveTimerRef.current) window.clearTimeout(sessionSaveTimerRef.current);
    };
  }, [subject, topic, messages, activeSessionId, sessionsReady, user?.id]);

  useEffect(() => {
    let cancelled = false;

    const loadProfile = async () => {
      let localProfile: LearningProfile = emptyProfile;
      try {
        const saved = localStorage.getItem(profileKey(subject, topic));
        localProfile = saved ? { ...emptyProfile, ...JSON.parse(saved) } : emptyProfile;
      } catch {
        localProfile = emptyProfile;
      }

      if (!user || !supabase) {
        if (!cancelled) {
          setProfile(localProfile);
          setSyncStatus("local");
          setSyncMessage("");
        }
        return;
      }

      if (!cancelled) {
        setSyncStatus("syncing");
        setSyncMessage("Sincronizando progreso…");
      }

      const subjectKey = normalizeKey(subject);
      const topicKey = normalizeKey(topic);
      const { data, error: fetchError } = await supabase
        .from("learning_profiles")
        .select("profile, updated_at")
        .eq("user_id", user.id)
        .eq("subject_key", subjectKey)
        .eq("topic_key", topicKey)
        .maybeSingle();

      if (cancelled) return;
      if (fetchError) {
        setProfile(localProfile);
        setSyncStatus("error");
        setSyncMessage("No pude leer el progreso de Supabase. Se conserva la copia local.");
        return;
      }

      const cloudProfile = data?.profile
        ? { ...emptyProfile, ...(data.profile as LearningProfile), updatedAt: (data.profile as LearningProfile).updatedAt || data.updated_at }
        : null;
      const localIsNewer = profileTimestamp(localProfile) > profileTimestamp(cloudProfile);
      const chosen = cloudProfile && !localIsNewer ? cloudProfile : localProfile;

      setProfile(chosen);
      try {
        localStorage.setItem(profileKey(subject, topic), JSON.stringify(chosen));
      } catch {
        // La nube sigue siendo la fuente principal cuando hay sesión iniciada.
      }

      if (!cloudProfile || localIsNewer) {
        const now = chosen.updatedAt || new Date().toISOString();
        const normalized = { ...chosen, updatedAt: now };
        const { error: upsertError } = await supabase.from("learning_profiles").upsert({
          user_id: user.id,
          subject,
          topic,
          subject_key: subjectKey,
          topic_key: topicKey,
          profile: normalized,
          updated_at: now
        }, { onConflict: "user_id,subject_key,topic_key" });
        if (cancelled) return;
        if (upsertError) {
          setSyncStatus("error");
          setSyncMessage("El progreso quedó local, pero no pude subirlo a Supabase.");
          return;
        }
        setProfile(normalized);
        try { localStorage.setItem(profileKey(subject, topic), JSON.stringify(normalized)); } catch {}
      }

      setSyncStatus("synced");
      setSyncMessage("Progreso sincronizado");
    };

    void loadProfile();
    return () => { cancelled = true; };
  }, [subject, topic, user?.id]);

  const persistProfile = (next: LearningProfile) => {
    const normalized = { ...next, updatedAt: new Date().toISOString() };
    setProfile(normalized);
    try {
      localStorage.setItem(profileKey(subject, topic), JSON.stringify(normalized));
    } catch {
      // El chat debe seguir funcionando aunque el navegador bloquee storage.
    }

    if (!user || !supabase) {
      setSyncStatus("local");
      return;
    }

    setSyncStatus("syncing");
    setSyncMessage("Guardando en la nube…");
    void supabase.from("learning_profiles").upsert({
      user_id: user.id,
      subject,
      topic,
      subject_key: normalizeKey(subject),
      topic_key: normalizeKey(topic),
      profile: normalized,
      updated_at: normalized.updatedAt
    }, { onConflict: "user_id,subject_key,topic_key" }).then(({ error: upsertError }) => {
      if (upsertError) {
        console.error("No fue posible sincronizar el perfil:", upsertError.message);
        setSyncStatus("error");
        setSyncMessage("No pude sincronizar. Tu copia local sigue guardada.");
        return;
      }
      setSyncStatus("synced");
      setSyncMessage("Progreso sincronizado");
    });
  };

  const signOut = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    setSyncStatus("local");
    setSyncMessage("");
  };

  const appendStreamText = (assistantId: string, addition: string) => {
    setMessages((current) =>
      current.map((item) =>
        item.id === assistantId
          ? { ...item, content: item.content + addition }
          : item
      )
    );
  };

  const sendMessage = async (e?: FormEvent) => {
    e?.preventDefault();
    const value = input.trim();
    if (!value || sending) return;

    setError("");
    setSending(true);

    const historyForApi = messages
      .filter((item) => item.id !== "welcome" && !item.streaming && item.content.trim())
      .map((item) => ({ role: item.role, content: item.content }));

    const userMessage: Message = {
      id: makeId(),
      role: "user",
      content: value,
      mode
    };

    const assistantId = makeId();
    const assistantMessage: Message = {
      id: assistantId,
      role: "assistant",
      content: "",
      mode,
      streaming: true
    };

    setMessages((current) => [...current, userMessage, assistantMessage]);
    setInput("");

    if (mode === "Otra forma") {
      persistProfile({ ...profile, difficultySignals: profile.difficultySignals + 1 });
    }

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: value,
          subject,
          topic,
          mode,
          history: historyForApi,
          learningProfile: learningSnapshot
        })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.error || `Error ${response.status}`);
      }

      if (!response.body) throw new Error("El servidor no devolvió una respuesta en streaming.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;

        buffer += decoder.decode(chunk, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const event of events) {
          const dataLines = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim());

          for (const dataLine of dataLines) {
            if (!dataLine || dataLine === "[DONE]") continue;
            try {
              const payload = JSON.parse(dataLine);
              if (payload?.error?.message) throw new Error(payload.error.message);
              const delta = payload?.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta) appendStreamText(assistantId, delta);
            } catch (parseError) {
              if (parseError instanceof Error && parseError.message !== "Unexpected end of JSON input") {
                if (dataLine.startsWith("{")) throw parseError;
              }
            }
          }
        }
      }

      setMessages((current) =>
        current.map((item) =>
          item.id === assistantId
            ? { ...item, streaming: false, content: item.content || "No recibí texto del modelo. Intenta nuevamente." }
            : item
        )
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Ocurrió un error inesperado.";
      setError(message);
      setMessages((current) => current.filter((item) => item.id !== assistantId));
    } finally {
      setSending(false);
    }
  };

  const resetQuizState = () => {
    setQuiz(null);
    setQuizIndex(0);
    setSelectedAnswer(null);
    setQuizAnswers([]);
    setQuizFinished(false);
    setQuizError("");
  };

  const openQuiz = () => {
    resetQuizState();
    setQuizOpen(true);
  };

  const createQuiz = async () => {
    if (quizLoading) return;
    setQuizLoading(true);
    setQuizError("");

    const historyForQuiz = messages
      .filter((item) => item.id !== "welcome" && item.content.trim())
      .slice(-8)
      .map((item) => ({ role: item.role, content: item.content }));

    try {
      const response = await fetch("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, topic, history: historyForQuiz, learningProfile: learningSnapshot })
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "No pude generar el quiz.");
      setQuiz(data.quiz);
    } catch (err) {
      setQuizError(err instanceof Error ? err.message : "No pude generar el quiz.");
    } finally {
      setQuizLoading(false);
    }
  };

  const chooseAnswer = (answerIndex: number) => {
    if (!quiz || selectedAnswer !== null) return;
    setSelectedAnswer(answerIndex);
    setQuizAnswers((current) => [...current, answerIndex]);
  };

  const finishQuiz = () => {
    if (!quiz) return;

    const answers = quizAnswers;
    let correctCount = 0;
    const concepts = { ...profile.concepts };

    quiz.questions.forEach((question, index) => {
      const isCorrect = answers[index] === question.answerIndex;
      if (isCorrect) correctCount += 1;
      const conceptName = question.concept.trim() || topic.trim() || "Tema actual";
      const previous = concepts[conceptName] || { correct: 0, total: 0 };
      concepts[conceptName] = {
        correct: previous.correct + (isCorrect ? 1 : 0),
        total: previous.total + 1
      };
    });

    persistProfile({
      ...profile,
      quizzesCompleted: profile.quizzesCompleted + 1,
      totalCorrect: profile.totalCorrect + correctCount,
      totalQuestions: profile.totalQuestions + quiz.questions.length,
      concepts,
      lastQuizAt: new Date().toISOString()
    });
    setQuizFinished(true);
  };

  const nextQuizQuestion = () => {
    if (!quiz || selectedAnswer === null) return;
    if (quizIndex >= quiz.questions.length - 1) {
      finishQuiz();
      return;
    }
    setQuizIndex((current) => current + 1);
    setSelectedAnswer(null);
  };

  const restartQuiz = () => {
    resetQuizState();
    void createQuiz();
  };

  const newSession = () => {
    if (sending) return;
    setWorkspaceView("study");
    const fresh = createFreshSession(subject || "Inteligencia Artificial");
    const next = [fresh, ...sessions];
    setSessions(next);
    writeStoredSessions(next);
    hydrateSession(fresh);
    if (user && supabase) {
      void supabase.from("study_sessions")
        .upsert(sessionToCloudRow(fresh, user.id), { onConflict: "id" });
    }
  };

  const openStudySession = (session: StudySession) => {
    if (sending || session.id === activeSessionId) {
      setWorkspaceView("study");
      return;
    }
    setWorkspaceView("study");
    hydrateSession(session);
    setHistoryOpen(false);
  };

  const deleteStudySession = async (session: StudySession) => {
    if (sending) return;
    const confirmed = window.confirm(`¿Eliminar la sesión “${session.title}”? Esta acción quitará también su conversación guardada.`);
    if (!confirmed) return;

    let remaining = sessions.filter((item) => item.id !== session.id);
    if (!remaining.length) remaining = [createFreshSession(subject || "Inteligencia Artificial")];
    setSessions(remaining);
    writeStoredSessions(remaining);

    if (session.id === activeSessionId) hydrateSession(remaining[0]);

    if (user && supabase) {
      const { error: deleteError } = await supabase.from("study_sessions").delete().eq("id", session.id).eq("user_id", user.id);
      if (deleteError) console.warn("No pude eliminar la sesión de Supabase:", deleteError.message);
      const replacement = remaining.find((item) => item.id !== session.id && item.createdAt === item.updatedAt && item.title === "Nueva sesión");
      if (replacement) await supabase.from("study_sessions").upsert(sessionToCloudRow(replacement, user.id), { onConflict: "id" });
    }
  };

  const useResearchInChat = (result: ResearchResult) => {
    const sourceLine = result.sources
      .map((source) => `${source.id}: ${source.title} (${source.provider})`)
      .join("\n");
    const keyPoints = result.keyPoints
      .map((point) => `- ${point.text}${point.sourceIds.length ? ` [${point.sourceIds.join(", ")}]` : ""}`)
      .join("\n");

    const content = [
      `**Investigación externa: ${result.query}**`,
      "",
      result.answer,
      keyPoints ? `\n**Ideas clave**\n${keyPoints}` : "",
      result.studyBridge ? `\n**Para tu estudio**\n${result.studyBridge}` : "",
      sourceLine ? `\n**Fuentes consultadas**\n${sourceLine}` : ""
    ].filter(Boolean).join("\n");

    setMessages((current) => [
      ...current,
      {
        id: makeId(),
        role: "assistant",
        content,
        researched: true,
        sources: result.sources
      }
    ]);
    setResearchOpen(false);
  };

  const openSessionAudio = () => {
    setAudioFocusText("");
    setAudioOpen(true);
  };

  const openMessageAudio = (content: string) => {
    setAudioFocusText(content);
    setAudioOpen(true);
  };

  const useAdaptivePrompt = (prompt: string) => {
    setAdaptiveOpen(false);
    setMode("Explicar");
    setInput(prompt);
    window.setTimeout(() => {
      document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
    }, 50);
  };

  const useDocumentInChat = (sectionTitle: string, explainedText: string) => {
    setDocumentOpen(false);
    setMode("Explicar");
    setMessages((current) => [
      ...current,
      {
        id: makeId(),
        role: "assistant",
        content: `**Documento explicado · ${sectionTitle}**\n\n${explainedText}`
      }
    ]);
    setInput(`Ayúdame a profundizar en la sección “${sectionTitle}”. `);
    window.setTimeout(() => {
      document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
    }, 60);
  };

  const currentQuestion = quiz?.questions[quizIndex];
  const currentCorrect = currentQuestion && selectedAnswer !== null
    ? selectedAnswer === currentQuestion.answerIndex
    : false;
  const finalCorrect = quiz
    ? quiz.questions.reduce((count, question, index) => count + (quizAnswers[index] === question.answerIndex ? 1 : 0), 0)
    : 0;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${historyOpen ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-icon"><Brain size={22} /></div>
          <div>
            <strong>Companion</strong>
            <span>Tu tutor de estudio</span>
          </div>
          <button className="mobile-close" onClick={() => setHistoryOpen(false)} aria-label="Cerrar historial">
            <X size={20} />
          </button>
        </div>

        <button className="new-session" onClick={newSession}>
          <Plus size={18} />
          Nueva sesión
        </button>

        <nav className="sidebar-workspaces" aria-label="Áreas de Companion">
          <button className={workspaceView === "study" ? "active" : ""} onClick={() => setWorkspaceView("study")}>
            <MessageCircle size={17} /> <span>Tutor</span>
          </button>
          <button className={workspaceView === "audio" ? "active audio" : "audio"} onClick={() => setWorkspaceView("audio")}>
            <Headphones size={17} /> <span>Audios</span>
            <small>Biblioteca</small>
          </button>
        </nav>

        <div className="side-title">Sesiones recientes</div>
        <div className="history-list">
          {!sessionsReady ? (
            <div className="history-loading"><LoaderCircle size={15} className="spin" /> Cargando sesiones…</div>
          ) : sessions.slice(0, 12).map((item) => (
            <div className={`history-item-row ${item.id === activeSessionId ? "active" : ""}`} key={item.id}>
              <button className="history-item" onClick={() => openStudySession(item)}>
                <MessageCircle size={17} />
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.subject || "Sin materia"} · {item.id === activeSessionId ? "sesión actual" : new Date(item.updatedAt).toLocaleDateString("es-MX", { day: "2-digit", month: "short" })}</span>
                </div>
              </button>
              <button className="history-delete" onClick={() => void deleteStudySession(item)} aria-label={`Eliminar ${item.title}`} title="Eliminar sesión">
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>

        <button className="mastery-card" onClick={() => setProfileOpen(true)}>
          <div className="mastery-card-top">
            <span><BarChart3 size={16} /> Tu aprendizaje</span>
            <strong>{mastery === null ? "—" : `${mastery}%`}</strong>
          </div>
          <div className="mastery-track"><span style={{ width: `${mastery ?? 0}%` }} /></div>
          <small>{profile.quizzesCompleted ? `${profile.quizzesCompleted} quiz completado${profile.quizzesCompleted === 1 ? "" : "s"}` : "Haz un quiz para medir tu dominio"}</small>
        </button>

        <div className={`sync-card ${user ? "signed-in" : "signed-out"}`}>
          <div className="sync-card-top">
            <span className={`sync-dot ${syncStatus}`} />
            <div>
              <strong>{user ? "Progreso en la nube" : "Progreso local"}</strong>
              <span>{user?.email || (supabaseConfigured ? "Inicia sesión para sincronizar" : "Supabase pendiente")}</span>
            </div>
          </div>
          {user ? (
            <>
              <small>{syncStatus === "syncing" ? "Sincronizando…" : syncStatus === "error" ? syncMessage : "Disponible en tus otros dispositivos"}</small>
              <button className="sync-action secondary" onClick={() => void signOut()}><LogOut size={15} /> Cerrar sesión</button>
            </>
          ) : (
            <button className="sync-action" onClick={() => setAuthOpen(true)} disabled={!authReady}>
              {supabaseConfigured ? <Cloud size={15} /> : <CloudOff size={15} />}
              {supabaseConfigured ? "Sincronizar progreso" : "Configurar Supabase"}
            </button>
          )}
        </div>

        <div className="provider-card">
          <div className="provider-line">
            <span className={`provider-dot ${health?.configured ? "online" : "offline"}`} />
            <strong>Cheaper Inference</strong>
          </div>
          <span className="provider-model">{health?.model || "Comprobando conexión..."}</span>
          {!health?.configured && health && <span className="provider-warning">Falta configurar la API key</span>}
        </div>

        <div className="sidebar-card">
          <Sparkles size={19} />
          <strong>Consejo</strong>
          <p>No intentes formular la pregunta perfecta. Escríbeme exactamente qué parte te confundió.</p>
        </div>
      </aside>

      <main className={`main ${workspaceView === "audio" ? "audio-main" : ""}`}>
        {workspaceView === "audio" ? (
          <AudioLibrary
            userId={user?.id || null}
            onRequireAuth={() => setAuthOpen(true)}
            onCreateAudio={() => {
              setWorkspaceView("study");
              setDocumentOpen(true);
            }}
          />
        ) : (
          <>
        <header className="topbar">
          <button className="history-toggle" onClick={() => setHistoryOpen(true)}>
            <Clock3 size={19} />
          </button>

          <div>
            <div className="eyebrow">SESIÓN DE ESTUDIO</div>
            <h1>{topic || "Nuevo tema"}</h1>
          </div>

          <div className={`status ${health?.configured ? "connected" : "pending"}`}>
            <span className="status-dot" />
            {health?.configured ? "Tutor conectado" : "Configurar IA"}
          </div>
        </header>

        <section className="context-card">
          <div className="context-heading">
            <div>
              <span className="mini-label">Contexto actual</span>
              <strong>{contextLabel}</strong>
            </div>
            <div className="context-icon"><BookOpen size={20} /></div>
          </div>

          <div className="context-grid">
            <label>
              <span>Materia</span>
              <div className="input-wrap">
                <input value={subject} onChange={(e) => setSubject(e.target.value)} />
                <ChevronDown size={17} />
              </div>
            </label>
            <label>
              <span>Tema</span>
              <div className="input-wrap">
                <input value={topic} onChange={(e) => setTopic(e.target.value)} />
                <WandSparkles size={17} />
              </div>
            </label>
          </div>
        </section>

        <section className="quick-actions">
          <button onClick={() => setMode("Explicar")} className={mode === "Explicar" ? "selected" : ""}>
            <Sparkles size={18} /><span>Explícame fácil</span>
          </button>
          <button onClick={() => setMode("Sintetizar")} className={mode === "Sintetizar" ? "selected" : ""}>
            <BookOpen size={18} /><span>Sintetiza</span>
          </button>
          <button onClick={() => setMode("Ejemplo")} className={mode === "Ejemplo" ? "selected" : ""}>
            <Lightbulb size={18} /><span>Dame un ejemplo</span>
          </button>
          <button onClick={() => setMode("Otra forma")} className={mode === "Otra forma" ? "selected danger" : ""}>
            <CircleHelp size={18} /><span>No lo entendí</span>
          </button>
        </section>

        <div className="study-tools-grid">
          <section className="document-launch-card">
            <div className="tool-card-icon document"><FileAudio size={20} /></div>
            <div>
              <span className="mini-label">DOCUMENTO EXPLICADO</span>
              <strong>Aprende un PDF sin pelearte con el lenguaje técnico</strong>
              <p>Conserva los conceptos importantes, elimina redundancia y adapta la profundidad a Repaso, Aprender o Profundizar.</p>
            </div>
            <button onClick={() => setDocumentOpen(true)}><FileAudio size={17} /> Subir PDF</button>
          </section>

          <section className="research-launch-card">
            <div className="research-launch-icon">🌐</div>
            <div className="research-launch-copy">
              <span className="mini-label">AMPLÍA EL TEMA</span>
              <strong>Investiga con fuentes externas</strong>
              <p>Complementa el tema con una fuente explicativa y literatura académica.</p>
            </div>
            <button onClick={() => setResearchOpen(true)}>Investigar</button>
          </section>

          <section className="study-check-card">
            <div>
              <span className="mini-label">COMPRUEBA LO APRENDIDO</span>
              <strong>Quiz rápido · 3 preguntas</strong>
              <p>Ahora prioriza los conceptos que tus resultados indican que necesitan más práctica.</p>
            </div>
            <button onClick={openQuiz}><Trophy size={18} /> Iniciar quiz</button>
          </section>

          <section className="audio-launch-card">
            <div className="tool-card-icon audio"><Headphones size={19} /></div>
            <div>
              <span className="mini-label">REPASA SIN MIRAR LA PANTALLA</span>
              <strong>Repaso hablado · 3–5 min</strong>
              <p>Convierte esta sesión en un audio natural y prioriza lo que más te ha costado.</p>
            </div>
            <button onClick={openSessionAudio}><Headphones size={17} /> Preparar</button>
          </section>

          <section className={`adaptive-launch-card ${adaptiveHint.tone}`}>
            <div className="tool-card-icon adaptive"><Route size={19} /></div>
            <div>
              <span className="mini-label">TUTOR ADAPTATIVO</span>
              <strong>{adaptiveHint.title}</strong>
              <p>{adaptiveHint.text}</p>
            </div>
            <button onClick={() => setAdaptiveOpen(true)}><Route size={17} /> Ver plan</button>
          </section>
        </div>

        {error && (
          <div className="error-banner">
            <CircleAlert size={19} />
            <div><strong>No pude obtener la respuesta</strong><span>{error}</span></div>
          </div>
        )}

        <section className="chat">
          {messages.map((message) => (
            <div key={message.id} className={`message-row ${message.role}`}>
              {message.role === "assistant" && <div className="avatar"><Brain size={18} /></div>}
              <div className={`bubble ${message.role}`}>
                {message.role === "assistant" && message.mode && (
                  <span className="response-tag">{modeCopy[message.mode].label}</span>
                )}
                {message.role === "assistant" && message.researched && (
                  <span className="response-tag research-tag">Con fuentes externas</span>
                )}
                {message.content ? <MarkdownLite text={message.content} /> : (
                  <span className="thinking"><LoaderCircle size={16} className="spin" /> Pensando…</span>
                )}
                {!!message.sources?.length && (
                  <div className="message-sources">
                    {message.sources.slice(0, 6).map((source) => (
                      <a key={source.id} href={source.url} target="_blank" rel="noreferrer">
                        <span>{source.id}</span>{source.title}
                      </a>
                    ))}
                  </div>
                )}
                {message.role === "assistant" && message.id !== "welcome" && !message.streaming && message.content && (
                  <div className="message-audio-actions">
                    <SpeakButton text={message.content} />
                    <button type="button" onClick={() => openMessageAudio(message.content)}><Headphones size={15} /> Versión audio</button>
                  </div>
                )}
                {message.streaming && message.content && <span className="stream-cursor" />}
              </div>
            </div>
          ))}
          <div ref={chatEndRef} />
        </section>

        <form className="composer" onSubmit={sendMessage}>
          <div className="composer-top">
            <span className="mode-badge">{modeCopy[mode].label}</span>
            <span>El tutor conserva el contexto de esta conversación</span>
          </div>
          <div className="composer-row">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={modeCopy[mode].placeholder}
              rows={2}
              disabled={sending}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
            />
            <button className="send-button" type="submit" disabled={sending || !input.trim()} aria-label="Enviar">
              {sending ? <LoaderCircle size={20} className="spin" /> : <Send size={20} />}
            </button>
          </div>
          <div className="composer-hint">Enter para enviar · Shift + Enter para salto de línea</div>
        </form>
          </>
        )}
      </main>

      <DocumentExplainerModal
        open={documentOpen}
        userId={user?.id || null}
        subject={subject}
        topic={topic}
        onClose={() => setDocumentOpen(false)}
        onUseInChat={useDocumentInChat}
      />

      <ResearchModal
        open={researchOpen}
        subject={subject}
        topic={topic}
        onClose={() => setResearchOpen(false)}
        onUseInChat={useResearchInChat}
      />

      <AudioModal
        open={audioOpen}
        subject={subject}
        topic={topic}
        focusText={audioFocusText}
        learning={learningSnapshot}
        messages={messages.filter((item) => item.id !== "welcome" && item.content.trim()).map((item) => ({ role: item.role, content: item.content }))}
        onClose={() => setAudioOpen(false)}
      />

      <AdaptiveModal
        open={adaptiveOpen}
        subject={subject}
        topic={topic}
        learning={learningSnapshot}
        messages={messages.filter((item) => item.id !== "welcome" && item.content.trim()).map((item) => ({ role: item.role, content: item.content }))}
        onClose={() => setAdaptiveOpen(false)}
        onUsePrompt={useAdaptivePrompt}
      />

      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />

      {quizOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(e) => {
          if (e.target === e.currentTarget) setQuizOpen(false);
        }}>
          <section className="quiz-modal" role="dialog" aria-modal="true" aria-label="Quiz rápido">
            <header className="quiz-header">
              <div>
                <span className="mini-label">QUIZ RÁPIDO</span>
                <h2>{quiz?.title || topic || "Tema actual"}</h2>
              </div>
              <button className="modal-close" onClick={() => setQuizOpen(false)} aria-label="Cerrar quiz"><X size={20} /></button>
            </header>

            {!quiz && !quizLoading && !quizError && (
              <div className="quiz-empty">
                <div className="quiz-hero-icon"><Trophy size={28} /></div>
                <h3>Comprueba si realmente quedó claro</h3>
                <p>Companion generará 3 preguntas cortas sobre <strong>{topic || "el tema actual"}</strong>. Después de cada respuesta te explicará el porqué.</p>
                <button className="primary-action" onClick={createQuiz}><Sparkles size={18} /> Generar mi quiz</button>
              </div>
            )}

            {quizLoading && (
              <div className="quiz-loading"><LoaderCircle size={24} className="spin" /><strong>Preparando preguntas…</strong><span>Estoy usando lo que estudiaste en esta sesión.</span></div>
            )}

            {quizError && !quizLoading && (
              <div className="quiz-empty">
                <CircleAlert size={26} className="quiz-error-icon" />
                <h3>No pude preparar el quiz</h3>
                <p>{quizError}</p>
                <button className="secondary-action" onClick={createQuiz}><RefreshCcw size={17} /> Intentar otra vez</button>
              </div>
            )}

            {quiz && !quizFinished && currentQuestion && (
              <div className="quiz-body">
                <div className="quiz-progress-row">
                  <span>Pregunta {quizIndex + 1} de {quiz.questions.length}</span>
                  <span>{currentQuestion.concept}</span>
                </div>
                <div className="quiz-progress"><span style={{ width: `${((quizIndex + 1) / quiz.questions.length) * 100}%` }} /></div>
                <h3 className="quiz-question">{currentQuestion.question}</h3>

                <div className="quiz-options">
                  {currentQuestion.options.map((option, index) => {
                    const isCorrectOption = index === currentQuestion.answerIndex;
                    const isSelected = selectedAnswer === index;
                    const revealedClass = selectedAnswer === null
                      ? ""
                      : isCorrectOption
                        ? "correct"
                        : isSelected
                          ? "incorrect"
                          : "muted";
                    return (
                      <button
                        key={`${option}-${index}`}
                        className={`quiz-option ${revealedClass}`}
                        disabled={selectedAnswer !== null}
                        onClick={() => chooseAnswer(index)}
                      >
                        <span>{String.fromCharCode(65 + index)}</span>
                        <strong>{option}</strong>
                        {selectedAnswer !== null && isCorrectOption && <Check size={18} />}
                        {selectedAnswer !== null && isSelected && !isCorrectOption && <XCircle size={18} />}
                      </button>
                    );
                  })}
                </div>

                {selectedAnswer !== null && (
                  <div className={`quiz-feedback ${currentCorrect ? "good" : "bad"}`}>
                    <strong>{currentCorrect ? "¡Correcto!" : "Casi. Veamos por qué."}</strong>
                    <p>{currentQuestion.explanation}</p>
                  </div>
                )}

                <footer className="quiz-footer">
                  <span>{selectedAnswer === null ? "Elige una opción para continuar" : "La explicación también cuenta como parte del aprendizaje."}</span>
                  <button className="primary-action" disabled={selectedAnswer === null} onClick={nextQuizQuestion}>
                    {quizIndex === quiz.questions.length - 1 ? "Ver resultado" : "Siguiente"}
                  </button>
                </footer>
              </div>
            )}

            {quiz && quizFinished && (
              <div className="quiz-result">
                <div className="result-score">{finalCorrect}<span>/{quiz.questions.length}</span></div>
                <h3>{finalCorrect === quiz.questions.length ? "Muy bien, el tema está bastante claro." : finalCorrect >= 2 ? "Vas bien. Hay un punto que conviene reforzar." : "Encontramos qué conviene repasar."}</h3>
                <p>Este resultado ya se añadió a tu perfil de aprendizaje para detectar fortalezas y conceptos débiles; con sesión iniciada también se sincroniza con Supabase.</p>
                <div className="result-actions">
                  <button className="secondary-action" onClick={() => { setQuizOpen(false); setProfileOpen(true); }}><BarChart3 size={17} /> Ver mi aprendizaje</button>
                  <button className="primary-action" onClick={restartQuiz}><RefreshCcw size={17} /> Otro quiz</button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {profileOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(e) => {
          if (e.target === e.currentTarget) setProfileOpen(false);
        }}>
          <section className="profile-modal" role="dialog" aria-modal="true" aria-label="Tu aprendizaje">
            <header className="quiz-header">
              <div>
                <span className="mini-label">PERFIL DE APRENDIZAJE</span>
                <h2>{topic || "Tema actual"}</h2>
              </div>
              <button className="modal-close" onClick={() => setProfileOpen(false)} aria-label="Cerrar perfil"><X size={20} /></button>
            </header>

            <div className="profile-summary-grid">
              <div><span>Dominio estimado</span><strong>{mastery === null ? "Sin medir" : `${mastery}%`}</strong></div>
              <div><span>Quizzes</span><strong>{profile.quizzesCompleted}</strong></div>
              <div><span>Aciertos</span><strong>{profile.totalQuestions ? `${profile.totalCorrect}/${profile.totalQuestions}` : "—"}</strong></div>
              <div><span>Veces “No lo entendí”</span><strong>{profile.difficultySignals}</strong></div>
            </div>

            <div className="profile-section">
              <div className="profile-section-heading">
                <div><span className="mini-label">CONCEPTOS</span><h3>Qué dominas y qué reforzar</h3></div>
                <span className={`local-badge ${user ? "cloud" : ""}`}>{user ? "Sincronizado con Supabase" : "Guardado en este navegador"}</span>
              </div>

              {!conceptRows.length ? (
                <div className="profile-empty">Todavía no hay datos por concepto. Completa tu primer quiz y aquí aparecerá el mapa de fortalezas.</div>
              ) : (
                <div className="concept-list">
                  {conceptRows.map((row) => (
                    <div className="concept-row" key={row.name}>
                      <div className="concept-row-top">
                        <strong>{row.name}</strong>
                        <span className={row.score >= 80 ? "strong" : row.score >= 60 ? "medium" : "weak"}>{row.score}%</span>
                      </div>
                      <div className="concept-track"><span style={{ width: `${row.score}%` }} /></div>
                      <small>{row.correct} de {row.total} respuestas correctas</small>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button className="profile-adaptive-callout" onClick={() => { setProfileOpen(false); setAdaptiveOpen(true); }}>
              <Route size={19} />
              <div><strong>{adaptiveHint.title}</strong><span>{adaptiveHint.text}</span></div>
              <span>Crear plan →</span>
            </button>

            <div className="profile-note">
              <Brain size={19} />
              <p><strong>El tutor adaptativo ya usa estos datos.</strong> Los quizzes, los conceptos con menor acierto y las veces que marcas “No lo entendí” influyen en el siguiente plan y en los próximos quizzes. Con sesión iniciada, este perfil se sincroniza con Supabase y queda disponible en tus otros dispositivos.</p>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
