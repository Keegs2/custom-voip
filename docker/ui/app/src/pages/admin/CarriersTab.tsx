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

  const {
    data: carriers,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['carriers'],
    queryFn: listCarriers,
  });

  // ----------------------------------------------------------------
  // Create carrier
  // ----------------------------------------------------------------
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

  // ----------------------------------------------------------------
  // Test all enabled carriers
  // ----------------------------------------------------------------
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
      {/* Header row */}
      <div className="flex items-center justify-between gap-3 mb-6">
        <div>
          <h2 className="text-[1rem] font-bold text-[#e2e8f0]">Carrier Gateways</h2>
          <p className="text-[0.78rem] text-[#718096] mt-0.5">
            Configure SIP trunk connections to upstream carriers
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            loading={testingAll}
            onClick={handleTestAll}
          >
            Test All
          </Button>
          <Button
            size="sm"
            onClick={() => setShowAddModal(true)}
          >
            + Add Carrier
          </Button>
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center gap-2 text-[#718096] py-10">
          <Spinner /> Loading carriers…
        </div>
      )}

      {/* Error */}
      {isError && (
        <p className="text-red-400 text-sm py-4">
          Failed to load carriers. Please try again.
        </p>
      )}

      {/* Empty */}
      {!isLoading && !isError && (carriers?.length ?? 0) === 0 && (
        <div className="text-center py-16 text-[#718096]">
          <p className="font-semibold mb-1">No carriers configured</p>
          <p className="text-[0.82rem]">Add your first carrier connection to get started.</p>
        </div>
      )}

      {/* Carrier cards grid */}
      {!isLoading && !isError && (carriers?.length ?? 0) > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {carriers!.map((carrier) => (
            <CarrierCard key={carrier.id} carrier={carrier} />
          ))}
        </div>
      )}

      {/* Add carrier modal */}
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
