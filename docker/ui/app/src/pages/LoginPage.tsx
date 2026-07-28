import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { ApiError } from '../api/client';
import { AnimatedGridBackground } from '../components/layout/AnimatedGridBackground';

/* ─── Location state type ────────────────────────────────── */

interface LocationState {
  from?: { pathname: string };
}

/* ─── Page ───────────────────────────────────────────────── */

export function LoginPage() {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Input focus states for border highlight
  const [emailFocused, setEmailFocused] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);

  // If already authenticated, redirect away immediately
  if (isAuthenticated) {
    const state = location.state as LocationState | null;
    const destination = state?.from?.pathname ?? '/';
    navigate(destination, { replace: true });
    return null;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await login(email.trim(), password);
      const state = location.state as LocationState | null;
      const destination = state?.from?.pathname ?? '/';
      navigate(destination, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        // 401 from login = wrong credentials. Produce a clear user message.
        if (err.status === 401) {
          setError('Invalid email or password. Please try again.');
        } else {
          setError(err.message || 'An unexpected error occurred.');
        }
      } else {
        setError('Unable to connect to the server. Please check your network and try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#0f1117',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 16px',
        // Subtle noise texture via radial gradients
        backgroundImage: [
          'radial-gradient(ellipse 80% 60% at 50% -10%, rgba(59,130,246,0.12) 0%, transparent 60%)',
          'radial-gradient(ellipse 40% 30% at 80% 90%, rgba(59,130,246,0.06) 0%, transparent 50%)',
        ].join(', '),
        position: 'relative',
      }}
    >
      {/* Animated grid background — sits at z-0 behind all content */}
      <AnimatedGridBackground
        gridSize={56}
        dotsPerSide={6}
        gridOpacity={0.05}
        showGlow={true}
      />

      <div
        style={{
          width: '100%',
          maxWidth: 400,
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* ── Brand header above card ───────────────────────── */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <style>{`
            @keyframes cragGlow {
              0%   { filter: drop-shadow(0 0 12px rgba(59, 130, 246, 0.3)) drop-shadow(0 0 24px rgba(59, 130, 246, 0.1)); }
              100% { filter: drop-shadow(0 0 20px rgba(59, 130, 246, 0.55)) drop-shadow(0 0 40px rgba(59, 130, 246, 0.22)); }
            }
            @keyframes cragFloat {
              0%, 100% { transform: translateY(0px); }
              50%       { transform: translateY(-4px); }
            }
            /* Inner image — glow + float run continuously, never paused */
            .crag-hero-img {
              animation: cragGlow 3s ease-in-out infinite alternate,
                         cragFloat 6s ease-in-out infinite;
            }
            /* Outer wrapper — scale hover is independent of the animation */
            .crag-hero-wrap {
              display: inline-block;
              transition: transform 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94);
            }
            .crag-hero-wrap:hover {
              transform: scale(1.02);
            }
          `}</style>

          {/* Hero branded image — contains "CRAG" text + subtitle built in */}
          <div className="crag-hero-wrap">
            <img
              src="/crag.png"
              alt="Granite CRAG — Call Routing Application Gateway"
              className="crag-hero-img"
              style={{
                width: 220,
                height: 'auto',
                display: 'block',
                margin: '0 auto 16px',
              }}
            />
          </div>

          <p
            style={{
              fontSize: '0.7rem',
              fontWeight: 600,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              color: '#2d3a4a',
            }}
          >
            Enterprise Voice Platform
          </p>
        </div>

        {/* ── Login card ───────────────────────────────────── */}
        <div
          style={{
            background: 'linear-gradient(135deg, rgba(30,33,48,0.95) 0%, rgba(19,21,29,0.98) 100%)',
            border: '1px solid rgba(42,47,69,0.7)',
            borderRadius: 20,
            padding: '36px 32px 32px',
            boxShadow: '0 32px 80px -16px rgba(0,0,0,0.7), 0 0 0 1px rgba(59,130,246,0.08)',
          }}
        >
          <h2
            style={{
              fontSize: '1.125rem',
              fontWeight: 700,
              color: '#e2e8f0',
              letterSpacing: '-0.02em',
              margin: '0 0 4px',
            }}
          >
            Sign in to your account
          </h2>
          <p style={{ fontSize: '0.8rem', color: '#475569', margin: '0 0 28px' }}>
            Enter your credentials to continue
          </p>

          <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Email field */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label
                htmlFor="email"
                style={{ fontSize: '0.75rem', fontWeight: 600, color: '#64748b', letterSpacing: '0.04em' }}
              >
                EMAIL ADDRESS
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onFocus={() => setEmailFocused(true)}
                onBlur={() => setEmailFocused(false)}
                placeholder="you@example.com"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  background: '#0d0f15',
                  border: `1px solid ${emailFocused ? '#3b82f6' : 'rgba(42,47,69,0.6)'}`,
                  borderRadius: 10,
                  padding: '11px 14px',
                  fontSize: '0.9rem',
                  color: '#e2e8f0',
                  outline: 'none',
                  transition: 'border-color 0.15s',
                  boxShadow: emailFocused ? '0 0 0 3px rgba(59,130,246,0.12)' : 'none',
                }}
              />
            </div>

            {/* Password field */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label
                htmlFor="password"
                style={{ fontSize: '0.75rem', fontWeight: 600, color: '#64748b', letterSpacing: '0.04em' }}
              >
                PASSWORD
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onFocus={() => setPasswordFocused(true)}
                onBlur={() => setPasswordFocused(false)}
                placeholder="••••••••"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  background: '#0d0f15',
                  border: `1px solid ${passwordFocused ? '#3b82f6' : 'rgba(42,47,69,0.6)'}`,
                  borderRadius: 10,
                  padding: '11px 14px',
                  fontSize: '0.9rem',
                  color: '#e2e8f0',
                  outline: 'none',
                  transition: 'border-color 0.15s',
                  boxShadow: passwordFocused ? '0 0 0 3px rgba(59,130,246,0.12)' : 'none',
                }}
              />
            </div>

            {/* Error message */}
            {error && (
              <div
                role="alert"
                style={{
                  padding: '10px 14px',
                  borderRadius: 8,
                  background: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.22)',
                  color: '#f87171',
                  fontSize: '0.85rem',
                  lineHeight: 1.5,
                }}
              >
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={isSubmitting}
              style={{
                marginTop: 4,
                width: '100%',
                padding: '12px 20px',
                borderRadius: 10,
                background: isSubmitting
                  ? 'rgba(59,130,246,0.5)'
                  : 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)',
                border: 'none',
                color: '#fff',
                fontSize: '0.95rem',
                fontWeight: 700,
                letterSpacing: '-0.01em',
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
                boxShadow: isSubmitting
                  ? 'none'
                  : '0 4px 20px -4px rgba(59,130,246,0.55), 0 0 0 1px rgba(59,130,246,0.3)',
                transition: 'background 0.15s, box-shadow 0.15s, opacity 0.15s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              {isSubmitting ? (
                <>
                  <SpinnerInline />
                  Signing in…
                </>
              ) : (
                'Sign In'
              )}
            </button>
          </form>
        </div>

        {/* Footer */}
        <p
          style={{
            textAlign: 'center',
            marginTop: 20,
            fontSize: '0.75rem',
            color: '#1e293b',
          }}
        >
          Granite CRAG &middot; v1.0
        </p>
      </div>
    </div>
  );
}

/* ─── Inline spinner used inside the button ─────────────── */

function SpinnerInline() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      style={{
        width: 16,
        height: 16,
        animation: 'spin 0.75s linear infinite',
      }}
    >
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="rgba(255,255,255,0.25)"
        strokeWidth="3"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="white"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
