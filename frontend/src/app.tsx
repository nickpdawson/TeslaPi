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
import { setupComplete } from './stores/appState';

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

function ShellRoutes(_props: { default?: boolean; path?: string }) {
  // If setup hasn't been checked yet, show nothing (brief flash)
  if (setupComplete.value === null) {
    return null;
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
