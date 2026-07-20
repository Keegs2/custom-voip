/**
 * App-wide error containment (P0 availability fix — 2026-07 platform audit).
 *
 * Without a boundary, React unmounts the ENTIRE tree when a render/lifecycle
 * error escapes to the root — on this platform that white-screens an ops
 * console mid-incident and tears down the softphone UI during an active call.
 * Boundaries are layered:
 *
 *   1. Root      (main.tsx)                 — last resort, full-page fallback.
 *   2. Route     (AppLayout / App routes)   — one page crashes, the sidebar +
 *                                             softphone survive; auto-resets on
 *                                             navigation via `resetKey`.
 *   3. Softphone (SoftphoneWidget)          — call controls isolated from page
 *                                             bugs and vice versa.
 *
 * Error boundaries MUST be class components — React 19 still has no hook
 * equivalent of getDerivedStateFromError / componentDidCatch.
 */
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Renders the fallback UI. `reset` clears the error AND remounts the child
   * subtree with a fresh key, discarding whatever corrupted local state
   * crashed it (a plain re-render of the same instances would often re-throw).
   */
  fallback: (error: Error, reset: () => void) => ReactNode;
  /**
   * When this value changes while an error is showing, the boundary resets
   * automatically. Pass the route pathname so simply navigating away from a
   * crashed page recovers without any user action.
   */
  resetKey?: string;
  /** Identifies WHICH layer caught the error in console diagnostics. */
  scope: string;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** Bumped on every reset so children remount from scratch. */
  generation: number;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, generation: 0 };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is the report channel available in every deployment (no
    // telemetry backend yet); the fallback UI offers copy-to-clipboard so ops
    // can paste the same diagnostics into an incident report.
    console.error(
      `[ErrorBoundary:${this.props.scope}] caught render error`,
      error,
      info.componentStack ?? '(no component stack)',
    );
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.error !== null && prevProps.resetKey !== this.props.resetKey) {
      this.reset();
    }
  }

  private reset = (): void => {
    this.setState((s) => ({ error: null, generation: s.generation + 1 }));
  };

  render(): ReactNode {
    if (this.state.error !== null) {
      return this.props.fallback(this.state.error, this.reset);
    }
    return <Fragment key={this.state.generation}>{this.props.children}</Fragment>;
  }
}
