/**
 * ConversationErrorBoundary — catches render errors inside ConversationView
 * (and any child widget) so a single bad event or missing prop doesn't blank
 * the entire right pane and hide the Conversation/Terminal toggle.
 *
 * The error UI is intentionally minimal — a small banner with the error
 * message and a "Reload" button that re-mounts the view. We log the error
 * to the console so users can copy it into a bug report.
 *
 * Why a class component? React only supports error boundaries via the
 * componentDidCatch / getDerivedStateFromError lifecycle hooks, which
 * function components can't use directly. Hooks-based error boundaries
 * exist as third-party libraries but it's not worth a dep for ~30 lines.
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Optional fallback override. Receives the caught error. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

export class ConversationErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Visible in the browser console alongside the React-injected stack so
    // engineers can grep for [ConversationErrorBoundary] when triaging.
    // eslint-disable-next-line no-console
    console.error('[ConversationErrorBoundary] caught render error', error, info);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="conv-error-boundary" role="alert">
        <div className="conv-error-boundary-icon">⚠️</div>
        <div className="conv-error-boundary-body">
          <div className="conv-error-boundary-title">Conversation view crashed</div>
          <div className="conv-error-boundary-msg">{error.message || 'Unknown error'}</div>
          <button
            type="button"
            className="conv-error-boundary-retry"
            onClick={this.reset}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
