/**
 * DeckFormModal — create or edit a single rate-deck entry. On edit, the identity
 * fields (carrier / prefix / jurisdiction) are fixed by the server's update
 * contract, so they are shown read-only and only cost / priority / description /
 * expiry / enabled are editable. Rendered conditionally by the tab (fresh state).
 */

import { useState } from 'react';
import { Save } from 'lucide-react';
import { Modal } from '../../../../components/ui/Modal';
import { Button } from '../../../../components/ui/Button';
import { FormField } from '../../../../components/ui/FormField';
import { GLASS } from '../../../../components/glass/glass';
import type { Carrier } from '../../../../types/carrier';
import type { RateDeck, RateDeckCreate, RateDeckUpdate } from '../../../../types/lco';
import { useCreateDeck, useUpdateDeck } from '../hooks';
import { JURISDICTIONS } from '../types';
import { formError } from '../styles';

interface DeckFormModalProps {
  deck?: RateDeck;
  carriers: Carrier[];
  onClose: () => void;
}

/** ISO string from a `datetime-local` value, or null when blank. */
function toIso(local: string): string | null {
  return local ? new Date(local).toISOString() : null;
}

export function DeckFormModal({ deck, carriers, onClose }: DeckFormModalProps) {
  const isEdit = !!deck;
  const [carrierId, setCarrierId] = useState(deck ? String(deck.carrier_id) : '');
  const [prefix, setPrefix] = useState(deck?.prefix ?? '');
  const [cost, setCost] = useState(deck ? String(deck.cost_per_min) : '');
  const [jurisdiction, setJurisdiction] = useState(deck?.jurisdiction ?? 'default');
  const [priority, setPriority] = useState(deck ? String(deck.priority) : '100');
  const [description, setDescription] = useState(deck?.description ?? '');
  const [expires, setExpires] = useState('');
  const [enabled, setEnabled] = useState(deck?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);

  const create = useCreateDeck(onClose);
  const update = useUpdateDeck(onClose);

  const submit = () => {
    const costNum = Number(cost);
    if (Number.isNaN(costNum) || costNum < 0) {
      setError('Cost per minute must be a non-negative number');
      return;
    }
    setError(null);

    if (isEdit && deck) {
      const body: RateDeckUpdate = {
        cost_per_min: costNum,
        priority: Number(priority) || 100,
        description: description.trim() || null,
        enabled,
      };
      const iso = toIso(expires);
      if (iso) body.expires_at = iso;
      update.mutate({ id: deck.id, data: body });
    } else {
      if (!carrierId) {
        setError('Select a carrier');
        return;
      }
      if (!prefix.trim()) {
        setError('Prefix is required');
        return;
      }
      const body: RateDeckCreate = {
        carrier_id: Number(carrierId),
        prefix: prefix.trim(),
        cost_per_min: costNum,
        jurisdiction,
        priority: Number(priority) || 100,
        description: description.trim() || null,
        expires_at: toIso(expires),
      };
      create.mutate(body);
    }
  };

  const pending = create.isPending || update.isPending;

  return (
    <Modal open onClose={onClose} title={isEdit ? `Edit rate — ${deck?.prefix}` : 'Add rate'} maxWidth="max-w-xl">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {error && <p style={formError}>{error}</p>}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14 }}>
          <FormField as="select" label="Carrier" required value={carrierId} onChange={(e) => setCarrierId(e.target.value)} disabled={isEdit}>
            <option value="">Select carrier…</option>
            {carriers.map((c) => (
              <option key={c.id} value={c.id}>{c.display_name || c.gateway_name}</option>
            ))}
          </FormField>
          <FormField label="Prefix" required value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="1617" disabled={isEdit} hint={isEdit ? 'Fixed on edit' : 'Destination digits'} />
          <FormField label="Cost / min (USD)" type="number" min="0" step="0.0001" required value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0.0085" />
          <FormField as="select" label="Jurisdiction" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} disabled={isEdit}>
            {JURISDICTIONS.map((j) => (
              <option key={j} value={j}>{j}</option>
            ))}
          </FormField>
          <FormField label="Priority" type="number" value={priority} onChange={(e) => setPriority(e.target.value)} hint="Lower wins ties" />
          <FormField label="Expires at" type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} hint="Optional" />
        </div>

        <FormField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional label" />

        {isEdit && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: '0.82rem', color: GLASS.text, cursor: 'pointer' }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} style={{ width: 15, height: 15, accentColor: GLASS.accent }} />
            Enabled
          </label>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <Button icon={<Save size={14} />} onClick={submit} loading={pending}>
            {isEdit ? 'Save changes' : 'Add rate'}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
