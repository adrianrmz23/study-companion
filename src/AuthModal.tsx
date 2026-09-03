import { FormEvent, useState } from "react";
import {
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  Mail,
  UserPlus,
  X
} from "lucide-react";
import { supabase, supabaseConfigured } from "./supabase";

type Props = {
  open: boolean;
  onClose: () => void;
};

type AuthMode = "login" | "register";

export default function AuthModal({ open, onClose }: Props) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);

  if (!open) return null;

  const resetFeedback = () => {
    setError("");
    setMessage("");
    setAwaitingConfirmation(false);
  };

  const changeMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    resetFeedback();
    setPassword("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase) return;

    const cleanEmail = email.trim().toLowerCase();
    const cleanName = name.trim();

    setLoading(true);
    resetFeedback();

    try {
      if (mode === "login") {
        const { error: authError } = await supabase.auth.signInWithPassword({
          email: cleanEmail,
          password
        });

        if (authError) throw authError;
        setPassword("");
        onClose();
        return;
      }

      const { data, error: authError } = await supabase.auth.signUp({
        email: cleanEmail,
        password,
        options: {
          data: {
            display_name: cleanName || undefined
          },
          emailRedirectTo: window.location.origin
        }
      });

      if (authError) throw authError;

      if (data.session) {
        setPassword("");
        onClose();
        return;
      }

      setAwaitingConfirmation(true);
      setMessage("Cuenta creada. Revisa tu correo y confirma tu cuenta; después podrás iniciar sesión en cualquier dispositivo.");
    } catch (err) {
      const raw = err instanceof Error ? err.message : "No fue posible completar la autenticación.";
      const friendly = raw.toLowerCase().includes("invalid login credentials")
        ? "El correo o la contraseña no coinciden."
        : raw.toLowerCase().includes("user already registered")
          ? "Ese correo ya está registrado. Cambia a Iniciar sesión."
          : raw;
      setError(friendly);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="auth-modal" role="dialog" aria-modal="true" aria-label="Cuenta Companion">
        <header className="quiz-header">
          <div>
            <span className="mini-label">CUENTA COMPANION</span>
            <h2>Tu progreso en todos tus dispositivos</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Cerrar"><X size={20} /></button>
        </header>

        {!supabaseConfigured ? (
          <div className="auth-content">
            <div className="auth-icon"><KeyRound size={25} /></div>
            <h3>Falta conectar Supabase</h3>
            <p>Agrega <code>VITE_SUPABASE_URL</code> y <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> en Vercel y vuelve a desplegar.</p>
          </div>
        ) : awaitingConfirmation ? (
          <div className="auth-content">
            <div className="auth-icon success"><CheckCircle2 size={25} /></div>
            <h3>Revisa tu correo</h3>
            <p>{message}</p>
            <button className="primary-action auth-primary" type="button" onClick={() => changeMode("login")}>
              <LogIn size={17} /> Ir a iniciar sesión
            </button>
          </div>
        ) : (
          <>
            <div className="auth-tabs" role="tablist" aria-label="Acceso a Companion">
              <button
                type="button"
                className={mode === "login" ? "active" : ""}
                onClick={() => changeMode("login")}
              >
                <LogIn size={16} /> Iniciar sesión
              </button>
              <button
                type="button"
                className={mode === "register" ? "active" : ""}
                onClick={() => changeMode("register")}
              >
                <UserPlus size={16} /> Crear cuenta
              </button>
            </div>

            <form className="auth-content" onSubmit={submit}>
              <div className="auth-icon">
                {mode === "login" ? <LockKeyhole size={25} /> : <UserPlus size={25} />}
              </div>
              <h3>{mode === "login" ? "Bienvenido de nuevo" : "Crea tu cuenta"}</h3>
              <p>
                {mode === "login"
                  ? "Entra para recuperar tu progreso, quizzes y conceptos desde cualquier dispositivo."
                  : "Tu cuenta guardará el avance de cada materia y tema de forma privada en Supabase."}
              </p>

              {mode === "register" && (
                <label className="auth-field">
                  <span>Nombre (opcional)</span>
                  <input
                    type="text"
                    autoComplete="name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Tu nombre"
                    maxLength={80}
                  />
                </label>
              )}

              <label className="auth-field">
                <span>Correo electrónico</span>
                <div className="auth-input-with-icon">
                  <Mail size={16} />
                  <input
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="tu@correo.com"
                    required
                  />
                </div>
              </label>

              <label className="auth-field">
                <span>Contraseña</span>
                <div className="auth-input-with-icon password">
                  <LockKeyhole size={16} />
                  <input
                    type={showPassword ? "text" : "password"}
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={mode === "login" ? "Tu contraseña" : "Mínimo 8 caracteres"}
                    minLength={8}
                    required
                  />
                  <button
                    type="button"
                    className="auth-password-toggle"
                    onClick={() => setShowPassword((current) => !current)}
                    aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </label>

              {error && <div className="auth-error">{error}</div>}
              {message && <div className="auth-success-message">{message}</div>}

              <button
                className="primary-action auth-primary"
                type="submit"
                disabled={loading || !email.trim() || password.length < 8}
              >
                {loading
                  ? <LoaderCircle size={17} className="spin" />
                  : mode === "login" ? <LogIn size={17} /> : <UserPlus size={17} />}
                {mode === "login" ? "Iniciar sesión" : "Crear cuenta"}
              </button>

              <button
                className="auth-link"
                type="button"
                onClick={() => changeMode(mode === "login" ? "register" : "login")}
              >
                {mode === "login" ? "¿No tienes cuenta? Crear una" : "¿Ya tienes cuenta? Iniciar sesión"}
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
