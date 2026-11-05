import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null };

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('File Structure Auditor render error', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return <main className="pl-app runtime-error-page">
      <section className="runtime-error-card">
        <h1>Не удалось открыть страницу</h1>
        <button className="primary-button" type="button" onClick={() => window.location.reload()}>
          Перезагрузить
        </button>
      </section>
    </main>;
  }
}
