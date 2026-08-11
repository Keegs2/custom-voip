/**
 * CustomerApiSection — API Calling panel on the admin Customer 360
 * (api/hybrid accounts): tier line, DID table with inline voice-URL editing,
 * enable/disable/delete, and the add-DID form.
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css, plus the
 * admin-area `dlx-*` primitives in dl-admin.css). Renders its own dl-panel.
 * Presentation only: every query, mutation payload, confirm() and toast is
 * unchanged (including the blur-to-save voice-URL semantics).
 *
 * React #310: every hook in every component below is called unconditionally
 * at the top of its function, before any early return.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Code2 } from 'lucide-react';
import { listApiDids, createApiDid, updateApiDid, deleteApiDid } from '../../api/apiDids';
import { getCustomerTier } from '../../api/tiers';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/ToastContext';
import type { ApiDid } from '../../types/apiDid';
import '../../styles/dl-admin.css';

interface CustomerApiSectionProps {
  customerId: number;
}

const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

// Inline editable voice URL field — blur (or Enter → blur) saves when changed
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
      className="dl-input dl-input-mono"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={handleBlur}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      onClick={(e) => e.stopPropagation()}
      disabled={mutation.isPending}
      placeholder="https://example.com/voice"
      style={{
        width: '100%',
        maxWidth: 260,
        padding: '5px 10px',
        fontSize: '0.78rem',
        ...(saved
          ? {
              borderColor: 'rgba(47, 125, 246, 0.55)',
              color: 'var(--rcf-azure-deep)',
              boxShadow: '0 0 0 3px rgba(47, 125, 246, 0.12)',
            }
          : {}),
      }}
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
    <section className="dl-panel">
      {/* ── Panel head ── */}
      <div className="dl-panel-head" style={{ flexWrap: 'nowrap' }}>
        <span aria-hidden="true" style={{ display: 'inline-flex', color: 'var(--rcf-azure-deep)', flexShrink: 0 }}>
          <Code2 size={15} strokeWidth={2} />
        </span>
        <h3 className="dl-panel-title" style={{ margin: 0 }}>API Configuration</h3>
        {!isLoading && !isError && (
          <span className="dl-count">{entries.length === 1 ? '1 DID' : `${entries.length} DIDs`}</span>
        )}
        <button
          type="button"
          className="dlx-linkbtn"
          style={{ marginLeft: 'auto', flexShrink: 0 }}
          onClick={(e) => { e.stopPropagation(); navigate('/api-dids'); }}
        >
          Manage API DIDs →
        </button>
      </div>

      <div className="dl-panel-body">
        {/* Tier info line */}
        {tier && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 14, fontSize: '0.82rem' }}>
            <span className="dl-fact-label" style={{ marginBottom: 0 }}>API Tier</span>
            <span style={{ color: 'var(--rcf-ink)', fontWeight: 700 }}>{tier.name}</span>
            <span style={{ color: 'var(--rcf-ink-dim)' }}>— {tier.cps_limit} CPS</span>
          </div>
        )}

        {isLoading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--rcf-ink-dim)', fontSize: '0.8rem', padding: '8px 0' }}>
            <Spinner size="xs" /> Loading…
          </div>
        )}

        {isError && <div className="dl-banner dl-banner-err">Could not load API DIDs.</div>}

        {!isLoading && !isError && entries.length === 0 && (
          <div className="dl-empty" style={{ marginBottom: 12 }}>No API DIDs configured.</div>
        )}

        {!isLoading && entries.length > 0 && (
          <div style={{ overflowX: 'auto', border: '1px solid var(--rcf-line-soft)', borderRadius: 10, marginBottom: 16 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
              <thead>
                <tr>
                  {['DID', 'Voice URL', 'Status', ''].map((h) => (
                    <th key={h} className="dl-th">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map((did) => (
                  <tr key={did.id} className="dl-row">
                    <td className="dlx-td" style={{ fontFamily: MONO, fontWeight: 600, color: 'var(--rcf-ink)' }}>
                      {did.did}
                    </td>
                    <td className="dlx-td" style={{ whiteSpace: 'normal', minWidth: 220 }}>
                      <ApiDidUrlInput did={did} customerId={customerId} />
                    </td>
                    <td className="dlx-td">
                      <span className={did.enabled ? 'dl-pill dl-pill-on' : 'dl-pill dl-pill-off'}>
                        {did.enabled ? 'Active' : 'Off'}
                      </span>
                    </td>
                    <td className="dlx-td" style={{ textAlign: 'right' }}>
                      <div
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          className="dl-btn dl-btn-ghost dlx-btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleMutation.mutate({ id: did.id, enabled: !did.enabled });
                          }}
                        >
                          {did.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          className="dl-btn dl-btn-danger dlx-btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(did);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Add API DID form */}
        <form
          onSubmit={handleCreate}
          onClick={(e) => e.stopPropagation()}
          style={{ paddingTop: 16, borderTop: '1px solid var(--rcf-line)' }}
        >
          <h4 className="dl-section-title">Add API DID</h4>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span className="dl-flabel">DID</span>
              <input
                type="tel"
                className="dl-input dl-input-mono"
                value={newDid}
                onChange={(e) => setNewDid(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                placeholder="+1XXXXXXXXXX"
                style={{ width: 160 }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span className="dl-flabel">Voice URL</span>
              <input
                type="url"
                className="dl-input dl-input-mono"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                placeholder="https://example.com/voice"
                style={{ width: 240 }}
              />
            </div>
            <button
              type="submit"
              className="dl-btn dl-btn-primary"
              disabled={createMutation.isPending}
              onClick={(e) => e.stopPropagation()}
            >
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
