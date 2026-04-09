import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { listRcf, createRcfEntry, updateRcfEntry, deleteRcfEntry } from '../../api/rcf';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/ToastContext';
import type { RcfEntry } from '../../types/rcf';

interface CustomerRcfSectionProps {
  customerId: number;
}

// Inline editable forward-to field for a single RCF row
function RcfForwardInput({
  entry,
  customerId,
}: {
  entry: RcfEntry;
  customerId: number;
}) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [value, setValue] = useState(entry.forward_to);
  const [saved, setSaved] = useState(false);

  const mutation = useMutation({
    mutationFn: (fwd: string) => updateRcfEntry(entry.id, { forward_to: fwd }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customerRcf', customerId] });
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      toastOk(`Forward updated for ${entry.did}`);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleBlur() {
    const trimmed = value.trim();
    if (!trimmed) {
      toastErr('Destination cannot be empty');
      setValue(entry.forward_to);
      return;
    }
    if (trimmed !== entry.forward_to) {
      mutation.mutate(trimmed);
    }
  }

  return (
    <input
      type="tel"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={handleBlur}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      onClick={(e) => e.stopPropagation()}
      disabled={mutation.isPending}
      placeholder="+1XXXXXXXXXX"
      className={[
        'text-[0.82rem] px-2 py-[4px] rounded-md w-full max-w-[180px]',
        'border bg-[#0d0f15] text-[#e2e8f0] outline-none',
        'transition-[border-color,box-shadow] duration-150',
        'focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.2)]',
        'placeholder:text-[#718096] disabled:opacity-50',
        saved
          ? 'border-green-500/50 text-green-400'
          : 'border-[#2a2f45]',
      ].join(' ')}
    />
  );
}

export function CustomerRcfSection({ customerId }: CustomerRcfSectionProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toastOk, toastErr } = useToast();

  const [newDid, setNewDid] = useState('');
  const [newFwd, setNewFwd] = useState('');
  const [passCid, setPassCid] = useState(true);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['customerRcf', customerId],
    queryFn: () => listRcf({ customer_id: customerId, limit: 200 }),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      updateRcfEntry(id, { enabled }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['customerRcf', customerId] });
      toastOk(vars.enabled ? 'RCF number enabled' : 'RCF number disabled');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteRcfEntry(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customerRcf', customerId] });
      toastOk('RCF number deleted');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createRcfEntry({
        customer_id: customerId,
        did: newDid.trim(),
        forward_to: newFwd.trim(),
        pass_caller_id: passCid,
        ring_timeout: 30,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customerRcf', customerId] });
      setNewDid('');
      setNewFwd('');
      setPassCid(true);
      toastOk('RCF number created');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!newDid.trim()) { toastErr('DID is required'); return; }
    if (!newFwd.trim()) { toastErr('Forward-to is required'); return; }
    createMutation.mutate();
  }

  function handleDelete(entry: RcfEntry) {
    if (!confirm(`Delete ${entry.did}?\n\nThis cannot be undone.`)) return;
    deleteMutation.mutate(entry.id);
  }

  const entries = data?.items ?? [];

  return (
    <div style={{ paddingTop: 16, borderTop: '1px solid rgba(42,47,69,0.5)' }}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[0.65rem] font-bold text-[#4a5568] uppercase tracking-[0.8px]">
          RCF Numbers
        </span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); navigate('/rcf'); }}
          className="text-[0.72rem] text-[#3b82f6] hover:underline"
        >
          Manage RCF Numbers
        </button>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-[#718096] text-[0.8rem] py-2">
          <Spinner size="xs" /> Loading…
        </div>
      )}

      {isError && (
        <p className="text-red-400 text-[0.8rem]">Could not load RCF numbers.</p>
      )}

      {!isLoading && !isError && entries.length === 0 && (
        <p className="text-[#718096] text-[0.8rem]">No RCF numbers yet.</p>
      )}

      {!isLoading && entries.length > 0 && (
        <table className="w-full text-[0.8rem] border-collapse">
          <thead>
            <tr>
              {['DID', 'Forward To', 'Status', ''].map((h) => (
                <th
                  key={h}
                  className="text-left px-2 py-[5px] text-[0.65rem] font-bold uppercase tracking-[0.6px] text-[#718096] border-b border-[#2a2f45]"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className="border-b border-[#2a2f45]/40 last:border-0">
                <td className="px-2 py-[6px] font-mono whitespace-nowrap text-[#e2e8f0]">
                  {entry.did}
                </td>
                <td className="px-2 py-[6px]">
                  <RcfForwardInput entry={entry} customerId={customerId} />
                </td>
                <td className="px-2 py-[6px]">
                  <Badge variant={entry.enabled ? 'active' : 'disabled'}>
                    {entry.enabled ? 'Active' : 'Off'}
                  </Badge>
                </td>
                <td className="px-2 py-[6px]">
                  <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleMutation.mutate({ id: entry.id, enabled: !entry.enabled });
                      }}
                    >
                      {entry.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    <Button
                      variant="danger"
                      size="xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(entry);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Add RCF Number form */}
      <form
        onSubmit={handleCreate}
        onClick={(e) => e.stopPropagation()}
        style={{
          marginTop: 12,
          padding: '12px',
          background: 'rgba(19,21,29,0.7)',
          border: '1px solid rgba(42,47,69,0.6)',
          borderRadius: 10,
        }}
      >
        <div className="text-[0.65rem] font-bold text-[#718096] uppercase tracking-[0.7px] mb-2">
          Add RCF Number
        </div>
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-[0.65rem] font-bold text-[#718096] uppercase tracking-[0.6px]">
              DID
            </label>
            <input
              type="tel"
              value={newDid}
              onChange={(e) => setNewDid(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder="+1XXXXXXXXXX"
              className="text-[0.83rem] px-2 py-[5px] rounded-lg w-[160px] border border-[#2a2f45] bg-[#0d0f15] text-[#e2e8f0] outline-none focus:border-[#3b82f6] placeholder:text-[#718096]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[0.65rem] font-bold text-[#718096] uppercase tracking-[0.6px]">
              Forward To
            </label>
            <input
              type="tel"
              value={newFwd}
              onChange={(e) => setNewFwd(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder="+1XXXXXXXXXX"
              className="text-[0.83rem] px-2 py-[5px] rounded-lg w-[160px] border border-[#2a2f45] bg-[#0d0f15] text-[#e2e8f0] outline-none focus:border-[#3b82f6] placeholder:text-[#718096]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[0.65rem] font-bold text-[#718096] uppercase tracking-[0.6px]">
              Pass CID
            </label>
            <div className="flex items-center gap-1.5 py-[6px]">
              <input
                type="checkbox"
                checked={passCid}
                onChange={(e) => setPassCid(e.target.checked)}
                onClick={(e) => e.stopPropagation()}
                className="accent-[#3b82f6] w-[14px] h-[14px]"
              />
              <span className="text-[0.82rem] text-[#718096]">Yes</span>
            </div>
          </div>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={createMutation.isPending}
            onClick={(e) => e.stopPropagation()}
          >
            Create
          </Button>
        </div>
      </form>
    </div>
  );
}
