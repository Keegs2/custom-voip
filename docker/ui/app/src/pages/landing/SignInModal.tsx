import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { ArrowRight, X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

/* ─────────────────────────────────────────────────────────────
   Landing sign-in modal — Granite & Signal design language.

   Compact granite panel over a dimmed backdrop. Closes on
   Escape, backdrop click, or the X control. On success the
   parent decides where to navigate (post-login redirect).
   All styling lives in index.css under "LANDING PAGE".
   ───────────────────────────────────────────────────────────── */

interface SignInModalProps {
  onClose: () => void;
  /** Called after login() resolves — parent closes + redirects. */
  onSuccess: () => void;
}

/**
 * Mounted only while open (parent renders `{signInOpen && <SignInModal …/>}`),
 * so every open starts with fresh field/error state — no reset effect needed.
 */
export function SignInModal({ onClose, onSuccess }: SignInModalProps) {
  // All hooks unconditionally at the top — React #310 prevention.
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  // Focus + Escape handling + scroll lock for the modal's lifetime.
  useEffect(() => {
    const focusTimer = window.setTimeout(() => emailRef.current?.focus(), 40);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        await login(email, password);
        onSuccess();
      } catch (err) {
        setError(
          err instanceof Error && err.message
            ? err.message
            : 'Sign-in failed. Check your email and password and try again.',
        );
        setSubmitting(false);
      }
    },
    [email, password, login, onSuccess, submitting],
  );

  return (
    <div
      className="landing-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Sign in to Granite CRAG"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="landing-modal">
        <button
          type="button"
          className="landing-modal-close"
          aria-label="Close sign-in dialog"
          onClick={onClose}
        >
          <X size={18} strokeWidth={2.2} />
        </button>

        <span className="landing-modal-kicker">Granite CRAG</span>
        <h2 className="landing-modal-title">Sign in</h2>
        <p className="landing-modal-sub">
          Access the CRAG console with your Granite-issued credentials.
        </p>

        <form onSubmit={handleSubmit} noValidate className="landing-modal-form">
          <div className="landing-field">
            <label className="landing-label" htmlFor="landing-signin-email">
              Email
            </label>
            <input
              id="landing-signin-email"
              ref={emailRef}
              className="landing-input"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              required
            />
          </div>

          <div className="landing-field">
            <label className="landing-label" htmlFor="landing-signin-password">
              Password
            </label>
            <input
              id="landing-signin-password"
              className="landing-input"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              required
            />
          </div>

          {error && (
            <div className="landing-form-error" role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="landing-btn landing-btn-primary landing-modal-submit"
            disabled={submitting || !email || !password}
          >
            {submitting ? (
              'Signing in…'
            ) : (
              <>
                Sign in
                <ArrowRight size={16} strokeWidth={2.5} />
              </>
            )}
          </button>
        </form>

        <p className="landing-modal-foot">
          Need an account? Request access below — TED, Granite&rsquo;s Onboarding
          AI, intakes it instantly and works with Granite Telephony Engineering
          on activation.
        </p>
      </div>
    </div>
  );
}
