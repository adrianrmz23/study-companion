import { useEffect, useMemo, useState } from "react";
import {
  Brain,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  RefreshCcw,
  RotateCcw,
  Sparkles
} from "lucide-react";
import { supabase } from "./supabase";

type ConceptStat = { correct?: number; total?: number };
type LearningProfileRow = {
  subject: string;
  topic: string;
  profile: { concepts?: Record<string, ConceptStat> } | null;
};

type ReviewItem = {
  id: string;
  subject: string;
  topic: string;
  concept: string;
  mastery_score: number;
  repetitions: number;
  interval_days: number;
  ease_factor: number;
  next_review_at: string;
  last_result: "again" | "hard" | "good" | "easy" | null;
};

type ReviewCard = { question: string; answer: string; tip: string };
type Rating = "again" | "hard" | "good" | "easy";

type Props = {
  userId?: string | null;
  onRequireAuth?: () => void;
};

function normalizeKey(value: string) {
  return value.trim().toLocaleLowerCase("es-MX").replace(/\s+/g, " ");
}

function scoreConcept(stat?: ConceptStat) {
  const total = Math.max(0, Number(stat?.total) || 0);
  const correct = Math.max(0, Number(stat?.correct) || 0);
  return total ? Math.max(0, Math.min(100, Math.round((correct / total) * 100))) : 0;
}

function formatDue(value: string) {
  const time = Date.parse(value);
  const diff = time - Date.now();
  if (!Number.isFinite(time) || diff <= 0) return "Ahora";
  const hours = Math.ceil(diff / 3600000);
  if (hours < 24) return `En ${hours} h`;
  const days = Math.ceil(hours / 24);
  return `En ${days} día${days === 1 ? "" : "s"}`;
}

function nextSchedule(item: ReviewItem, rating: Rating) {
  const repetitions = rating === "again" ? 0 : item.repetitions + 1;
  let interval = item.interval_days || 1;
  let ease = Math.max(1.3, Number(item.ease_factor) || 2.3);

  if (rating === "again") {
    interval = 1;
    ease = Math.max(1.3, ease - 0.2);
  } else if (rating === "hard") {
    interval = Math.max(1, Math.round(interval * 1.25));
    ease = Math.max(1.3, ease - 0.08);
  } else if (rating === "good") {
    interval = repetitions <= 1 ? 1 : repetitions === 2 ? 3 : Math.max(4, Math.round(interval * ease));
  } else {
    ease += 0.12;
    interval = repetitions <= 1 ? 3 : Math.max(6, Math.round(interval * ease * 1.25));
  }

  const next = new Date(Date.now() + interval * 86400000).toISOString();
  return { repetitions, interval_days: interval, ease_factor: ease, next_review_at: next, last_result: rating };
}

export default function SpacedReview({ userId, onRequireAuth }: Props) {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState<ReviewItem | null>(null);
  const [card, setCard] = useState<ReviewCard | null>(null);
  const [cardLoading, setCardLoading] = useState(false);
  const [cardError, setCardError] = useState("");
  const [showAnswer, setShowAnswer] = useState(false);

  const due = useMemo(
    () => items.filter((item) => Date.parse(item.next_review_at) <= Date.now()).sort((a, b) => Date.parse(a.next_review_at) - Date.parse(b.next_review_at)),
    [items]
  );
  const upcoming = useMemo(
    () => items.filter((item) => Date.parse(item.next_review_at) > Date.now()).sort((a, b) => Date.parse(a.next_review_at) - Date.parse(b.next_review_at)).slice(0, 12),
    [items]
  );

  const load = async () => {
    if (!userId || !supabase) {
      setItems([]);
      return;
    }
    setLoading(true);
    setError("");
    const client = supabase;
    const [{ data: profileRows, error: profileError }, { data: existingRows, error: reviewError }] = await Promise.all([
      client.from("learning_profiles").select("subject,topic,profile").eq("user_id", userId),
      client.from("review_items").select("id,subject,topic,concept,mastery_score,repetitions,interval_days,ease_factor,next_review_at,last_result").eq("user_id", userId)
    ]);

    if (profileError || reviewError) {
      setLoading(false);
      const message = profileError?.message || reviewError?.message || "No pude cargar el repaso.";
      setError(message.includes("review_items") ? "Falta ejecutar la migración 006_guided_study_notes_review.sql en Supabase." : message);
      return;
    }

    const existing = new Map<string, any>();
    (existingRows || []).forEach((row: any) => {
      existing.set(`${normalizeKey(row.subject)}::${normalizeKey(row.topic)}::${normalizeKey(row.concept)}`, row);
    });

    const rows: any[] = [];
    (profileRows || []).forEach((row: LearningProfileRow) => {
      const concepts = row.profile?.concepts || {};
      Object.entries(concepts).forEach(([concept, stat]) => {
        const total = Math.max(0, Number(stat?.total) || 0);
        if (!total) return;
        const key = `${normalizeKey(row.subject)}::${normalizeKey(row.topic)}::${normalizeKey(concept)}`;
        const previous = existing.get(key);
        const masteryScore = scoreConcept(stat);
        const initialDelayDays = masteryScore < 60 ? 0 : masteryScore < 80 ? 1 : 3;
        rows.push({
          user_id: userId,
          subject: row.subject,
          topic: row.topic,
          concept,
          subject_key: normalizeKey(row.subject),
          topic_key: normalizeKey(row.topic),
          concept_key: normalizeKey(concept),
          mastery_score: masteryScore,
          repetitions: Number(previous?.repetitions) || 0,
          interval_days: Math.max(1, Number(previous?.interval_days) || 1),
          ease_factor: Math.max(1.3, Number(previous?.ease_factor) || 2.3),
          next_review_at: previous?.next_review_at || new Date(Date.now() + initialDelayDays * 86400000).toISOString(),
          last_result: previous?.last_result || null,
          updated_at: new Date().toISOString()
        });
      });
    });

    if (rows.length) {
      const { error: syncError } = await client.from("review_items").upsert(rows, {
        onConflict: "user_id,subject_key,topic_key,concept_key"
      });
      if (syncError) {
        setLoading(false);
        setError(syncError.message.includes("review_items") ? "Falta ejecutar la migración 006_guided_study_notes_review.sql en Supabase." : syncError.message);
        return;
      }
    }

    const { data: refreshed, error: refreshedError } = await client
      .from("review_items")
      .select("id,subject,topic,concept,mastery_score,repetitions,interval_days,ease_factor,next_review_at,last_result")
      .eq("user_id", userId)
      .order("next_review_at", { ascending: true });
    setLoading(false);
    if (refreshedError) {
      setError(refreshedError.message);
      return;
    }
    setItems((refreshed || []) as ReviewItem[]);
  };

  useEffect(() => { void load(); }, [userId]);

  const openCard = async (item: ReviewItem) => {
    setActive(item);
    setCard(null);
    setShowAnswer(false);
    setCardError("");
    setCardLoading(true);
    try {
      const response = await fetch("/api/review-question", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: item.subject, topic: item.topic, concept: item.concept })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "No pude crear la tarjeta.");
      setCard(payload.card as ReviewCard);
    } catch (err) {
      setCardError(err instanceof Error ? err.message : "No pude crear la tarjeta.");
    } finally {
      setCardLoading(false);
    }
  };

  const rateCard = async (rating: Rating) => {
    if (!active || !userId || !supabase) return;
    const changes = nextSchedule(active, rating);
    const { error: updateError } = await supabase
      .from("review_items")
      .update({ ...changes, updated_at: new Date().toISOString() })
      .eq("id", active.id)
      .eq("user_id", userId);
    if (updateError) {
      setCardError(updateError.message);
      return;
    }
    setItems((current) => current.map((item) => item.id === active.id ? { ...item, ...changes } : item));
    setActive(null);
    setCard(null);
    setShowAnswer(false);
  };

  if (!userId) {
    return (
      <section className="review-empty-auth">
        <div className="review-empty-icon"><CalendarClock size={27} /></div>
        <span className="eyebrow">REPASO ESPACIADO</span>
        <h1>Que lo aprendido no se te vaya olvidando</h1>
        <p>Companion usa los conceptos medidos en tus quizzes para decidir qué conviene recuperar hoy y cuándo volver a verlo.</p>
        <button onClick={onRequireAuth}><Brain size={17} /> Iniciar sesión</button>
      </section>
    );
  }

  return (
    <div className="review-page">
      <header className="review-page-header">
        <div>
          <span className="eyebrow">REPASO ESPACIADO</span>
          <h1>Repasar hoy</h1>
          <p>Sesiones pequeñas de recuerdo activo basadas en lo que ya has practicado.</p>
        </div>
        <button onClick={() => void load()} disabled={loading}><RefreshCcw size={16} className={loading ? "spin" : ""} /> Actualizar</button>
      </header>

      <section className="review-summary-grid">
        <article><strong>{due.length}</strong><span>pendientes hoy</span></article>
        <article><strong>{items.length}</strong><span>conceptos programados</span></article>
        <article><strong>{upcoming.length ? formatDue(upcoming[0].next_review_at) : "—"}</strong><span>próximo repaso</span></article>
      </section>

      {error && <div className="review-error"><CircleAlert size={17} /> {error}</div>}

      {active && (
        <section className="review-card-active">
          <div className="review-card-head">
            <div><span>{active.subject} · {active.topic}</span><h2>{active.concept}</h2></div>
            <button onClick={() => void openCard(active)} disabled={cardLoading}><RotateCcw size={15} /> Otra pregunta</button>
          </div>
          {cardLoading ? <div className="review-card-loading"><LoaderCircle size={18} className="spin" /> Preparando recuerdo activo…</div> : cardError ? <div className="review-error">{cardError}</div> : card ? (
            <>
              <div className="review-question"><Sparkles size={18} /><p>{card.question}</p></div>
              {!showAnswer ? (
                <button className="review-reveal" onClick={() => setShowAnswer(true)}>Mostrar respuesta</button>
              ) : (
                <>
                  <div className="review-answer"><strong>Respuesta modelo</strong><p>{card.answer}</p>{card.tip && <small>Pista mental: {card.tip}</small>}</div>
                  <div className="review-rating">
                    <span>¿Qué tan fácil te resultó recordarlo?</span>
                    <div>
                      <button className="again" onClick={() => void rateCard("again")}>No recordé</button>
                      <button className="hard" onClick={() => void rateCard("hard")}>Me costó</button>
                      <button className="good" onClick={() => void rateCard("good")}>Bien</button>
                      <button className="easy" onClick={() => void rateCard("easy")}>Fácil</button>
                    </div>
                  </div>
                </>
              )}
            </>
          ) : null}
        </section>
      )}

      <section className="review-list-card">
        <div className="review-list-title"><div><span className="mini-label">HOY</span><strong>{due.length ? "Conceptos que toca recuperar" : "Ya terminaste lo pendiente"}</strong></div>{!due.length && <CheckCircle2 size={20} />}</div>
        {due.length ? (
          <div className="review-items">
            {due.map((item) => (
              <button key={item.id} onClick={() => void openCard(item)}>
                <div><strong>{item.concept}</strong><span>{item.subject} · {item.topic}</span></div>
                <small>{item.mastery_score}% dominio</small>
              </button>
            ))}
          </div>
        ) : <p className="review-empty-copy">No hay nada vencido. Puedes seguir estudiando y Companion irá alimentando esta cola con tus quizzes.</p>}
      </section>

      {!!upcoming.length && (
        <section className="review-list-card muted">
          <div className="review-list-title"><div><span className="mini-label">DESPUÉS</span><strong>Próximos repasos</strong></div></div>
          <div className="review-items">
            {upcoming.map((item) => (
              <button key={item.id} onClick={() => void openCard(item)}>
                <div><strong>{item.concept}</strong><span>{item.subject} · {item.topic}</span></div>
                <small>{formatDue(item.next_review_at)}</small>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
