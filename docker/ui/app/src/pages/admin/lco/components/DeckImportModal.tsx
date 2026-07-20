/**
 * DeckImportModal — bulk CSV rate-deck import for one carrier. Idempotent on
 * (carrier, prefix, jurisdiction, effective_date) server-side. Paste or upload a
 * CSV; the header row is expected by the server-side parser. Rendered
 * conditionally by the tab (fresh state).
 */

import { useState } from 'react';
import { Upload, FileUp } from 'lucide-react';
import { Modal } from '../../../../components/ui/Modal';
import { Button } from '../../../../components/ui/Button';
import { FormField } from '../../../../components/ui/FormField';
import { GLASS } from '../../../../components/glass/glass';
import type { Carrier } from '../../../../types/carrier';
import type { RateDeckImportRequest } from '../../../../types/lco';
import { useImportDeck } from '../hooks';
import { formError, noteBox, MONO } from '../styles';

interface DeckImportModalProps {
  carriers: Carrier[];
  onClose: () => void;
}

export function DeckImportModal({ carriers, onClose }: DeckImportModalProps) {
  const [carrierId, setCarrierId] = useState('');
  const [csv, setCsv] = useState('');
  const [effective, setEffective] = useState('');
  const [error, setError] = useState<string | null>(null);

  const importMutation = useImportDeck(onClose);

  const onFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const submit = () => {
    if (!carrierId) {
      setError('Select a carrier');
      return;
    }
    if (!csv.trim()) {
      setError('Paste or upload CSV rows');
      return;
    }
    setError(null);
    const body: RateDeckImportRequest = { carrier_id: Number(carrierId), csv };
    if (effective) body.effective_date = new Date(effective).toISOString();
    importMutation.mutate(body);
  };

  return (
    <Modal open onClose={onClose} title="Import Rate Deck (CSV)" maxWidth="max-w-2xl">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {error && <p style={formError}>{error}</p>}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
          <FormField as="select" label="Carrier" required value={carrierId} onChange={(e) => setCarrierId(e.target.value)}>
            <option value="">Select carrier…</option>
            {carriers.map((c) => (
              <option key={c.id} value={c.id}>{c.display_name || c.gateway_name}</option>
            ))}
          </FormField>
          <FormField label="Effective date" type="datetime-local" value={effective} onChange={(e) => setEffective(e.target.value)} hint="Optional — defaults to now" />
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: '0.72rem', fontWeight: 700, color: GLASS.text }}>CSV rows</span>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.7rem', color: GLASS.accent, cursor: 'pointer', fontWeight: 700 }}>
              <FileUp size={13} />
              Upload CSV
              <input type="file" accept=".csv,.txt" onChange={(e) => onFile(e.target.files?.[0])} style={{ display: 'none' }} />
            </label>
          </div>
          <FormField
            as="textarea"
            label=""
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={'prefix,cost_per_min,jurisdiction,priority,description\n1617,0.0085,interstate,100,Boston\n1212,0.0091,interstate,100,NYC'}
            style={{ minHeight: 150, fontFamily: MONO, fontSize: '0.74rem', lineHeight: 1.55 }}
          />
        </div>

        <div style={noteBox}>
          One row per prefix: <code style={{ fontFamily: MONO, color: '#93c5fd' }}>prefix, cost_per_min, jurisdiction, priority, description</code>. Re-import is
          idempotent per (carrier, prefix, jurisdiction, effective date); malformed rows are skipped and reported.
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <Button icon={<Upload size={14} />} onClick={submit} loading={importMutation.isPending}>
            Import rates
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={importMutation.isPending}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
