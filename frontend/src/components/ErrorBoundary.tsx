import { Component, type ReactNode } from 'react';

/** Contains render errors to one view instead of unmounting the whole app. */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="m-4 rounded-lg border border-danger/40 bg-danger/10 p-4">
        <p className="mb-1 font-semibold text-danger">Something went wrong in {this.props.label ?? 'this view'}.</p>
        <pre className="selectable mb-3 whitespace-pre-wrap font-mono text-xs text-muted">{this.state.error.message}</pre>
        <button className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
