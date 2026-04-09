import { useState, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { RcfEntry } from '../types/rcf';
import { apiRequest } from '../api/client';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { useToast } from '../components/ui/Toast';
import { fmt } from '../utils/format';
import { cn } from '../utils/cn';

interface RcfCardProps {
  entry: RcfEntry;
  /** Controlled edit value from parent's pendingEdits state */
  pendingValue: string;
  onPendingChange: (did: string, value: string) => void;
}

interface RcfUpdatePayload {
  forward_to: string;
}

async function updateRcfForwardTo(did: string, payload: RcfUpdatePayload): Promise<RcfEntry> {
  return apiRequest('PUT', `/rcf/${encodeURIComponent(did)}`, payload);
}

export function RcfCard({ entry, pendingValue, onPendingChange }: RcfCardProps) {
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();

  // Track whether the save just succeeded for the green flash animation
  const [savedFlash, setSavedFlash] = useState(false);

  const isDirty = pendingValue !== entry.forward_to && pendingValue !== '';
  const isEmpty = pendingValue.trim() === '';

  const mutation = useMutation({
    mutationFn: (newValue: string) =>
      updateRcfForwardTo(entry.did, { forward_to: newValue.trim() }),

    onSuccess: (_data, newValue) => {
      // Invalidate the RCF list so the updated entry refreshes
      void queryClient.invalidateQueries({ queryKey: ['rcf'] });

      // Reset the pending edit back to the saved value
      onPendingChange(entry.did, newValue.trim());

      // Show success flash then clear it after 1800ms
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1800);

      toastOk(`Saved — calls to ${fmt(entry.did)} now ring ${fmt(newValue.trim())}`);
    },

    onError: (error: Error) => {
      toastErr(error.message ?? 'Failed to save');
    },
  });

  const handleSave = useCallback(() => {
    const trimmed = pendingValue.trim();
    if (!trimmed) {
      toastErr('Destination cannot be empty');
      return;
    }
    mutation.mutate(trimmed);
  }, [pendingValue, mutation, toastErr]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') handleSave();
    },
    [handleSave],
  );

  return (
    <div
      className={cn(
        'bg-[#1a1d27] border rounded-xl p-5',
        'shadow-[0_1px_3px_rgba(0,0,0,.4)]',
        'transition-all duration-300',
        savedFlash
          ? 'border-emerald-500/60 shadow-[0_0_0_3px_rgba(34,197,94,0.15)]'
          : 'border-[#2a2f45]',
      )}
    >
      {/* Card header: formatted DID + status badge */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <div className="text-[1.2rem] font-bold text-[#e2e8f0] leading-snug truncate">
            {fmt(entry.did)}
          </div>
          <div className="text-[0.72rem] font-mono text-[#718096] mt-0.5">
            {entry.did}
          </div>
        </div>
        <div className="flex-shrink-0 mt-0.5">
          <Badge variant={entry.enabled ? 'active' : 'disabled'}>
            {entry.enabled ? 'Active' : 'Disabled'}
          </Badge>
        </div>
      </div>

      {/* Forward-to action area */}
      <div>
        <label
          htmlFor={`rcf-fwd-${entry.id}`}
          className="block text-[0.7rem] font-bold text-[#718096] uppercase tracking-[0.7px] mb-1.5"
        >
          Forward Calls To
        </label>

        <div className="flex gap-2 items-center">
          <input
            id={`rcf-fwd-${entry.id}`}
            type="tel"
            value={pendingValue}
            placeholder="+18005559999"
            onChange={(e) => onPendingChange(entry.did, e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={mutation.isPending}
            className={cn(
              'flex-1 min-w-0',
              'text-[0.92rem] px-3 py-[9px] rounded-lg',
              'border bg-[#1e2130] text-[#e2e8f0]',
              'outline-none transition-[border-color,box-shadow] duration-150',
              'placeholder:text-[#718096]',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              savedFlash
                ? 'border-[#22c55e] shadow-[0_0_0_3px_rgba(34,197,94,0.2)]'
                : isDirty
                ? 'border-[#3b82f6] shadow-[0_0_0_3px_rgba(59,130,246,0.2)]'
                : 'border-[#2a2f45] focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.28)]',
            )}
          />

          <Button
            variant="success"
            size="sm"
            disabled={!isDirty || isEmpty || mutation.isPending}
            onClick={handleSave}
            loading={mutation.isPending}
          >
            {mutation.isPending ? <Spinner size="xs" /> : 'Save'}
          </Button>
        </div>

        {/* Info notes below the input */}
        <div className="mt-2 flex flex-col gap-1">
          {entry.pass_caller_id && (
            <InfoNote>Caller ID passed through to destination</InfoNote>
          )}
          <InfoNote>
            Ring timeout:{' '}
            {entry.ring_timeout != null ? `${entry.ring_timeout}s` : '30s'}
          </InfoNote>
        </div>
      </div>
    </div>
  );
}

function InfoNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[0.72rem] text-[#718096]">
      <span
        className={cn(
          'inline-flex items-center justify-center',
          'w-3.5 h-3.5 rounded-full border border-[#718096]/50',
          'text-[0.55rem] font-bold flex-shrink-0',
          'text-[#718096]',
        )}
      >
        i
      </span>
      <span>{children}</span>
    </div>
  );
}
