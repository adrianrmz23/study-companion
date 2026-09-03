import { FormEvent, useState } from "react";
import { CheckCircle2, KeyRound, LoaderCircle, Mail, X } from "lucide-react";
import { supabase, supabaseConfigured } from "./supabase";

type Props = {
  open: boolean;
  onClose: () => void;
};

export default function AuthModal({ open, onClose }: Props) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  if (!open) return null;

  const sendCode = async (event?: FormEvent) => {
    event?.preventDefault();
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !supabase) return;
    setLoading(true);
    setError("");
    try {
      const { error: authError } = await supabase.auth.signInWithOtp({
        email: cleanEmail,
        options: { shouldCreateUser: true }
      });
      if (authError) throw authError;
      setSent(true);
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No pude enviar el código.");
    } finally {
      setLoading(false);
    }
  };

  const verifyCode = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!supabase || !email.trim() || code.trim().length < 6) return;
    setLoading(true);
    setError("");
    try {
      const { error: authError } = await supabase.auth.verifyOtp({
        email: email.trim().toLowerCase(),
        token: code.trim(),
        type: "email"
      });
      if (authError) throw authError;
      onClose();
      setCode("");
      setStep("email");
      setSent(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "El código no es válido o expiró.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="auth-modal" role="dialog" aria-modal="true" aria-label="Sincronizar progreso">
        <header className="quiz-header">
          <div>
            <span className="mini-label">CUENTA COMPANION</span>
            <h2>Sincroniza tu aprendizaje</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Cerrar"><X size={20} /></button>
        </header>

        {!supabaseConfigured ? (
          <div className="auth-content">
            <div className="auth-icon"><KeyRound size={25} /></div>
            <h3>Falta conectar Supabase</h3>
            <p>Agrega <code>VITE_SUPABASE_URL</code> y <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> en Vercel y vuelve a desplegar.</p>
          </div>
        ) : step === "email" ? (
          <form className="auth-content" onSubmit={sendCode}>
            <div className="auth-icon"><Mail size={25} /></div>
            <h3>Entra con tu correo</h3>
            <p>Te enviaremos un código de 6 dígitos. Al iniciar sesión, tu progreso podrá seguirte en cualquier dispositivo.</p>
            <label className="auth-field">
              <span>Correo electrónico</span>
              <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="tu@correo.com" required />
            </label>
            {error && <div className="auth-error">{error}</div>}
            <button className="primary-action auth-primary" type="submit" disabled={loading || !email.trim()}>
              {loading ? <LoaderCircle size={17} className="spin" /> : <Mail size={17} />}
              Enviar código
            </button>
          </form>
        ) : (
          <form className="auth-content" onSubmit={verifyCode}>
            <div className="auth-icon success"><CheckCircle2 size={25} /></div>
            <h3>Revisa tu correo</h3>
            <p>{sent ? <>Enviamos el código a <strong>{email}</strong>.</> : "Escribe el código recibido."}</p>
            <label className="auth-field">
              <span>Código de 6 dígitos</span>
              <input className="otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="000000" required />
            </label>
            {error && <div className="auth-error">{error}</div>}
            <button className="primary-action auth-primary" type="submit" disabled={loading || code.length !== 6}>
              {loading ? <LoaderCircle size={17} className="spin" /> : <CheckCircle2 size={17} />}
              Entrar y sincronizar
            </button>
            <button className="auth-link" type="button" disabled={loading} onClick={() => void sendCode()}>Reenviar código</button>
            <button className="auth-link muted" type="button" onClick={() => { setStep("email"); setCode(""); setError(""); }}>Usar otro correo</button>
          </form>
        )}
      </section>
    </div>
  );
}
