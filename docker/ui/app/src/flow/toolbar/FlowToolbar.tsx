/**
 * Builder toolbar — flow identity (name, DID entry binding, customer), the
 * load/new controls, undo/redo, compiled-artifact preview, and the Save /
 * Publish actions wired to the `call_flows` API.
 *
 * Save  → PUT/POST draft with { flow_graph: CallFlowDoc, compiled }.
 * Publish → validate (block on errors) → ensure saved → POST /publish { compiled };
 *           the backend writes ivr_flows.flow_config + repoints the DID voice_url.
 *
 * React #310: ALL hooks (store, query, local state) are declared unconditionally
 * at the top, before any early return or conditional render.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFlowStore, useFlowTemporal } from '../store/flowStore';
import { compileIvr, validateIvr } from '../compile/ivr';
import {
  createCallFlow,
  getCallFlow,
  listCallFlows,
  publishCallFlow,
  updateCallFlow,
} from '../../api/callFlows';
import type { CallFlow } from '../../types/callFlow';
import type { CallFlowDoc, EntryBinding } from '../model/types';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { AdminCustomerSelector } from '../../components/AdminCustomerSelector';
import { useToast } from '../../components/ui/ToastContext';
import { ApiError } from '../../api/client';

const PRODUCT = 'ivr' as const;
const QUERY_KEY = ['call-flows', { product: PRODUCT }] as const;

function entryDid(entry: EntryBinding): string {
  return entry.kind === 'did' ? entry.did : '';
}

export function FlowToolbar() {
  // ── Hooks (all unconditional, top of component) ──────────────────────────
  const docId = useFlowStore((s) => s.doc.id);
  const name = useFlowStore((s) => s.doc.name);
  const status = useFlowStore((s) => s.doc.status);
  const entry = useFlowStore((s) => s.doc.entry);
  const customerId = useFlowStore((s) => s.doc.customerId);
  const nodes = useFlowStore((s) => s.nodes);
  const edges = useFlowStore((s) => s.edges);
  const patchDoc = useFlowStore((s) => s.patchDoc);
  const getDoc = useFlowStore((s) => s.getDoc);
  const loadDoc = useFlowStore((s) => s.loadDoc);
  const reset = useFlowStore((s) => s.reset);

  const undo = useFlowTemporal((s) => s.undo);
  const redo = useFlowTemporal((s) => s.redo);
  const canUndo = useFlowTemporal((s) => s.pastStates.length > 0);
  const canRedo = useFlowTemporal((s) => s.futureStates.length > 0);

  const { toastOk, toastErr } = useToast();
  const queryClient = useQueryClient();
  const [previewOpen, setPreviewOpen] = useState(false);

  const flowsQuery = useQuery({ queryKey: QUERY_KEY, queryFn: () => listCallFlows({ product: PRODUCT }) });

  const saveMutation = useMutation({
    mutationFn: async (): Promise<CallFlow> => {
      const doc = getDoc();
      const compiled = compileIvr(doc);
      if (doc.id == null) {
        return createCallFlow({
          product: PRODUCT,
          name: doc.name,
          customer_id: doc.customerId ?? undefined,
          entry: doc.entry,
          flow_graph: doc,
          compiled,
        });
      }
      return updateCallFlow(doc.id, {
        name: doc.name,
        entry: doc.entry,
        flow_graph: doc,
        compiled,
      });
    },
    onSuccess: (flow) => {
      patchDoc({ id: flow.id, status: flow.status, version: flow.version });
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toastOk('Flow saved');
    },
    onError: (e) => toastErr(e instanceof ApiError ? e.message : 'Save failed'),
  });

  const publishMutation = useMutation({
    mutationFn: async (): Promise<CallFlow> => {
      const doc = getDoc();
      const result = validateIvr(doc);
      if (!result.ok) throw new Error('Fix validation errors before publishing.');
      if (doc.customerId == null) throw new Error('Select a customer before publishing.');
      if (!entryDid(doc.entry)) throw new Error('Bind a DID (entry) before publishing.');
      const compiled = compileIvr(doc);

      let id = doc.id;
      if (id == null) {
        const created = await createCallFlow({
          product: PRODUCT,
          name: doc.name,
          customer_id: doc.customerId,
          entry: doc.entry,
          flow_graph: doc,
          compiled,
        });
        id = created.id;
        patchDoc({ id: created.id, status: created.status, version: created.version });
      } else {
        await updateCallFlow(id, { name: doc.name, entry: doc.entry, flow_graph: doc, compiled });
      }
      return publishCallFlow(id, { compiled });
    },
    onSuccess: (flow) => {
      patchDoc({ id: flow.id, status: flow.status, version: flow.version });
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toastOk('Flow published — DID routing updated');
    },
    onError: (e) => toastErr(e instanceof ApiError ? e.message : (e as Error).message),
  });

  // Derived (no hooks) — safe after the hooks above.
  void nodes;
  void edges;
  const validation = validateIvr(getDoc());
  const hasErrors = !validation.ok;
  const compiledPreview = JSON.stringify(compileIvr(getDoc()), null, 2);

  const handleLoad = async (id: number) => {
    try {
      const flow = await getCallFlow(id);
      loadDoc(flow.flow_graph as CallFlowDoc);
      patchDoc({
        id: flow.id,
        name: flow.name,
        status: flow.status,
        version: flow.version,
        customerId: flow.customer_id,
        entry: flow.entry,
      });
      toastOk(`Loaded "${flow.name}"`);
    } catch (e) {
      toastErr(e instanceof ApiError ? e.message : 'Failed to load flow');
    }
  };

  const setName = (v: string) => patchDoc({ name: v });
  const setDid = (v: string) => patchDoc({ entry: { kind: 'did', did: v } });

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 10,
        flexWrap: 'wrap',
        padding: '10px 14px',
        background: '#13151d',
        borderBottom: '1px solid rgba(42,47,69,0.6)',
      }}
    >
      {/* Name */}
      <Field label="Flow name">
        <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="Untitled Flow" />
      </Field>

      {/* DID entry binding */}
      <Field label="DID (entry)">
        <input style={{ ...inputStyle, width: 150 }} value={entryDid(entry)} onChange={(e) => setDid(e.target.value)} placeholder="+16175551234" />
      </Field>

      {/* Customer */}
      <Field label="Customer">
        <AdminCustomerSelector
          selectedCustomerId={customerId ?? undefined}
          onSelect={(id) => patchDoc({ customerId: id ?? null })}
          accent="#22d3ee"
        />
      </Field>

      {/* Load existing */}
      <Field label="Open flow">
        <select
          style={{ ...inputStyle, width: 170, cursor: 'pointer' }}
          value=""
          onChange={(e) => e.target.value && handleLoad(Number(e.target.value))}
        >
          <option value="">{flowsQuery.isLoading ? 'Loading…' : 'Select a flow…'}</option>
          {flowsQuery.data?.items.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name} ({f.status})
            </option>
          ))}
        </select>
      </Field>

      <div style={{ flex: 1 }} />

      {/* Status badge */}
      <span
        style={{
          alignSelf: 'center',
          padding: '3px 9px',
          borderRadius: 6,
          fontSize: '0.66rem',
          fontWeight: 800,
          textTransform: 'uppercase',
          color: status === 'published' ? '#22c55e' : '#f59e0b',
          background: status === 'published' ? 'rgba(34,197,94,0.12)' : 'rgba(245,158,11,0.12)',
          border: `1px solid ${status === 'published' ? 'rgba(34,197,94,0.4)' : 'rgba(245,158,11,0.4)'}`,
        }}
      >
        {status}
        {docId != null ? ` · #${docId}` : ''}
      </span>

      {/* Actions */}
      <Button variant="ghost" size="sm" onClick={() => undo()} disabled={!canUndo}>Undo</Button>
      <Button variant="ghost" size="sm" onClick={() => redo()} disabled={!canRedo}>Redo</Button>
      <Button variant="ghost" size="sm" onClick={() => reset()}>New</Button>
      <Button variant="ghost" size="sm" onClick={() => setPreviewOpen(true)}>Preview</Button>
      <Button variant="primary" size="sm" loading={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
        Save
      </Button>
      <Button
        variant="success"
        size="sm"
        loading={publishMutation.isPending}
        disabled={hasErrors}
        onClick={() => publishMutation.mutate()}
      >
        Publish
      </Button>

      <Modal open={previewOpen} onClose={() => setPreviewOpen(false)} title="Compiled artifact" maxWidth="max-w-2xl">
        <pre
          style={{
            margin: 0,
            padding: 14,
            fontSize: '0.72rem',
            lineHeight: 1.5,
            color: '#a5d6a7',
            background: '#0f1117',
            borderRadius: 10,
            border: '1px solid rgba(42,47,69,0.6)',
            overflow: 'auto',
            maxHeight: '60vh',
          }}
        >
          {compiledPreview}
        </pre>
      </Modal>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#4a5568' }}>
        {label}
      </span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  height: 34,
  padding: '0 10px',
  borderRadius: 8,
  fontSize: '0.8rem',
  color: '#e2e8f0',
  background: '#1e2130',
  border: '1px solid #2a2f45',
  outline: 'none',
};
