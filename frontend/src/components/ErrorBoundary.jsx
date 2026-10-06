import { Component } from 'react';
import { reportClientError } from '../utils/errorReporting';

// Phase 7.3: catches a React render-time crash anywhere below it, reports it
// (see utils/errorReporting.js), and shows a plain, honest "something went
// wrong" screen with a reload action instead of a blank white page - the
// previous behavior for any uncaught render error.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    reportClientError({
      message: error?.message || 'Unknown render error',
      stack: `${error?.stack || ''}\n${info?.componentStack || ''}`,
      source: 'react-error-boundary',
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="d-flex flex-column align-items-center justify-content-center text-center p-5" style={{ minHeight: '60vh' }}>
          <h4>Something went wrong</h4>
          <p className="text-body-secondary">
            This has been reported. Reloading the page usually fixes it.
          </p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
