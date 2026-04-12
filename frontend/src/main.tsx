import { render } from 'preact';
import './styles/global.css';
import './styles/layout.css';
import './styles/settings.css';
import './styles/files.css';
import './styles/dashcam.css';
import './styles/music.css';
import './styles/network.css';
import './styles/setup.css';
import { App } from './app.tsx';

// Theme is initialized in appState.ts (sets data-theme on documentElement)
import './stores/appState';

render(<App />, document.getElementById('app')!);
