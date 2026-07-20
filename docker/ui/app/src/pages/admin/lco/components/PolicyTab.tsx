/**
 * PolicyTab — per-customer carrier allow/deny policy. Pick a customer, then add
 * allow/deny rules (with an optional priority override) and remove existing ones.
 * The LCO decision honours these when steering that customer's calls.
 *
 * Self-contained tab: owns the customer selection + the add-rule form state.
 * React #310: every hook sits at the top; the list query is `enabled`-guarded.
 */

import { useState } from 'react';
import { ShieldCheck, Ban, Check, Trash2, Plus } from 'lucide-react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { Button } from '../../../../components/ui/Button';
import { FormField } from '../../../../components/ui/FormField';
import { GLASS } from '../../../../components/glass/glass';
import type { Carrier } from '../../../../types/carrier';
import type { CarrierPolicy } from '../../../../types/lco';
import { usePolicy, useUpsertPolicy, useDeletePolicy } from '../hooks';
import { POLICY_MODES } from '../types';
import {
  sectionTitle,
  sectionSubtitle,
  selectStyle,
  tableWrap,
  table,
  th,
  td,
  modeChip,
  iconBtn,
  groupLabel,
  dash,
} from '../styles';
import { LoadingRow, StateCard } from './states';

interface CustomerOption {
  id: number;
  name: string;
}

interface PolicyTabProps {
  customers: CustomerOption[];
  carriers: Carrier[];
}

export function PolicyTab({ customers, carriers }: PolicyTabProps) {
  const [customerId, setCustomerId] = useState('');
  const [carrierId, setCarrierId] = useState('');
  const [mode, setMode] = useState<'allow' | 'deny'>('allow');
  const [priority, setPriority] = useState('');
  const [notes, setNotes] = useState('');
  const [delHover, setDelHover] = useState<number | null>(null);

  const selectedCustomer = customerId ? Number(customerId) : undefined;
  const { data: policies, isLoading, isError } = usePolicy(selectedCustomer, selectedCustomer !== undefined);
  const upsert = useUpsertPolicy(() => {
    setCarrierId('');
    setPriority('');
    setNotes('');
  });
  const del = useDeletePolicy();

  const carrierName = (id: number) => {
    const c = carriers.find((x) => x.id === id);
    return c ? c.display_name || c.gateway_name : `Carrier #${id}`;
  };

  const save = () => {
    if (!selectedCustomer || !carrierId) return;
    upsert.mutate({
      customer_id: selectedCustomer,
      carrier_id: Number(carrierId),
      mode,
      priority_override: priority ? Number(priority) : null,
      notes: notes.trim() || null,
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <GlassPanel padding="20px 24px">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <ShieldCheck size={17} style={{ color: GLASS.accent }} />
          <h2 style={sectionTitle}>Carrier Policy</h2>
        </div>
        <p style={{ ...sectionSubtitle, marginBottom: 16 }}>
          Per-customer allow/deny rules that constrain which carriers the LCO engine may use.
        </p>
        <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} style={{ ...selectStyle(Boolean(customerId)), minWidth: 260 }} aria-label="Select customer">
          <option value="">Select a customer…</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </GlassPanel>

      {selectedCustomer === undefined ? (
        <StateCard icon={<ShieldCheck size={26} />} title="Select a customer" body="Choose a customer to view and edit their carrier allow/deny policy." />
      ) : (
        <>
          {/* Add rule */}
          <GlassPanel padding="20px 24px">
            <div style={groupLabel()}>
              <Plus size={13} /> Add policy rule
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14, alignItems: 'end' }}>
              <FormField as="select" label="Carrier" value={carrierId} onChange={(e) => setCarrierId(e.target.value)}>
                <option value="">Select carrier…</option>
                {carriers.map((c) => (
                  <option key={c.id} value={c.id}>{c.display_name || c.gateway_name}</option>
                ))}
              </FormField>
              <FormField as="select" label="Mode" value={mode} onChange={(e) => setMode(e.target.value as 'allow' | 'deny')}>
                {POLICY_MODES.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </FormField>
              <FormField label="Priority override" type="number" value={priority} onChange={(e) => setPriority(e.target.value)} placeholder="optional" />
              <FormField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
              <Button icon={<Plus size={14} />} onClick={save} loading={upsert.isPending} disabled={!carrierId}>
                Save rule
              </Button>
            </div>
          </GlassPanel>

          {/* Existing rules */}
          {isLoading ? (
            <LoadingRow label="Loading policy…" />
          ) : isError ? (
            <StateCard accent={GLASS.danger} icon={<Ban size={26} />} title="Couldn't load policy" body="The request failed. Try again." />
          ) : (
            <GlassPanel padding={0}>
              <div style={tableWrap}>
                <table style={table}>
                  <thead>
                    <tr>
                      <th style={th()}>Carrier</th>
                      <th style={th()}>Mode</th>
                      <th style={th(true)}>Priority override</th>
                      <th style={th()}>Notes</th>
                      <th style={th(true)}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(policies ?? []).length === 0 ? (
                      <tr>
                        <td style={td({ muted: true })} colSpan={5}>No policy rules — this customer can use any enabled carrier.</td>
                      </tr>
                    ) : (
                      (policies ?? []).map((p: CarrierPolicy) => (
                        <tr key={p.id}>
                          <td style={td()}>{p.gateway_name ?? carrierName(p.carrier_id)}</td>
                          <td style={td()}>
                            <span style={modeChip(p.mode === 'allow')}>
                              {p.mode === 'allow' ? <Check size={11} /> : <Ban size={11} />}
                              {p.mode}
                            </span>
                          </td>
                          <td style={td({ right: true, muted: true })}>{p.priority_override ?? <span style={dash}>—</span>}</td>
                          <td style={td({ muted: true })}>{p.notes ?? <span style={dash}>—</span>}</td>
                          <td style={td({ right: true })}>
                            <button
                              type="button"
                              onClick={() => del.mutate(p.id)}
                              onMouseEnter={() => setDelHover(p.id)}
                              onMouseLeave={() => setDelHover(null)}
                              style={iconBtn('danger', delHover === p.id)}
                            >
                              <Trash2 size={12} />
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </GlassPanel>
          )}
        </>
      )}
    </div>
  );
}
