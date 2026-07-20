/**
 * TfnImportModal — bulk toll-free import. Paste or upload a CSV / newline list,
 * choose the default owner + carrier + status for NEW rows, then submit. The
 * endpoint returns a batch key immediately; we poll `/import/{batch_key}` and
 * render live progress (idempotent + memory-bounded server-side, so re-submitting
 * the same batch key is safe).
 *
 * Rendered conditionally by the page, so its state resets on each open. All hooks
 * sit at the top (React #310); `useImportBatch` is guarded by `enabled`.
 */

import { useMemo, useState } from 'react';
import { Upload, FileUp, CheckCircle2 } from 'lucide-react';
import { Modal } from '../../../../components/ui/Modal';
import { Button } from '../../../../components/ui/Button';
import { FormField } from '../../../../components/ui/FormField';
import { GLASS } from '../../../../components/glass/glass';
import type { Carrier } from '../../../../types/carrier';
import { useImportTfns, useImportBatch } from '../hooks';
import { TFN_STATUSES } from '../types';
import { groupLabel, noteBox, progressTrack, progressFill, importStat, statValue, statLabel } from '../styles';

interface CustomerOption {
  id: number;
  name: string;
}

interface TfnImportModalProps {
  customers: CustomerOption[];
  carriers: Carrier[];
  onClose: () => void;
}

/** Split pasted/CSV text into candidate numbers (newline / comma / space). */
function parseNumbers(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function TfnImportModal({ customers, carriers, onClose }: TfnImportModalProps) {
  const [text, setText] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [carrierId, setCarrierId] = useState('');
  const [status, setStatus] = useState('spare');
  const [batchKey, setBatchKey] = useState<string | null>(null);

  const importMutation = useImportTfns(setBatchKey);
  const { data: batch } = useImportBatch(batchKey);

  const numbers = useMemo(() => parseNumbers(text), [text]);

  const onFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const submit = () => {
    importMutation.mutate({
      numbers,
      customer_id: customerId ? Number(customerId) : null,
      carrier_id: carrierId ? Number(carrierId) : null,
      status,
    });
  };

  const pct = batch && batch.total > 0 ? (batch.processed / batch.total) * 100 : 0;
  const done = batch?.status === 'completed';

  return (
    <Modal open onClose={onClose} title="Import Toll-Free Numbers" maxWidth="max-w-2xl">
      {batchKey === null ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: '0.72rem', fontWeight: 700, color: GLASS.text }}>Numbers</span>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.7rem', color: GLASS.accent, cursor: 'pointer', fontWeight: 700 }}>
                <FileUp size={13} />
                Upload CSV
                <input type="file" accept=".csv,.txt" onChange={(e) => onFile(e.target.files?.[0])} style={{ display: 'none' }} />
              </label>
            </div>
            <FormField
              as="textarea"
              label=""
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="+18005551234, 18445556789, 8335551212 …"
              style={{ minHeight: 120, fontFamily: 'ui-monospace, monospace', fontSize: '0.78rem' }}
            />
            <div style={{ fontSize: '0.72rem', color: GLASS.textMuted, marginTop: 6 }}>
              {numbers.length.toLocaleString()} number{numbers.length === 1 ? '' : 's'} detected · invalid / non-toll-free entries are skipped and reported.
            </div>
          </div>

          <div>
            <div style={groupLabel()}>Defaults for new rows</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14 }}>
              <FormField as="select" label="Owner (customer)" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">Unassigned</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </FormField>
              <FormField as="select" label="Inbound carrier" value={carrierId} onChange={(e) => setCarrierId(e.target.value)}>
                <option value="">None</option>
                {carriers.map((c) => (
                  <option key={c.id} value={c.id}>{c.display_name || c.gateway_name}</option>
                ))}
              </FormField>
              <FormField as="select" label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
                {TFN_STATUSES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </FormField>
            </div>
          </div>

          <div style={noteBox}>
            Re-import is non-destructive: existing numbers keep their owner/carrier unless currently unset. The import is idempotent by batch key.
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <Button icon={<Upload size={14} />} onClick={submit} loading={importMutation.isPending} disabled={numbers.length === 0}>
              Import {numbers.length > 0 ? numbers.length.toLocaleString() : ''}
            </Button>
            <Button variant="ghost" onClick={onClose} disabled={importMutation.isPending}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              {done ? <CheckCircle2 size={16} style={{ color: GLASS.success }} /> : <span style={{ ...statLabel, color: GLASS.accent }}>Processing…</span>}
              <span style={{ fontSize: '0.82rem', fontWeight: 700, color: GLASS.text }}>
                {done ? 'Import complete' : 'Importing…'}
              </span>
              {batch?.idempotent_replay && <span style={{ fontSize: '0.68rem', color: GLASS.warning }}>(already imported)</span>}
            </div>
            <div style={progressTrack()}>
              <div style={progressFill(done ? 100 : pct)} />
            </div>
            <div style={{ fontSize: '0.72rem', color: GLASS.textMuted, marginTop: 6 }}>
              {(batch?.processed ?? 0).toLocaleString()} / {(batch?.total ?? 0).toLocaleString()} processed
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <div style={importStat(GLASS.success)}>
              <div style={{ ...statValue, color: GLASS.success }}>{(batch?.inserted ?? 0).toLocaleString()}</div>
              <div style={statLabel}>Inserted</div>
            </div>
            <div style={importStat(GLASS.blue)}>
              <div style={{ ...statValue, color: GLASS.blue }}>{(batch?.updated ?? 0).toLocaleString()}</div>
              <div style={statLabel}>Updated</div>
            </div>
            <div style={importStat(GLASS.warning)}>
              <div style={{ ...statValue, color: GLASS.warning }}>{(batch?.skipped ?? 0).toLocaleString()}</div>
              <div style={statLabel}>Skipped</div>
            </div>
            <div style={importStat(GLASS.danger)}>
              <div style={{ ...statValue, color: GLASS.danger }}>{(batch?.failed ?? 0).toLocaleString()}</div>
              <div style={statLabel}>Failed</div>
            </div>
          </div>

          {batch && batch.errors.length > 0 && (
            <div style={noteBox}>
              <div style={{ fontWeight: 700, color: GLASS.warning, marginBottom: 6 }}>Skipped ({batch.errors.length} shown):</div>
              <div style={{ maxHeight: 130, overflowY: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: '0.7rem' }}>
                {batch.errors.map((e, i) => (
                  <div key={i} style={{ color: GLASS.textMuted }}>
                    <span style={{ color: '#f87171' }}>{e.value}</span> — {e.error}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={onClose}>{done ? 'Done' : 'Close'}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
