/**
 * TfnDetailModal — view + edit one toll-free number, plus the CR (Customer
 * Record) workflow. The outer component owns the queries + modal shell; the inner
 * form initialises its typed state from the loaded detail (so no async-init
 * dance). CR submit is honest about the default-off Somos adapter — it records
 * local intent unless the adapter is enabled server-side.
 *
 * Rendered conditionally by the page; all hooks sit at the top (React #310).
 */

import { useState } from 'react';
import { ClipboardCheck, Save } from 'lucide-react';
import { Modal } from '../../../../components/ui/Modal';
import { Button } from '../../../../components/ui/Button';
import { FormField } from '../../../../components/ui/FormField';
import { Spinner } from '../../../../components/ui/Spinner';
import { GLASS } from '../../../../components/glass/glass';
import { fmt } from '../../../../utils/format';
import type { Carrier } from '../../../../types/carrier';
import type { TfnDetail, TfnCrStatus, TfnUpdate } from '../../../../types/tollFree';
import { useTfnDetail, useTfnCrStatus, useUpdateTfn, useSubmitCr } from '../hooks';
import { TFN_STATUSES } from '../types';
import { groupLabel, detailRow, detailKey, detailVal, noteBox } from '../styles';
import { TfnStatusChip, CrChip } from './StatusChip';

interface CustomerOption {
  id: number;
  name: string;
}

interface TfnDetailModalProps {
  tfn: string;
  customers: CustomerOption[];
  carriers: Carrier[];
  onClose: () => void;
}

export function TfnDetailModal({ tfn, customers, carriers, onClose }: TfnDetailModalProps) {
  const { data: detail, isLoading, isError } = useTfnDetail(tfn, true);
  const { data: cr } = useTfnCrStatus(tfn, true);

  return (
    <Modal open onClose={onClose} title={`Toll-Free — ${fmt(tfn)}`} maxWidth="max-w-2xl">
      {isLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: GLASS.textMuted, padding: '20px 0' }}>
          <Spinner size="sm" /> Loading…
        </div>
      )}
      {isError && <p style={{ color: '#f87171', fontSize: '0.85rem' }}>Could not load this toll-free number.</p>}
      {detail && <DetailForm detail={detail} cr={cr} customers={customers} carriers={carriers} onClose={onClose} />}
    </Modal>
  );
}

interface DetailFormProps {
  detail: TfnDetail;
  cr: TfnCrStatus | undefined;
  customers: CustomerOption[];
  carriers: Carrier[];
  onClose: () => void;
}

function DetailForm({ detail, cr, customers, carriers, onClose }: DetailFormProps) {
  const [customerId, setCustomerId] = useState(detail.customer_id != null ? String(detail.customer_id) : '');
  const [carrierId, setCarrierId] = useState(detail.carrier_id != null ? String(detail.carrier_id) : '');
  const [status, setStatus] = useState(detail.status);
  const [respOrg, setRespOrg] = useState(detail.resp_org_id ?? '');
  const [template, setTemplate] = useState(detail.template_name ?? '');
  const [label, setLabel] = useState(detail.label ?? '');
  const [notes, setNotes] = useState(detail.notes ?? '');

  const update = useUpdateTfn(detail.tfn, onClose);
  const submit = useSubmitCr(detail.tfn);

  const save = () => {
    const body: TfnUpdate = {
      status,
      resp_org_id: respOrg,
      template_name: template,
      label,
      notes,
    };
    if (customerId) body.customer_id = Number(customerId);
    if (carrierId) body.carrier_id = Number(carrierId);
    update.mutate(body);
  };

  const adapterOn = cr?.somos_adapter_enabled ?? false;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {/* Editable fields */}
      <div>
        <div style={groupLabel()}>Assignment &amp; routing</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
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
          <FormField label="RespOrg ID" value={respOrg} onChange={(e) => setRespOrg(e.target.value)} placeholder="e.g. GRAN1" />
          <FormField label="Template name" value={template} onChange={(e) => setTemplate(e.target.value)} placeholder="optional" />
          <FormField label="Label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="optional" />
        </div>
        <div style={{ marginTop: 14 }}>
          <FormField as="textarea" label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ minHeight: 60 }} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <Button icon={<Save size={14} />} onClick={save} loading={update.isPending}>
            Save changes
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={update.isPending}>
            Close
          </Button>
        </div>
      </div>

      {/* CR workflow */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 18 }}>
        <div style={groupLabel()}>Customer Record (CR)</div>
        <div style={detailRow}>
          <span style={detailKey}>CR status</span>
          <span style={detailVal}><CrChip status={cr?.cr_status ?? detail.cr_status} /></span>
        </div>
        <div style={detailRow}>
          <span style={detailKey}>Lifecycle</span>
          <span style={detailVal}><TfnStatusChip status={detail.status} /></span>
        </div>
        <div style={detailRow}>
          <span style={detailKey}>CR reference</span>
          <span style={detailVal}>{cr?.cr_reference ?? detail.cr_reference ?? '—'}</span>
        </div>
        <div style={detailRow}>
          <span style={detailKey}>Last submitted</span>
          <span style={detailVal}>{cr?.cr_last_submitted_at ? new Date(cr.cr_last_submitted_at).toLocaleString() : '—'}</span>
        </div>
        {cr?.cr_error && (
          <div style={detailRow}>
            <span style={detailKey}>Error</span>
            <span style={{ ...detailVal, color: '#f87171' }}>{cr.cr_error}</span>
          </div>
        )}

        <div style={{ ...noteBox, marginTop: 14 }}>
          {adapterOn
            ? 'The Somos RespOrg adapter is ENABLED — submitting sends a live Customer Record transaction.'
            : 'The Somos RespOrg adapter is OFF (default). Submitting records local workflow intent (status → pending) without any external RespOrg call.'}
        </div>

        <div style={{ marginTop: 14 }}>
          <Button variant={adapterOn ? 'primary' : 'ghost'} icon={<ClipboardCheck size={14} />} onClick={() => submit.mutate()} loading={submit.isPending}>
            {adapterOn ? 'Submit CR to RespOrg' : 'Record CR intent'}
          </Button>
        </div>
      </div>
    </div>
  );
}
