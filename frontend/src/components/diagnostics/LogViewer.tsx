import { useState, useEffect, useRef, useCallback } from 'preact/hooks';

interface LogViewerProps {
  path?: string;
}

const LOG_TABS = [
  { key: 'archive', label: 'Archive' },
  { key: 'teslausb', label: 'TeslaUSB' },
  { key: 'syslog', label: 'System' },
  { key: 'kern', label: 'Kernel' },
];

function classifyLogLevel(line: string): 'error' | 'warning' | 'info' | 'default' {
  const lower = line.toLowerCase();
  if (lower.includes('error') || lower.includes('fatal') || lower.includes('crit') || lower.includes('fail')) {
    return 'error';
  }
  if (lower.includes('warn') || lower.includes('warning')) {
    return 'warning';
  }
  if (lower.includes('info') || lower.includes('notice')) {
    return 'info';
  }
  return 'default';
}

function getLogLineClass(level: string): string {
  switch (level) {
    case 'error': return 'log-line--error';
    case 'warning': return 'log-line--warning';
    default: return '';
  }
}

export function LogViewer(_props: LogViewerProps) {
  const [activeLog, setActiveLog] = useState('archive');
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState('');
  const logContainerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const connectWebSocket = useCallback((logName: string) => {
    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close();
    }

    setLines([]);
    setConnected(false);

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/api/ws/logs/${logName}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onmessage = (event) => {
      setLines(prev => {
        const next = [...prev, event.data];
        // Keep max 2000 lines in buffer
        if (next.length > 2000) {
          return next.slice(next.length - 2000);
        }
        return next;
      });
    };

    ws.onclose = () => {
      setConnected(false);
    };

    ws.onerror = () => {
      setConnected(false);
    };
  }, []);

  useEffect(() => {
    connectWebSocket(activeLog);
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [activeLog, connectWebSocket]);

  // Auto-scroll effect
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  function handleScroll() {
    if (!logContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current;
    // If user scrolled up more than 50px from bottom, pause auto-scroll
    const atBottom = scrollHeight - scrollTop - clientHeight < 50;
    if (autoScroll && !atBottom) {
      setAutoScroll(false);
    }
  }

  function handleDownload() {
    const content = lines.join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `teslapi-${activeLog}-${new Date().toISOString().slice(0, 10)}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const filteredLines = filter
    ? lines.filter(l => l.toLowerCase().includes(filter.toLowerCase()))
    : lines;

  return (
    <div class="container animate-fade-in">
      <div class="settings-page-header">
        <h2 class="settings-page-title">System Logs</h2>
        <p class="settings-page-subtitle">Live log streaming from TeslaPi</p>
      </div>

      <div class="log-viewer">
        {/* Tab bar */}
        <div class="log-tabs">
          {LOG_TABS.map(tab => (
            <button
              key={tab.key}
              class={`log-tab ${activeLog === tab.key ? 'log-tab--active' : ''}`}
              onClick={() => setActiveLog(tab.key)}
            >
              {tab.label}
            </button>
          ))}

          <div class="log-tabs__spacer" />

          <span class={`log-status ${connected ? 'log-status--connected' : 'log-status--disconnected'}`}>
            <span class="log-status__dot" />
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>

        {/* Toolbar */}
        <div class="log-toolbar">
          <div class="log-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              class="log-search__input"
              value={filter}
              onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
              placeholder="Filter logs..."
            />
          </div>

          <div class="log-toolbar__actions">
            <label class="log-auto-scroll">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => {
                  setAutoScroll((e.target as HTMLInputElement).checked);
                  if ((e.target as HTMLInputElement).checked && logContainerRef.current) {
                    logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
                  }
                }}
              />
              <span>Auto-scroll</span>
            </label>

            <button class="btn btn--ghost btn--sm" onClick={handleDownload}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="7,10 12,15 17,10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download
            </button>
          </div>
        </div>

        {/* Log output */}
        <div
          class="log-output"
          ref={logContainerRef}
          onScroll={handleScroll}
        >
          {filteredLines.length === 0 && (
            <div class="log-empty">
              {connected ? 'Waiting for log output...' : 'Connecting to log stream...'}
            </div>
          )}
          {filteredLines.map((line, idx) => {
            const level = classifyLogLevel(line);
            return (
              <div key={idx} class={`log-line ${getLogLineClass(level)}`}>
                {line}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
