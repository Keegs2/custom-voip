import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listCarriers, createCarrier, testCarrier } from '../../api/carriers';
import { Spinner } from '../../components/ui/Spinner';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { CarrierCard } from './CarrierCard';
import { CarrierForm } from './CarrierForm';
import type { CarrierCreate } from '../../types/carrier';

export function CarriersTab() {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [showAddModal, setShowAddModal] = useState(false);
  const [testingAll, setTestingAll] = useState(false);

  const { data: carriers, isLoading, isError } = useQuery({
    queryKey: ['carriers'],
    queryFn: listCarriers,
  });

  const createMutation = useMutation({
    mutationFn: (data: CarrierCreate) => createCarrier(data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['carriers'] });
      setShowAddModal(false);
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
    <div>
      {/* Section header / toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 20,
          flexWrap: 'wrap',
          background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
          border: '1px solid rgba(42,47,69,0.6)',
          borderRadius: 12,
          padding: '20px 24px',
        }}
      >
        <div>
          <h2
            style={{
              fontSize: '1rem',
              fontWeight: 700,
              color: '#e2e8f0',
              margin: 0,
              letterSpacing: '-0.01em',
            }}
          >
            Carrier Gateways
          </h2>
          <p style={{ fontSize: '0.875rem', color: '#718096', marginTop: 4 }}>
            Configure SIP trunk connections to upstream carriers
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Button variant="ghost" size="sm" loading={testingAll} onClick={handleTestAll}>
            Test All
          </Button>
          <Button size="sm" onClick={() => setShowAddModal(true)}>
            + Add Carrier
          </Button>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2.5 text-[#718096] py-12">
          <Spinner /> Loading carriers…
        </div>
      )}

      {isError && (
        <div
          style={{
            padding: '12px 16px',
            borderRadius: 10,
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.2)',
            color: '#f87171',
            fontSize: '0.875rem',
          }}
        >
          Failed to load carriers. Please try again.
        </div>
      )}

      {!isLoading && !isError && (carriers?.length ?? 0) === 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            padding: '64px 16px',
            gap: 6,
            background: 'linear-gradient(135deg, rgba(30,33,48,0.6) 0%, rgba(19,21,29,0.7) 100%)',
            border: '1px solid rgba(42,47,69,0.4)',
            borderRadius: 16,
          }}
        >
          <p style={{ fontWeight: 600, fontSize: '0.875rem', color: '#718096' }}>
            No carriers configured
          </p>
          <p style={{ fontSize: '0.75rem', color: '#4a5568' }}>
            Add your first carrier connection to get started.
          </p>
        </div>
      )}

      {!isLoading && !isError && (carriers?.length ?? 0) > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {carriers!.map((carrier) => (
            <CarrierCard key={carrier.id} carrier={carrier} />
          ))}
        </div>
      )}

      <Modal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        title="Add Carrier"
        maxWidth="max-w-2xl"
      >
        <CarrierForm
          submitLabel="Create Carrier"
          onCancel={() => setShowAddModal(false)}
          onSubmit={async (values) => {
            await createMutation.mutateAsync(values);
          }}
        />
      </Modal>
    </div>
  );
}
