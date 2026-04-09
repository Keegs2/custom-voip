import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { FormField } from '../../components/ui/FormField';
import type { SippRunConfig } from '../../types/sipp';

interface SippCustomFormProps {
  isRunning: boolean;
  onRun: (config: Partial<SippRunConfig>) => void;
}

export function SippCustomForm({ isRunning, onRun }: SippCustomFormProps) {
  const [open, setOpen] = useState(false);

  const [target, setTarget] = useState('9196');
  const [rate, setRate] = useState('100');
  const [calls, setCalls] = useState('1000');
  const [timeout, setTimeout_] = useState('60');
  const [duration, setDuration] = useState('0');

  function handleRun() {
    onRun({
      remote_host: target.trim() || '9196',
      call_rate: parseInt(rate, 10) || 100,
      call_limit: parseInt(calls, 10) || 1000,
      duration_seconds: parseInt(timeout, 10) || 60,
      // duration here is the call duration in ms — passed as extra_args or scenario-specific
    });
  }

  return (
    <div
      style={{
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 16,
        overflow: 'hidden',
        background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
      }}
    >
      {/* Collapsible header */}
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 24px',
          background: 'rgba(19,21,29,0.5)',
          fontSize: '0.9rem',
          fontWeight: 600,
          color: '#e2e8f0',
          cursor: 'pointer',
          border: 'none',
          transition: 'background 0.15s',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.03)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = 'rgba(19,21,29,0.5)';
        }}
      >
        <span>Custom Test</span>
        <span
          style={{
            color: '#718096',
            fontSize: '0.875rem',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.2s',
          }}
        >
          &#x25BC;
        </span>
      </button>

      {/* Collapsible body */}
      {open && (
        <div
          style={{
            padding: '20px 24px',
            borderTop: '1px solid rgba(42,47,69,0.6)',
          }}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-5">
            <FormField
              label="Target (host:port or extension)"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="9196 or sip.example.com:5060"
            />
            <FormField
              label="CPS Rate"
              type="number"
              min="1"
              max="500"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
            <FormField
              label="Total Calls"
              type="number"
              min="1"
              max="10000"
              value={calls}
              onChange={(e) => setCalls(e.target.value)}
            />
            <FormField
              label="Timeout (s)"
              type="number"
              min="5"
              max="120"
              value={timeout}
              onChange={(e) => setTimeout_(e.target.value)}
            />
            <FormField
              label="Call Duration (ms)"
              type="number"
              min="0"
              max="30000"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </div>

          <Button
            disabled={isRunning}
            loading={isRunning}
            onClick={handleRun}
          >
            Run Custom Test
          </Button>
        </div>
      )}
    </div>
  );
}
