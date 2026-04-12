import { Component } from 'preact';
import type { ComponentChildren } from 'preact';

interface ErrorBoundaryProps {
  children: ComponentChildren;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  showDetails: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, showDetails: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: { componentStack?: string }) {
    console.error('[ErrorBoundary]', error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, showDetails: false });
  };

  toggleDetails = () => {
    this.setState((prev) => ({ showDetails: !prev.showDetails }));
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const { error, showDetails } = this.state;

    return (
      <div class="error-boundary">
        <div class="error-boundary__card">
          <div class="error-boundary__icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--color-error)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>

          <h2 class="error-boundary__title">Something went wrong</h2>
          <p class="error-boundary__message">
            An unexpected error occurred while rendering this section. You can try
            reloading the component or return to the dashboard.
          </p>

          <div class="error-boundary__actions">
            <button class="error-boundary__btn error-boundary__btn--primary" onClick={this.handleRetry}>
              Try Again
            </button>
            <a href="/" class="error-boundary__btn error-boundary__btn--secondary">
              Go to Dashboard
            </a>
          </div>

          {error && (
            <div class="error-boundary__details-section">
              <button class="error-boundary__details-toggle" onClick={this.toggleDetails}>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  style={{
                    transform: showDetails ? 'rotate(90deg)' : 'rotate(0deg)',
                    transition: 'transform var(--transition-fast)',
                  }}
                >
                  <polyline points="6,4 10,8 6,12" />
                </svg>
                Error details
              </button>
              {showDetails && (
                <pre class="error-boundary__details">
                  <code>{error.name}: {error.message}{'\n'}{error.stack}</code>
                </pre>
              )}
            </div>
          )}
        </div>

        <style>{`
          .error-boundary {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: var(--space-8) var(--space-4);
            min-height: 300px;
          }

          .error-boundary__card {
            background: var(--color-card);
            border: 1px solid var(--color-border);
            border-radius: var(--radius-lg);
            padding: var(--space-8);
            max-width: 480px;
            width: 100%;
            text-align: center;
            box-shadow: var(--shadow-card);
          }

          .error-boundary__icon {
            margin-bottom: var(--space-4);
          }

          .error-boundary__title {
            font-size: var(--text-xl);
            font-weight: var(--font-weight-semibold);
            color: var(--color-text);
            margin-bottom: var(--space-2);
          }

          .error-boundary__message {
            font-size: var(--text-sm);
            color: var(--color-text-secondary);
            line-height: var(--leading-relaxed);
            margin-bottom: var(--space-6);
          }

          .error-boundary__actions {
            display: flex;
            flex-direction: row;
            justify-content: center;
            margin-bottom: var(--space-4);
          }

          .error-boundary__actions > * + * {
            margin-left: var(--space-3);
          }

          .error-boundary__btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: var(--space-2) var(--space-5);
            border-radius: var(--radius-md);
            font-size: var(--text-sm);
            font-weight: var(--font-weight-medium);
            text-decoration: none;
            transition: background var(--transition-fast), border-color var(--transition-fast);
            cursor: pointer;
            border: 1px solid transparent;
          }

          .error-boundary__btn--primary {
            background: var(--color-accent);
            color: white;
          }

          .error-boundary__btn--primary:hover {
            background: var(--color-accent-hover);
            text-decoration: none;
          }

          .error-boundary__btn--secondary {
            background: transparent;
            color: var(--color-text-secondary);
            border-color: var(--color-border);
          }

          .error-boundary__btn--secondary:hover {
            background: var(--color-card-hover);
            text-decoration: none;
          }

          .error-boundary__details-section {
            margin-top: var(--space-4);
            border-top: 1px solid var(--color-border);
            padding-top: var(--space-4);
            text-align: left;
          }

          .error-boundary__details-toggle {
            display: inline-flex;
            align-items: center;
            font-size: var(--text-sm);
            color: var(--color-text-muted);
            background: none;
            border: none;
            cursor: pointer;
            padding: var(--space-1) 0;
            min-height: auto;
            min-width: auto;
          }

          .error-boundary__details-toggle > svg {
            margin-right: var(--space-2);
          }

          .error-boundary__details-toggle:hover {
            color: var(--color-text-secondary);
          }

          .error-boundary__details {
            margin-top: var(--space-3);
            padding: var(--space-3);
            background: var(--color-bg);
            border: 1px solid var(--color-border);
            border-radius: var(--radius-sm);
            font-family: var(--font-mono);
            font-size: var(--text-xs);
            color: var(--color-error);
            overflow-x: auto;
            white-space: pre-wrap;
            word-break: break-word;
            max-height: 200px;
            overflow-y: auto;
          }
        `}</style>
      </div>
    );
  }
}
