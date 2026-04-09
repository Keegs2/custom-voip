import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { listApiDids, createApiDid, updateApiDid, deleteApiDid } from '../../api/apiDids';
import { getCustomerTier } from '../../api/tiers';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/ToastContext';
import type { ApiDid } from '../../types/apiDid';

interface CustomerApiSectionProps {
  customerId: number;
}

// Inline editable voice URL field
function ApiDidUrlInput({
  did,
  customerId,
}: {
  did: ApiDid;
  customerId: number;
}) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [value, setValue] = useState(did.voice_url);
  const [saved, setSaved] = useState(false);

  const mutation = useMutation({
    mutationFn: (url: string) => updateApiDid(did.id, { voice_url: url }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customerApiDids', customerId] });
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      toastOk('Voice URL updated');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleBlur() {
    const trimmed = value.trim();
    if (!trimmed) {
      toastErr('Voice URL is required');
      setValue(did.voice_url);
      return;
    }
    if (trimmed !== did.voice_url) {
      mutation.mutate(trimmed);
    }
  }

  return (
    <input
      type="url"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={handleBlur}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      onClick={(e) => e.stopPropagation()}
      disabled={mutation.isPending}
      placeholder="https://example.com/voice"
      className={[
        'text-[0.82rem] px-2 py-[4px] rounded-md w-full max-w-[220px]',
        'border bg-[#0d0f15] text-[#e2e8f0] outline-none',
        'transition-[border-color,box-shadow] duration-150',
        'focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.2)]',
        'placeholder:text-[#718096] disabled:opacity-50',
        saved ? 'border-green-500/50 text-green-400' : 'border-[#2a2f45]',
      ].join(' ')}
    />
  );
}

export function CustomerApiSection({ customerId }: CustomerApiSectionProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toastOk, toastErr } = useToast();

  const [newDid, setNewDid] = useState('');
  const [newUrl, setNewUrl] = useState('');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['customerApiDids', customerId],
    queryFn: () => listApiDids({ customer_id: customerId, limit: 200 }),
  });

  const { data: tierData } = useQuery({
    queryKey: ['customerTier', customerId],
    queryFn: () => getCustomerTier(customerId),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      updateApiDid(id, { enabled }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['customerApiDids', customerId] });
      toastOk(vars.enabled ? 'DID enabled' : 'DID disabled');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteApiDid(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customerApiDids', customerId] });
      toastOk('API DID deleted');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createApiDid({
        customer_id: customerId,
        did: newDid.trim(),
        voice_url: newUrl.trim(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customerApiDids', customerId] });
      setNewDid('');
      setNewUrl('');
      toastOk('API DID created');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!newDid.trim()) { toastErr('DID is required'); return; }
    if (!newUrl.trim()) { toastErr('Voice URL is required'); return; }
    createMutation.mutate();
  }

  function handleDelete(did: ApiDid) {
    if (!confirm(`Delete API DID ${did.did}?\n\nThis cannot be undone.`)) return;
    deleteMutation.mutate(did.id);
  }

  const entries = data?.items ?? [];
  const tier = tierData?.tier;

  return (
    <div style={{ paddingTop: 16, borderTop: '1px solid rgba(42,47,69,0.5)' }}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[0.63rem] font-bold text-[#718096] uppercase tracking-[0.9px]">
          API Configuration
        </span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); navigate('/api-dids'); }}
          className="text-[0.72rem] text-[#3b82f6] hover:underline"
        >
          Manage API DIDs
        </button>
      </div>

      {/* Tier info line */}
      {tier && (
        <div className="text-[0.8rem] text-[#718096] mb-3">
          API Tier:{' '}
          <strong className="text-[#e2e8f0]">{tier.name}</strong>
          {' '}&mdash; {tier.cps_limit} CPS
        </div>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 text-[#718096] text-[0.8rem] py-2">
          <Spinner size="xs" /> Loading…
        </div>
      )}

      {isError && (
        <p className="text-red-400 text-[0.8rem]">Could not load API DIDs.</p>
      )}

      {!isLoading && !isError && entries.length === 0 && (
        <p className="text-[#718096] text-[0.8rem]">No API DIDs configured.</p>
      )}

      {!isLoading && entries.length > 0 && (
        <table className="w-full text-[0.8rem] border-collapse">
          <thead>
            <tr>
              {['DID', 'Voice URL', 'Status', ''].map((h) => (
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
            {entries.map((did) => (
              <tr key={did.id} className="border-b border-[#2a2f45]/40 last:border-0">
                <td className="px-2 py-[6px] font-mono whitespace-nowrap text-[#e2e8f0]">
                  {did.did}
                </td>
                <td className="px-2 py-[6px]">
                  <ApiDidUrlInput did={did} customerId={customerId} />
                </td>
                <td className="px-2 py-[6px]">
                  <Badge variant={did.enabled ? 'active' : 'disabled'}>
                    {did.enabled ? 'Active' : 'Off'}
                  </Badge>
                </td>
                <td className="px-2 py-[6px]">
                  <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleMutation.mutate({ id: did.id, enabled: !did.enabled });
                      }}
                    >
                      {did.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    <Button
                      variant="danger"
                      size="xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(did);
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

      {/* Add API DID form */}
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
          Add API DID
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
              placeholder="+12125551234"
              className="text-[0.83rem] px-2 py-[5px] rounded-lg w-[150px] border border-[#2a2f45] bg-[#0d0f15] text-[#e2e8f0] outline-none focus:border-[#3b82f6] placeholder:text-[#718096]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[0.65rem] font-bold text-[#718096] uppercase tracking-[0.6px]">
              Voice URL
            </label>
            <input
              type="url"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder="https://example.com/voice"
              className="text-[0.83rem] px-2 py-[5px] rounded-lg w-[220px] border border-[#2a2f45] bg-[#0d0f15] text-[#e2e8f0] outline-none focus:border-[#3b82f6] placeholder:text-[#718096]"
            />
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
