import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { FormField } from '../../components/ui/FormField';
import { cn } from '../../utils/cn';
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
    <div className="border border-[#2a2f45] rounded-xl overflow-hidden">
      {/* Collapsible header */}
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className={cn(
          'w-full flex items-center justify-between px-5 py-3.5',
          'bg-[#1e2130] text-[0.9rem] font-semibold text-[#e2e8f0]',
          'hover:bg-white/[0.03] transition-colors duration-150',
        )}
      >
        <span>Custom Test</span>
        <span
          className={cn(
            'text-[#718096] transition-transform duration-200 text-sm',
            open && 'rotate-180',
          )}
        >
          &#x25BC;
        </span>
      </button>

      {/* Collapsible body */}
      {open && (
        <div className="bg-[#1a1d27] px-5 py-5 border-t border-[#2a2f45]">
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
