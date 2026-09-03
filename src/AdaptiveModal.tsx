import { useEffect, useState } from "react";
import {
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  CircleAlert,
  Clock3,
  LoaderCircle,
  RefreshCcw,
  Route,
  Target,
  X
} from "lucide-react";

type ChatMessage = { role: "user" | "assistant"; content: string };

type LearningSnapshot = {
  mastery: number | null;
  quizzesCompleted: number;
  difficultySignals: number;
  concepts: Array<{ name: string; score: number; total: number }>;
};

type PlanStep = { label: string; minutes: number; instruction: string };

type AdaptivePlan = {
  status: "diagnosticar" | "reforzar" | "consolidar" | "avanzar";
  headline: string;
  diagnosis: string;
  strengths: string[];
  weaknesses: string[];
  steps: PlanStep[];
  recommendedPrompt: string;
  nextCheckpoint: string;
};

type Props = {
  open: boolean;
  subject: string;
  topic: string;
  messages: ChatMessage[];
  learning: LearningSnapshot;
  onClose: () => void;
  onUsePrompt: (prompt: string) => void;
};

export default function AdaptiveModal({ open, subject, topic, messages, learning, onClose, onUsePrompt }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [plan, setPlan] = useState<AdaptivePlan | null>(null);

  useEffect(() => {
    if (!open) return;
    setPlan(null);
    setError("");
  }, [open, subject, topic]);

  const generatePlan = async () => {
    if (loading) return;
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/adaptive-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject,
          topic,
          learningProfile: learning,
          history: messages.slice(-10)
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "No pude crear el plan adaptativo.");
      setPlan(data.plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No pude crear el plan adaptativo.");
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="adaptive-modal" role="dialog" aria-modal="true" aria-label="Tutor adaptativo">
        <header className="quiz-header">
          <div>
            <span className="mini-label">TUTOR ADAPTATIVO</span>
            <h2>Tu siguiente paso</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Cerrar plan"><X size={20} /></button>
        </header>

        {!plan && !loading && !error && (
          <div className="adaptive-empty">
            <div className="adaptive-hero-icon"><BrainCircuit size={30} /></div>
            <h3>Que Companion decida qué conviene hacer después</h3>
            <p>Analizaré tus resultados de quiz, señales de dificultad y la conversación reciente para decidir si conviene diagnosticar, reforzar, consolidar o avanzar.</p>
            <div className="adaptive-evidence-row">
              <span><Target size={15} /> {learning.concepts.length} conceptos medidos</span>
              <span><CheckCircle2 size={15} /> {learning.quizzesCompleted} quizzes</span>
              <span><CircleAlert size={15} /> {learning.difficultySignals} señales de dificultad</span>
            </div>
            <button className="primary-action" onClick={generatePlan}><Route size={18} /> Crear plan adaptativo</button>
          </div>
        )}

        {loading && (
          <div className="adaptive-empty">
            <LoaderCircle size={27} className="spin" />
            <h3>Analizando tu aprendizaje…</h3>
            <p>No solo miro el porcentaje general: también considero qué conceptos has fallado y qué te ha costado explicar.</p>
          </div>
        )}

        {error && !loading && (
          <div className="adaptive-empty">
            <CircleAlert size={28} className="quiz-error-icon" />
            <h3>No pude crear el plan</h3>
            <p>{error}</p>
            <button className="secondary-action" onClick={generatePlan}><RefreshCcw size={17} /> Intentar otra vez</button>
          </div>
        )}

        {plan && (
          <div className="adaptive-result">
            <section className={`adaptive-diagnosis ${plan.status}`}>
              <div className="adaptive-status-icon"><BrainCircuit size={21} /></div>
              <div>
                <span className="mini-label">RECOMENDACIÓN · {plan.status.toUpperCase()}</span>
                <h3>{plan.headline}</h3>
                <p>{plan.diagnosis}</p>
              </div>
            </section>

            {(plan.strengths.length > 0 || plan.weaknesses.length > 0) && (
              <div className="adaptive-columns">
                <section>
                  <span className="mini-label">YA ESTÁ FUERTE</span>
                  {plan.strengths.length ? plan.strengths.map((item) => <p key={item}><CheckCircle2 size={15} /> {item}</p>) : <p className="muted-adaptive">Todavía necesito más evidencia.</p>}
                </section>
                <section>
                  <span className="mini-label">CONVIENE REFORZAR</span>
                  {plan.weaknesses.length ? plan.weaknesses.map((item) => <p key={item}><Target size={15} /> {item}</p>) : <p className="muted-adaptive">No detecté una debilidad clara.</p>}
                </section>
              </div>
            )}

            <section className="adaptive-route-card">
              <div className="profile-section-heading">
                <div><span className="mini-label">MICROSESIÓN</span><h3>Ruta recomendada</h3></div>
                <span className="local-badge"><Clock3 size={12} /> {plan.steps.reduce((sum, step) => sum + step.minutes, 0)} min</span>
              </div>
              <div className="adaptive-steps">
                {plan.steps.map((step, index) => (
                  <div className="adaptive-step" key={`${step.label}-${index}`}>
                    <span>{index + 1}</span>
                    <div><strong>{step.label}</strong><p>{step.instruction}</p></div>
                    <small>{step.minutes} min</small>
                  </div>
                ))}
              </div>
            </section>

            <section className="adaptive-checkpoint">
              <strong>¿Cuándo sabremos que puedes avanzar?</strong>
              <p>{plan.nextCheckpoint}</p>
            </section>

            <footer className="adaptive-footer">
              <button className="secondary-action" onClick={generatePlan}><RefreshCcw size={17} /> Recalcular</button>
              <button className="primary-action" onClick={() => onUsePrompt(plan.recommendedPrompt)}>
                Empezar en el chat <ArrowRight size={17} />
              </button>
            </footer>
          </div>
        )}
      </section>
    </div>
  );
}
