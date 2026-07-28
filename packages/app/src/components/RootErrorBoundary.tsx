import { Component, CSSProperties, ErrorInfo, ReactNode } from "react";

/**
 * Last-resort error boundary wrapping the entire tree, including
 * ChakraProvider — so it must NOT use Chakra: if theme/provider init is what
 * threw, this still has to render. Uses the existing .error-page styles from
 * index.css. Render/lifecycle throws in App or the providers land here (the
 * router's errorElement only covers throws inside routes); module-init and
 * bundle-load failures are handled earlier by public/boot-recovery.js.
 */

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

class RootErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[RootErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const { error } = this.state;
    return (
      <div className="error-page">
        <h1>Something went wrong</h1>
        <pre className="error-page-pre">{error.message || String(error)}</pre>
        <div style={{ marginTop: 16, display: "flex", gap: 12 }}>
          <button
            style={buttonStyle}
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
          <button
            style={buttonStyle}
            onClick={() => {
              if (window.__pwRepair) {
                window.__pwRepair();
              } else {
                window.location.reload();
              }
            }}
          >
            Repair &amp; reload
          </button>
        </div>
        <pre className="error-page-stack">{error.stack}</pre>
      </div>
    );
  }
}

const buttonStyle: CSSProperties = {
  background: "#2b6cb0",
  color: "#fff",
  border: 0,
  borderRadius: 6,
  padding: "8px 16px",
  fontFamily: "inherit",
  fontSize: 14,
  cursor: "pointer",
};

export default RootErrorBoundary;
