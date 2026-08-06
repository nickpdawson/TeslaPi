import { useEffect } from 'preact/hooks';
import Router, { route } from 'preact-router';
import { Shell } from './components/layout/Shell';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { Dashboard } from './components/dashboard/Dashboard';
import { DashcamPage } from './components/dashcam/DashcamPage';
import { Settings } from './components/config/Settings';
import { LogViewer } from './components/diagnostics/LogViewer';
import { FileBrowser } from './components/files/FileBrowser';
import { MusicPage } from './components/music/MusicPage';
import { NetworkPage } from './components/network/NetworkPage';
import { SetupWizard } from './components/setup/SetupWizard';
import { LoginScreen } from './components/auth/LoginScreen';
import { setupComplete } from './stores/appState';
import { needsLogin } from './stores/authState';

function AppRouter() {
  useEffect(() => {
    // Watch for setup status resolution
    const checkRedirect = () => {
      if (setupComplete.value === false) {
        const path = window.location.pathname;
        if (path !== '/setup') {
          route('/setup', true);
        }
      }
    };

    // Check immediately and subscribe to changes
    checkRedirect();
    const unsubscribe = setupComplete.subscribe(checkRedirect);
    return unsubscribe;
  }, []);

  return (
    <Router>
      <SetupWizard path="/setup" />
      <ShellRoutes default />
    </Router>
  );
}

function NotFound(_props: { default?: boolean; path?: string }) {
  return (
    <div class="container" style={{ textAlign: 'center', paddingTop: 'var(--space-8)' }}>
      <h2 style={{ marginBottom: 'var(--space-3)' }}>Page not found</h2>
      <p class="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        That page doesn’t exist.
      </p>
      <button class="btn btn--primary" onClick={() => route('/')}>
        Go to Dashboard
      </button>
    </div>
  );
}

function ShellRoutes(_props: { default?: boolean; path?: string }) {
  // If setup hasn't been checked yet, show nothing (brief flash)
  if (setupComplete.value === null) {
    return null;
  }

  // Auth gate: once a password is set, an unauthenticated browser sees only the login
  // screen. Dormant when auth isn't configured (needsLogin stays false).
  if (needsLogin.value) {
    return <LoginScreen />;
  }

  return (
    <Shell>
      <Router>
        <Dashboard path="/" />
        <DashcamPage path="/dashcam" />
        <MusicPage path="/music" />
        <FileBrowser path="/files" />
        <NetworkPage path="/network" />
        <Settings path="/settings" />
        <LogViewer path="/logs" />
        <NotFound default />
      </Router>
    </Shell>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <AppRouter />
    </ErrorBoundary>
  );
}
