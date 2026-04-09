import { useState, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  updateCarrier,
  deleteCarrier,
  testCarrier,
} from '../../api/carriers';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { useToast } from '../../components/ui/Toast';
import { cn } from '../../utils/cn';
import { CarrierForm } from './CarrierForm';
import type { Carrier, CarrierCreate, CarrierTestResult } from '../../types/carrier';

interface CarrierCardProps {
  carrier: Carrier;
}

function productBadgeVariant(pt: string) {
  if (pt === 'rcf') return 'rcf' as const;
  if (pt === 'api') return 'api' as const;
  if (pt === 'trunk') return 'trunk' as const;
  return 'standard' as const;
}

function authLabel(authType: string): string {
  if (authType === 'credentials') return 'Credentials';
  if (authType === 'none') return 'None';
  return 'IP-based';
}

export function CarrierCard({ carrier: initialCarrier }: CarrierCardProps) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [isEditing, setIsEditing] = useState(false);
  const [testResult, setTestResult] = useState<CarrierTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  // ----------------------------------------------------------------
  // Update mutation
  // ----------------------------------------------------------------
  const updateMutation = useMutation({
    mutationFn: (data: Partial<CarrierCreate>) =>
      updateCarrier(initialCarrier.id, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['carriers'] });
      setIsEditing(false);
      toastOk('Carrier updated');
    },
    onError: (err: Error) => {
      toastErr(`Save failed: ${err.message}`);
    },
  });

  // ----------------------------------------------------------------
  // Delete mutation
  // ----------------------------------------------------------------
  const deleteMutation = useMutation({
    mutationFn: () => deleteCarrier(initialCarrier.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['carriers'] });
      toastOk('Carrier deleted');
    },
    onError: (err: Error) => {
      toastErr(`Delete failed: ${err.message}`);
    },
  });

  // ----------------------------------------------------------------
  // Enable / disable toggle
  // ----------------------------------------------------------------
  const toggleEnabled = useCallback(async () => {
    try {
      await updateCarrier(initialCarrier.id, { enabled: !initialCarrier.enabled });
      void qc.invalidateQueries({ queryKey: ['carriers'] });
      toastOk(initialCarrier.enabled ? 'Carrier disabled' : 'Carrier enabled');
    } catch (err) {
      toastErr(`Update failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [initialCarrier.id, initialCarrier.enabled, qc, toastOk, toastErr]);

  // ----------------------------------------------------------------
  // Test connection
  // ----------------------------------------------------------------
  const handleTest = useCallback(async () => {
    setTesting(true);
    try {
      const result = await testCarrier(initialCarrier.id);
      setTestResult(result);
    } catch (err) {
      setTestResult({
        carrier_id: initialCarrier.id,
        gateway_name: initialCarrier.gateway_name,
        reachable: false,
        latency_ms: null,
        error: err instanceof Error ? err.message : 'Unknown error',
        tested_at: new Date().toISOString(),
      });
    } finally {
      setTesting(false);
    }
  }, [initialCarrier.id, initialCarrier.gateway_name]);

  // ----------------------------------------------------------------
  // Delete confirmation
  // ----------------------------------------------------------------
  const handleDelete = useCallback(() => {
    const name = initialCarrier.display_name || initialCarrier.gateway_name;
    if (!window.confirm(`Delete carrier "${name}"? This cannot be undone.`)) return;
    deleteMutation.mutate();
  }, [initialCarrier.display_name, initialCarrier.gateway_name, deleteMutation]);

  // ----------------------------------------------------------------
  // Connection details block
  // ----------------------------------------------------------------
  const codecsDisplay = Array.isArray(initialCarrier.codec_prefs)
    ? initialCarrier.codec_prefs.join(', ')
    : String(initialCarrier.codec_prefs ?? 'PCMU,PCMA');

  const connLines: Array<[string, React.ReactNode]> = [
    ['SIP Proxy', `${initialCarrier.sip_proxy}:${initialCarrier.port}`],
    ['Transport', (initialCarrier.transport ?? 'UDP').toUpperCase()],
    ['Auth', authLabel(initialCarrier.auth_type)],
    ['Codecs', codecsDisplay],
    ['Registration', initialCarrier.register ? 'Yes' : 'No'],
  ];

  if (
    (initialCarrier.auth_type === 'credentials') &&
    initialCarrier.username
  ) {
    connLines.push(['Username', initialCarrier.username]);
    connLines.push(['Password', '••••••••']);
  }
  if (initialCarrier.max_channels != null) {
    connLines.push(['Max Channels', String(initialCarrier.max_channels)]);
  }
  if (initialCarrier.cps_limit != null) {
    connLines.push(['CPS Limit', String(initialCarrier.cps_limit)]);
  }

  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 16,
        padding: '24px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
        transition: 'border-color 0.3s, box-shadow 0.3s',
        position: 'relative',
        overflow: 'hidden',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(59,130,246,0.3)';
        (e.currentTarget as HTMLDivElement).style.boxShadow = '0 0 0 1px rgba(59,130,246,0.15), 0 8px 30px rgba(0,0,0,0.4)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(42,47,69,0.6)';
        (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 20px rgba(0,0,0,0.3)';
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <div
          style={{
            fontSize: '1rem',
            fontWeight: 700,
            color: '#e2e8f0',
            letterSpacing: '-0.01em',
          }}
        >
          {initialCarrier.display_name || initialCarrier.gateway_name}
        </div>
        <div
          style={{
            fontFamily: 'monospace',
            fontSize: '0.75rem',
            color: '#718096',
            marginTop: 3,
          }}
        >
          {initialCarrier.gateway_name}
        </div>

        {/* Badges */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
          <Badge variant={initialCarrier.enabled ? 'active' : 'disabled'}>
            {initialCarrier.enabled ? 'Enabled' : 'Disabled'}
          </Badge>
          {initialCarrier.is_primary && (
            <Badge variant="premium">Primary</Badge>
          )}
          {initialCarrier.is_failover && (
            <Badge variant="standard">Failover</Badge>
          )}
          {(initialCarrier.product_types ?? []).map((pt) => (
            <Badge key={pt} variant={productBadgeVariant(pt)}>
              {pt}
            </Badge>
          ))}
        </div>
      </div>

      {/* Connection details monospace block */}
      {!isEditing && (
        <pre
          style={{
            fontFamily: 'monospace',
            fontSize: '0.75rem',
            background: 'rgba(15,17,23,0.8)',
            border: '1px solid rgba(42,47,69,0.6)',
            borderRadius: 10,
            padding: '12px 16px',
            marginBottom: 16,
            overflowX: 'auto',
            lineHeight: 1.7,
          }}
        >
          {connLines.map(([key, val]) => (
            <span key={key} style={{ display: 'block' }}>
              <span style={{ color: '#718096' }}>{String(key).padEnd(12, ' ')}</span>
              <span style={{ color: '#93c5fd' }}>{val}</span>
            </span>
          ))}
        </pre>
      )}

      {/* Edit form */}
      {isEditing && (
        <div
          style={{
            borderTop: '1px solid rgba(42,47,69,0.6)',
            paddingTop: 16,
            marginBottom: 16,
          }}
        >
          <CarrierForm
            carrier={initialCarrier}
            submitLabel="Save Changes"
            onCancel={() => setIsEditing(false)}
            onSubmit={async (values) => {
              await updateMutation.mutateAsync(values);
            }}
          />
        </div>
      )}

      {/* Actions bar */}
      {!isEditing && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <Button
            size="sm"
            variant="ghost"
            loading={testing}
            onClick={handleTest}
          >
            Test Connection
          </Button>

          {/* Inline test result */}
          {testResult && (
            <span
              className={cn(
                'text-[0.78rem] font-semibold',
                testResult.reachable ? 'text-green-400' : 'text-red-400',
              )}
            >
              {testResult.reachable
                ? `Reachable${testResult.latency_ms != null ? ` ${testResult.latency_ms}ms` : ''}`
                : `Unreachable — ${testResult.error ?? 'connection timeout'}`}
            </span>
          )}

          <span style={{ flex: 1 }} />

          <Button
            size="sm"
            variant="ghost"
            onClick={() => setIsEditing(true)}
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant={initialCarrier.enabled ? 'ghost' : 'success'}
            onClick={toggleEnabled}
          >
            {initialCarrier.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={handleDelete}
            loading={deleteMutation.isPending}
          >
            Delete
          </Button>
        </div>
      )}
    </div>
  );
}
