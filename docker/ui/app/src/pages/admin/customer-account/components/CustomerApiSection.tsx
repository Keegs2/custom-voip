/**
 * CustomerApiSection — programmable-voice (API DID) management inside the
 * customer 360. Glass header + tier line, a glass table of DIDs with an
 * inline-editable voice URL per row, and an accent-tinted "Add API DID" form.
 * Queries + mutations are unchanged and run on live data.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { listApiDids, createApiDid, updateApiDid, deleteApiDid } from '../../../../api/apiDids';
import { getCustomerTier } from '../../../../api/tiers';
import { Button } from '../../../../components/ui/Button';
import { Spinner } from '../../../../components/ui/Spinner';
import { useToast } from '../../../../components/ui/Toast';
import { GlassChip } from '../../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import type { ApiDid } from '../../../../types/apiDid';
import {
  emptyNote,
  errorNote,
  fieldLabel,
  glassFieldInput,
  glassFormPanel,
  inlineLoading,
  manageLink,
  sectionEyebrow,
  tableHead,
  tableShell,
} from '../styles';

interface CustomerApiSectionProps {
  customerId: number;
  accent?: string;
}

// Inline editable voice URL field
function ApiDidUrlInput({
  did,
  customerId,
  accent,
}: {
  did: ApiDid;
  customerId: number;
  accent: string;
}) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [value, setValue] = useState(did.voice_url);
  const [saved, setSaved] = useState(false);
  const [focused, setFocused] = useState(false);

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
    setFocused(false);
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
      onFocus={() => setFocused(true)}
      onBlur={handleBlur}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      onClick={(e) => e.stopPropagation()}
      disabled={mutation.isPending}
      placeholder="https://example.com/voice"
      style={{
        ...glassFieldInput(focused, accent),
        width: '100%',
        maxWidth: 220,
        ...(saved
          ? { borderColor: hexToRgba(GLASS.success, 0.55), color: '#4ade80' }
          : null),
        opacity: mutation.isPending ? 0.5 : 1,
      }}
    />
  );
}

export function CustomerApiSection({ customerId, accent = '#a855f7' }: CustomerApiSectionProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toastOk, toastErr } = useToast();

  const [newDid, setNewDid] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [didFocused, setDidFocused] = useState(false);
  const [urlFocused, setUrlFocused] = useState(false);

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
    <div>
      {/* Section header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={sectionEyebrow(accent)}>API Configuration</span>
          {!isLoading && !isError && (
            <GlassChip
              label={entries.length === 1 ? '1 DID' : `${entries.length} DIDs`}
              color={accent}
            />
          )}
        </div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); navigate('/programmable-voice'); }}
          style={manageLink(accent)}
          onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
          onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
        >
          Manage Programmable Voice
        </button>
      </div>

      {/* Tier info line */}
      {tier && (
        <div style={{ fontSize: '0.8rem', color: GLASS.textMuted, marginBottom: 16 }}>
          API Tier: <strong style={{ color: GLASS.text }}>{tier.name}</strong> — {tier.cps_limit} CPS
        </div>
      )}

      {isLoading && (
        <div style={inlineLoading}>
          <Spinner size="xs" /> Loading…
        </div>
      )}

      {isError && <div style={errorNote()}>Could not load API DIDs.</div>}

      {!isLoading && !isError && entries.length === 0 && (
        <div style={{ ...emptyNote, padding: '20px 0', textAlign: 'left' }}>No API DIDs configured.</div>
      )}

      {!isLoading && entries.length > 0 && (
        <div style={{ ...tableShell, marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', color: '#cbd5e0' }}>
            <thead>
              <tr>
                {['DID', 'Voice URL', 'Status', ''].map((h, i) => (
                  <th key={h || `col-${i}`} style={tableHead}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((did, idx) => (
                <tr
                  key={did.id}
                  style={{
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
                  }}
                >
                  <td style={{ padding: '8px 12px', fontFamily: 'monospace', whiteSpace: 'nowrap', color: GLASS.text }}>
                    {did.did}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <ApiDidUrlInput did={did} customerId={customerId} accent={accent} />
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <GlassChip
                      label={did.enabled ? 'Active' : 'Off'}
                      color={did.enabled ? GLASS.success : GLASS.textFaint}
                      dot={did.enabled}
                    />
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }} onClick={(e) => e.stopPropagation()}>
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
                        onClick={(e) => { e.stopPropagation(); handleDelete(did); }}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add API DID form */}
      <form onSubmit={handleCreate} onClick={(e) => e.stopPropagation()} style={glassFormPanel(accent)}>
        <div style={{ ...sectionEyebrow(accent), marginBottom: 14 }}>Add API DID</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={fieldLabel}>DID</label>
            <input
              type="tel"
              value={newDid}
              onChange={(e) => setNewDid(e.target.value)}
              onFocus={() => setDidFocused(true)}
              onBlur={() => setDidFocused(false)}
              onClick={(e) => e.stopPropagation()}
              placeholder="+1XXXXXXXXXX"
              style={{ ...glassFieldInput(didFocused, accent), width: 155, fontFamily: 'monospace' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={fieldLabel}>Voice URL</label>
            <input
              type="url"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              onFocus={() => setUrlFocused(true)}
              onBlur={() => setUrlFocused(false)}
              onClick={(e) => e.stopPropagation()}
              placeholder="https://example.com/voice"
              style={{ ...glassFieldInput(urlFocused, accent), width: 220 }}
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
