/**
 * CarriersTab — carrier gateway roster with live connectivity testing
 * (/admin/platform/carriers).
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css, plus the
 * admin `dlx-*` layer in styles/dl-admin.css and the platform-scoped `dlx2-*`
 * layer in styles/dl-platform.css). Renders INSIDE the PlatformManagementPage
 * shell, which owns the paper canvas (`dl-scope`) — this page contributes
 * only the toolbar, the add-carrier panel, and the card grid.
 *
 * React #310: every hook is called unconditionally at the top.
 */
import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listCarriers, createCarrier, testCarrier } from '../../api/carriers';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/Toast';
import { CarrierCard } from './CarrierCard';
import { CarrierForm } from './CarrierForm';
import type { CarrierCreate } from '../../types/carrier';
import '../../styles/dl-admin.css';
import '../../styles/dl-platform.css';

export function CarriersTab() {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [showAddForm, setShowAddForm] = useState(false);
  const [testingAll, setTestingAll] = useState(false);

  const { data: carriers, isLoading, isError } = useQuery({
    queryKey: ['carriers'],
    queryFn: listCarriers,
  });

  const createMutation = useMutation({
    mutationFn: (data: CarrierCreate) => createCarrier(data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['carriers'] });
      setShowAddForm(false);
      toastOk('Carrier created');
    },
    onError: (err: Error) => {
      toastErr(`Create failed: ${err.message}`);
    },
  });

  const handleTestAll = useCallback(async () => {
    const enabled = (carriers ?? []).filter((c) => c.enabled);
    if (enabled.length === 0) {
      toastErr('No enabled carriers to test');
      return;
    }
    setTestingAll(true);
    try {
      await Promise.allSettled(enabled.map((c) => testCarrier(c.id)));
      toastOk(`Tested ${enabled.length} carrier${enabled.length === 1 ? '' : 's'}`);
    } finally {
      setTestingAll(false);
    }
  }, [carriers, toastOk, toastErr]);

  return (
    <div className="dl-stack">
      {/* ── Toolbar — section identity + actions ── */}
      <div className="dlx-toolbar" style={{ marginBottom: 0 }}>
        <div style={{ flex: '1 1 320px', minWidth: 240 }}>
          <h2
            style={{
              fontFamily: '"Archivo", "IBM Plex Sans", sans-serif',
              fontSize: '0.95rem',
              fontWeight: 700,
              letterSpacing: '-0.01em',
              color: 'var(--rcf-ink)',
              margin: 0,
            }}
          >
            Carrier Gateways
          </h2>
          <p style={{ fontSize: '0.78rem', color: 'var(--rcf-ink-dim)', margin: '3px 0 0' }}>
            Configure SIP trunk connections to upstream carriers.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto', flexShrink: 0 }}>
          <button
            type="button"
            className="dl-btn dl-btn-ghost"
            onClick={() => void handleTestAll()}
            disabled={testingAll}
          >
            {testingAll ? 'Testing…' : 'Test All'}
          </button>
          <button
            type="button"
            className="dl-btn dl-btn-primary"
            onClick={() => setShowAddForm((v) => !v)}
          >
            {showAddForm ? 'Cancel' : '+ Add Carrier'}
          </button>
        </div>
      </div>

      {/* ── Add carrier panel ── */}
      {showAddForm && (
        <section className="dl-panel">
          <div className="dl-panel-head">
            <h2 className="dl-panel-title">Add Carrier</h2>
          </div>
          <div className="dl-panel-body">
            <CarrierForm
              submitLabel="Create Carrier"
              onCancel={() => setShowAddForm(false)}
              onSubmit={async (values) => {
                await createMutation.mutateAsync(values);
              }}
            />
          </div>
        </section>
      )}

      {/* ── Loading / error / empty states ── */}
      {isLoading && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            color: 'var(--rcf-ink-dim)',
            fontSize: '0.85rem',
            padding: '48px 0',
          }}
        >
          <Spinner /> Loading carriers…
        </div>
      )}

      {isError && (
        <div className="dl-banner dl-banner-err">Failed to load carriers. Please try again.</div>
      )}

      {!isLoading && !isError && (carriers?.length ?? 0) === 0 && (
        <div className="dl-empty">
          <p style={{ fontWeight: 600, margin: 0 }}>No carriers configured</p>
          <p style={{ fontSize: '0.72rem', margin: '4px 0 0' }}>
            Add your first carrier connection to get started.
          </p>
        </div>
      )}

      {/* ── Card grid ── */}
      {!isLoading && !isError && (carriers?.length ?? 0) > 0 && (
        <div className="dlx2-cardgrid">
          {carriers!.map((carrier) => (
            <CarrierCard key={carrier.id} carrier={carrier} />
          ))}
        </div>
      )}
    </div>
  );
}
