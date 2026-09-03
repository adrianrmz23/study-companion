import { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  CircleAlert,
  Headphones,
  LoaderCircle,
  Pause,
  Play,
  RefreshCcw,
  Square,
  X
} from "lucide-react";

type ChatMessage = { role: "user" | "assistant"; content: string };

type LearningSnapshot = {
  mastery: number | null;
  quizzesCompleted: number;
  difficultySignals: number;
  concepts: Array<{ name: string; score: number; total: number }>;
};

type AudioResult = {
  title: string;
  estimatedMinutes: number;
  script: string;
  focusPoints: string[];
  closingQuestion: string;
};

type Props = {
  open: boolean;
  subject: string;
  topic: string;
  messages: ChatMessage[];
  learning: LearningSnapshot;
  focusText?: string;
  onClose: () => void;
};

const rates = [0.8, 1, 1.25, 1.5];

export default function AudioModal({ open, subject, topic, messages, learning, focusText, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [audioLoading, setAudioLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AudioResult | null>(null);
  const [rate, setRate] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const kind = focusText ? "explanation" : "review";
  const heading = focusText ? "Versión hablada" : "Repaso hablado";

  const stopAudio = () => {
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
  };

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setError("");
    setRate(1);
    stopAudio();
  }, [open, focusText]);

  useEffect(() => () => stopAudio(), []);

  const prepare = async () => {
    if (loading) return;
    stopAudio();
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/audio-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject,
          topic,
          kind,
          focusText: focusText || "",
          learningProfile: learning,
          history: messages.slice(-10)
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "No pude preparar el repaso hablado.");
      setResult(data.audio);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No pude preparar el repaso hablado.");
    } finally {
      setLoading(false);
    }
  };

  const ensureAudio = async () => {
    if (!result) throw new Error("Primero prepara el guion del audio.");
    if (audioRef.current) return audioRef.current;

    setAudioLoading(true);
    try {
      const narration = [
        result.script,
        result.closingQuestion ? `Para cerrar, piensa en esta pregunta: ${result.closingQuestion}` : ""
      ].filter(Boolean).join(" ");
      const response = await fetch("/api/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: narration })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.error || "No pude generar la narración con ElevenLabs.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      const audio = new Audio(url);
      audio.playbackRate = rate;
      audio.preload = "auto";
      audio.onended = () => { setPlaying(false); setPaused(false); };
      audio.onerror = () => { setPlaying(false); setPaused(false); setError("No pude reproducir la narración."); };
      audioRef.current = audio;
      return audio;
    } finally {
      setAudioLoading(false);
    }
  };

  const startPauseResume = async () => {
    setError("");
    try {
      const current = audioRef.current;
      if (current && playing && !paused) {
        current.pause();
        setPaused(true);
        return;
      }
      if (current && paused) {
        await current.play();
        setPaused(false);
        setPlaying(true);
        return;
      }
      const audio = await ensureAudio();
      audio.playbackRate = rate;
      await audio.play();
      setPlaying(true);
      setPaused(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No pude reproducir el audio.");
    }
  };

  const changeRate = (nextRate: number) => {
    setRate(nextRate);
    if (audioRef.current) audioRef.current.playbackRate = nextRate;
  };

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) { stopAudio(); onClose(); }
    }}>
      <section className="audio-modal" role="dialog" aria-modal="true" aria-label={heading}>
        <header className="quiz-header">
          <div>
            <span className="mini-label">ELEVENLABS AUDIO</span>
            <h2>{heading}</h2>
          </div>
          <button className="modal-close" onClick={() => { stopAudio(); onClose(); }} aria-label="Cerrar audio"><X size={20} /></button>
        </header>

        {!result && !loading && !error && (
          <div className="audio-empty">
            <div className="audio-hero-icon"><Headphones size={30} /></div>
            <h3>{focusText ? "Conviértelo en una explicación para escuchar" : "Convierte tu sesión en un repaso de 3–5 minutos"}</h3>
            <p>{focusText
              ? "Companion reescribirá esta respuesta para que suene natural al escucharla y ElevenLabs generará la narración con la misma configuración que usamos en Maestría Lab."
              : "Usaré la conversación, tus quizzes y tus conceptos más débiles para preparar un repaso hablado; después ElevenLabs generará la voz."}</p>
            <button className="primary-action" onClick={prepare}><AudioLines size={18} /> Preparar audio</button>
            <small>La API key de ElevenLabs se utiliza únicamente en el backend y nunca se envía al navegador.</small>
          </div>
        )}

        {loading && (
          <div className="audio-empty audio-loading">
            <LoaderCircle size={27} className="spin" />
            <h3>Preparando una versión para escuchar…</h3>
            <p>Estoy reorganizando el contenido para que tenga ritmo oral y priorice las partes importantes.</p>
          </div>
        )}

        {error && !loading && !result && (
          <div className="audio-empty">
            <CircleAlert size={28} className="quiz-error-icon" />
            <h3>No pude preparar el audio</h3>
            <p>{error}</p>
            <button className="secondary-action" onClick={prepare}><RefreshCcw size={17} /> Intentar otra vez</button>
          </div>
        )}

        {result && (
          <div className="audio-result">
            <section className="audio-player-card">
              <div className="audio-player-top">
                <div>
                  <span className="mini-label">{result.estimatedMinutes} MIN APROX. · ELEVENLABS</span>
                  <h3>{result.title}</h3>
                </div>
                <div className="audio-equalizer"><span /><span /><span /><span /></div>
              </div>

              <div className="audio-controls">
                <button className="audio-main-control" onClick={startPauseResume} disabled={audioLoading}>
                  {audioLoading ? <LoaderCircle size={20} className="spin" /> : playing && !paused ? <Pause size={20} /> : <Play size={20} />}
                  {audioLoading ? "Generando voz…" : playing && !paused ? "Pausar" : paused ? "Continuar" : "Escuchar"}
                </button>
                <button className="audio-stop" onClick={stopAudio} disabled={!playing && !paused}><Square size={16} /> Detener</button>
                <div className="audio-rates">
                  {rates.map((item) => (
                    <button key={item} className={rate === item ? "active" : ""} onClick={() => changeRate(item)}>{item}x</button>
                  ))}
                </div>
              </div>

              {error && <p className="audio-browser-warning">{error}</p>}
            </section>

            <section className="audio-script-card">
              <span className="mini-label">GUION DEL REPASO</span>
              <p>{result.script}</p>
            </section>

            {!!result.focusPoints.length && (
              <section className="audio-focus-card">
                <span className="mini-label">PUNTOS QUE PRIORIZA</span>
                <div>{result.focusPoints.map((point) => <span key={point}>{point}</span>)}</div>
              </section>
            )}

            {result.closingQuestion && (
              <section className="audio-closing-question">
                <strong>Pregunta de recuerdo activo</strong>
                <p>{result.closingQuestion}</p>
              </section>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
