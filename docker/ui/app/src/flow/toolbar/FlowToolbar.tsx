/**
 * Builder toolbar — flow identity (product, name, DID entry binding, customer),
 * the new/load controls, undo/redo, compiled-artifact preview, and the Save /
 * Publish actions wired to the `call_flows` API.
 *
 * The PRODUCT drives everything: which palette/compiler/validation runs, which
 * `product` tag is sent to the API, and which existing flows the "Open flow"
 * picker lists. Creating a new flow picks the product; loading one inherits the
 * stored `product` from the flow_graph.
 *
 * Save  → PUT/POST draft with { product, flow_graph: CallFlowDoc, compiled }.
 * Publish → validate (block on errors) → ensure saved → POST /publish { compiled };
 *           the backend writes the product sink (rcf_numbers / ivr_flows) + repoints DID.
 *
 * React #310: ALL hooks (store, query, local state) are declared unconditionally
 * at the top, before any early return or conditional render.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFlowStore, useFlowTemporal } from '../store/flowStore';
import { compileFlow, validateFlow } from '../compile/registry';
import { PRODUCT_LABELS, SELECTABLE_PRODUCTS } from '../model/palette';
import {
  createCallFlow,
  getCallFlow,
  listCallFlows,
  publishCallFlow,
  updateCallFlow,
} from '../../api/callFlows';
import type { CallFlow } from '../../types/callFlow';
import type { CallFlowDoc, EntryBinding, ProductKind } from '../model/types';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { AdminCustomerSelector } from '../../components/AdminCustomerSelector';
import { useToast } from '../../components/ui/ToastContext';
import { ApiError } from '../../api/client';
import { FlowHistoryModal } from './FlowHistoryModal';

function entryDid(entry: EntryBinding): string {
  return entry.kind === 'did' ? entry.did : '';
}

/** One-line blurb per selectable product, shown in the New-flow picker. */
const PRODUCT_BLURBS: Record<ProductKind, string> = {
  ivr: 'Multi-step menus, gather, dial, record — the full programmable-voice palette.',
  api: 'Webhook-driven programmable voice — same palette as IVR, API product tag.',
  rcf: 'Remote call forwarding — a DID forwards to a single destination.',
  conference: 'A greeting, then join a conference room.',
  trunk: 'SIP trunk inbound delivery — try the PBX endpoints in order or in parallel.',
  ucaas: 'Find-me / follow-me ring plans.',
};

export function FlowToolbar() {
  // ── Hooks (all unconditional, top of component) ──────────────────────────
  const docId = useFlowStore((s) => s.doc.id);
  const product = useFlowStore((s) => s.doc.product);
  const name = useFlowStore((s) => s.doc.name);
  const status = useFlowStore((s) => s.doc.status);
  const entry = useFlowStore((s) => s.doc.entry);
  const customerId = useFlowStore((s) => s.doc.customerId);
  const nodes = useFlowStore((s) => s.nodes);
  const edges = useFlowStore((s) => s.edges);
  const patchDoc = useFlowStore((s) => s.patchDoc);
  const getDoc = useFlowStore((s) => s.getDoc);
  const loadDoc = useFlowStore((s) => s.loadDoc);
  const newFlow = useFlowStore((s) => s.newFlow);

  const undo = useFlowTemporal((s) => s.undo);
  const redo = useFlowTemporal((s) => s.redo);
  const canUndo = useFlowTemporal((s) => s.pastStates.length > 0);
  const canRedo = useFlowTemporal((s) => s.futureStates.length > 0);

  const { toastOk, toastErr } = useToast();
  const queryClient = useQueryClient();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  // List + invalidate flows for the CURRENT product only.
  const queryKey = ['call-flows', { product }] as const;
  const flowsQuery = useQuery({ queryKey, queryFn: () => listCallFlows({ product }) });

  const saveMutation = useMutation({
    mutationFn: async (): Promise<CallFlow> => {
      const doc = getDoc();
      const compiled = compileFlow(doc);
      if (doc.id == null) {
        return createCallFlow({
          product: doc.product,
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
      queryClient.invalidateQueries({ queryKey });
      toastOk('Flow saved');
    },
    onError: (e) => toastErr(e instanceof ApiError ? e.message : 'Save failed'),
  });

  const publishMutation = useMutation({
    mutationFn: async (): Promise<CallFlow> => {
      const doc = getDoc();
      const result = validateFlow(doc);
      if (!result.ok) throw new Error('Fix validation errors before publishing.');
      if (doc.customerId == null) throw new Error('Select a customer before publishing.');
      if (!entryDid(doc.entry)) throw new Error('Bind a DID (entry) before publishing.');
      const compiled = compileFlow(doc);

      let id = doc.id;
      if (id == null) {
        const created = await createCallFlow({
          product: doc.product,
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
      queryClient.invalidateQueries({ queryKey });
      toastOk('Flow published — DID routing updated');
    },
    onError: (e) => toastErr(e instanceof ApiError ? e.message : (e as Error).message),
  });

  // Derived (no hooks) — safe after the hooks above.
  void nodes;
  void edges;
  const validation = validateFlow(getDoc());
  const hasErrors = !validation.ok;
  const compiledPreview = JSON.stringify(compileFlow(getDoc()), null, 2);

  const handleLoad = async (id: number) => {
    try {
      const flow = await getCallFlow(id);
      // The stored graph carries its own product → palette/compiler follow it.
      loadDoc(flow.flow_graph as CallFlowDoc);
      patchDoc({
        id: flow.id,
        product: flow.product,
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

  const handleNewFlow = (p: ProductKind) => {
    newFlow(p);
    setNewOpen(false);
    toastOk(`New ${PRODUCT_LABELS[p]} flow`);
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
      {/* Current product — set when creating/loading a flow, not editable here. */}
      <Field label="Product">
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            height: 34,
            padding: '0 12px',
            borderRadius: 8,
            fontSize: '0.78rem',
            fontWeight: 700,
            color: '#22d3ee',
            background: 'rgba(34,211,238,0.12)',
            border: '1px solid rgba(34,211,238,0.4)',
            whiteSpace: 'nowrap',
          }}
        >
          {PRODUCT_LABELS[product]}
        </span>
      </Field>

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
      <Button variant="ghost" size="sm" onClick={() => setNewOpen(true)}>New</Button>
      <Button variant="ghost" size="sm" onClick={() => setPreviewOpen(true)}>Preview</Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={docId == null}
        title={docId == null ? 'Save the flow to enable version history' : undefined}
        onClick={() => setHistoryOpen(true)}
      >
        History
      </Button>
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

      <FlowHistoryModal open={historyOpen} onClose={() => setHistoryOpen(false)} flowId={docId ?? null} />

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

      {/* New-flow product selector (Task 1) — picks palette + compiler + tag. */}
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New call flow — choose a product">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ margin: 0, fontSize: '0.78rem', color: '#94a3b8', lineHeight: 1.5 }}>
            The product sets the node palette, the compiler, and how this flow publishes.
            (This clears the current canvas.)
          </p>
          {SELECTABLE_PRODUCTS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => handleNewFlow(p)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
                textAlign: 'left',
                padding: '12px 14px',
                borderRadius: 10,
                cursor: 'pointer',
                color: '#e2e8f0',
                background: 'rgba(26,29,39,0.9)',
                border: '1px solid rgba(42,47,69,0.8)',
                transition: 'border-color 0.15s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'rgba(34,211,238,0.6)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'rgba(42,47,69,0.8)';
              }}
            >
              <span style={{ fontSize: '0.86rem', fontWeight: 700 }}>{PRODUCT_LABELS[p]}</span>
              <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>{PRODUCT_BLURBS[p]}</span>
            </button>
          ))}
        </div>
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
