import { useEffect, useRef, useState, type MouseEvent } from "react";
import { LoaderCircle, Pause, Play, Square, Volume2 } from "lucide-react";

type Props = {
  text: string;
  compact?: boolean;
};

export default function SpeakButton({ text, compact = false }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState("");

  const cleanup = () => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setPlaying(false);
    setPaused(false);
  };

  useEffect(() => cleanup, []);

  const createAudio = async () => {
    const response = await fetch("/api/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data?.error || "No pude generar el audio con ElevenLabs.");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    objectUrlRef.current = url;
    const audio = new Audio(url);
    audio.preload = "auto";
    audio.onended = () => {
      setPlaying(false);
      setPaused(false);
    };
    audio.onerror = () => {
      setPlaying(false);
      setPaused(false);
      setError("No pude reproducir este audio.");
    };
    audioRef.current = audio;
    return audio;
  };

  const toggle = async () => {
    setError("");
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

    setLoading(true);
    try {
      cleanup();
      const audio = await createAudio();
      await audio.play();
      setPlaying(true);
      setPaused(false);
    } catch (err) {
      cleanup();
      setError(err instanceof Error ? err.message : "No pude generar el audio.");
    } finally {
      setLoading(false);
    }
  };

  const stop = (event: MouseEvent) => {
    event.stopPropagation();
    cleanup();
  };

  return (
    <span className="speak-wrap">
      <button
        type="button"
        className={`speak-button ${compact ? "compact" : ""}`}
        onClick={toggle}
        disabled={loading}
        title={error || (playing && !paused ? "Pausar audio" : paused ? "Continuar audio" : "Escuchar con ElevenLabs")}
      >
        {loading ? <LoaderCircle size={14} className="spin" /> : playing && !paused ? <Pause size={14} /> : paused ? <Play size={14} /> : <Volume2 size={15} />}
        {!compact && <span>{loading ? "Generando…" : playing && !paused ? "Pausar" : paused ? "Continuar" : "Escuchar"}</span>}
      </button>
      {(playing || paused) && (
        <button type="button" className="speak-stop-mini" onClick={stop} title="Detener audio"><Square size={11} /></button>
      )}
    </span>
  );
}
