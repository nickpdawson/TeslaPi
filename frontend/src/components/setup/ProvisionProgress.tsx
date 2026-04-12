import { useEffect, useRef, useState } from 'preact/hooks';
import { get, post } from '../../api/client';
import type { SetupProvisionProgress } from '../../api/types';

const STEP_NAMES = [
  'Source configuration',
  'Validate prerequisites',
  'Configure kernel modules',
  'Partition external drive',
  'Format and mount partitions',
  'Create backing file images',
  'Configure mount points',
  'Install gadget scripts',
  'Install archive loop',
  'Configure archive backend',
  'Check web service',
  'Write completion marker',
  'Summary',
];

interface ProvisionProgressProps {
  onComplete: () => void;
  onError: (error: string) => void;
}

export function ProvisionProgress({ onComplete, onError }: ProvisionProgressProps) {
  const [progress, setProgress] = useState<SetupProvisionProgress | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [cancelling, setCancelling] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    // Poll progress every second
    const poll = async () => {
      try {
        const data = await get<SetupProvisionProgress>('/setup/provision/progress');
        setProgress(data);

        // Check for completion
        if (!data.running && data.overallProgress >= 1 && !data.error) {
          if (pollRef.current) clearInterval(pollRef.current);
          onComplete();
          return;
        }

        // Check for error
        if (data.error && !data.running) {
          if (pollRef.current) clearInterval(pollRef.current);
          onError(data.error);
          return;
        }
      } catch {
        // Ignore transient errors during polling
      }

      // Also fetch log tail
      try {
        const logData = await get<{ log: string }>('/setup/provision/log?lines=15');
        if (logData.log) {
          setLogLines(logData.log.split('\n').filter((l: string) => l.trim()));
        }
      } catch {
        // Ignore
      }
    };

    poll();
    pollRef.current = setInterval(poll, 1500);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [onComplete, onError]);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines]);

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await post('/setup/provision/cancel');
    } catch {
      // Ignore
    }
  };

  const currentStep = progress?.step ?? 0;
  const overallPct = Math.round((progress?.overallProgress ?? 0) * 100);
  const stepPct = Math.round((progress?.progress ?? 0) * 100);

  return (
    <div class="setup-step">
      <h2 class="setup-step__title">Hardware Provisioning</h2>
      <p class="setup-step__description">
        Setting up your Pi's USB drives and gadget configuration. This will take several minutes.
      </p>

      {/* Overall progress bar */}
      <div class="provision-progress">
        <div class="provision-progress__header">
          <span class="provision-progress__label">Overall Progress</span>
          <span class="provision-progress__pct">{overallPct}%</span>
        </div>
        <div class="provision-progress__bar">
          <div
            class="provision-progress__fill"
            style={{ width: `${overallPct}%` }}
          />
        </div>
      </div>

      {/* Step list */}
      <div class="provision-steps">
        {STEP_NAMES.map((name, idx) => {
          const stepNum = idx + 1;
          let stepClass = 'provision-step';
          if (stepNum < currentStep) stepClass += ' provision-step--done';
          else if (stepNum === currentStep) stepClass += ' provision-step--active';

          return (
            <div class={stepClass} key={stepNum}>
              <div class="provision-step__indicator">
                {stepNum < currentStep ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : stepNum === currentStep ? (
                  <div class="provision-step__spinner" />
                ) : (
                  <span>{stepNum}</span>
                )}
              </div>
              <div class="provision-step__label">
                {name}
                {stepNum === currentStep && stepPct > 0 && stepPct < 100 && (
                  <span class="provision-step__sub-pct"> ({stepPct}%)</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Current action */}
      {progress?.currentAction && (
        <div class="provision-action">
          {progress.currentAction}
        </div>
      )}

      {/* Log tail */}
      <div class="provision-log">
        <div class="provision-log__header">Log Output</div>
        <pre class="provision-log__content" ref={logRef}>
          {logLines.length > 0
            ? logLines.join('\n')
            : 'Waiting for output...'}
        </pre>
      </div>

      {/* Cancel button */}
      <div class="provision-footer">
        <span class="provision-footer__hint">
          Do not disconnect or power off the Pi during provisioning.
        </span>
        <button
          class="setup-nav__btn setup-nav__btn--back"
          onClick={handleCancel}
          disabled={cancelling || (progress !== null && !progress.running)}
        >
          {cancelling ? 'Cancelling...' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}
