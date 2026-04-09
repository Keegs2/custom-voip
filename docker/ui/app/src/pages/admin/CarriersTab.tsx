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
      {/* Section header */}
      <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h2 className="text-base font-bold text-[#e2e8f0]">Carrier Gateways</h2>
          <p className="text-sm text-[#718096] mt-0.5">
            Configure SIP trunk connections to upstream carriers
          </p>
        </div>
        <div className="flex items-center gap-2">
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
        <p className="text-red-400 text-sm py-4">
          Failed to load carriers. Please try again.
        </p>
      )}

      {!isLoading && !isError && (carriers?.length ?? 0) === 0 && (
        <div className="flex flex-col items-center justify-center text-center py-16 gap-1 text-[#718096]">
          <p className="font-semibold text-sm">No carriers configured</p>
          <p className="text-xs text-[#4a5568]">Add your first carrier connection to get started.</p>
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
