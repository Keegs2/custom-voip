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
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFlowStore, useFlowTemporal } from '../store/flowStore';
import { compileFlow, validateFlow } from '../compile/registry';
import { fromLegacyIvr } from '../compile/fromLegacyIvr';
import { listIvrFlows, type LegacyIvrFlowRow } from '../../api/ivr';
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
import { FlowSimulateModal } from './FlowSimulateModal';

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
  const [importOpen, setImportOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [simulateOpen, setSimulateOpen] = useState(false);
  // Product the user picked from the name dropdown that needs a "this clears the
  // canvas" confirmation before we start a fresh flow of that product.
  const [pendingProduct, setPendingProduct] = useState<ProductKind | null>(null);

  // Legacy IVR flows for the import picker — only fetched while the modal is open.
  const legacyIvrQuery = useQuery({
    queryKey: ['legacy-ivr-flows'],
    queryFn: listIvrFlows,
    enabled: importOpen,
  });

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
  //
  // "Meaningful content" mirrors the New-flow modal semantics: switching product
  // swaps the palette + compiler, so existing nodes may become invalid — we start
  // a fresh flow. If the canvas is effectively empty (just the auto `entry` node,
  // no edges, default name, never saved) we switch silently; otherwise we confirm.
  const hasContent =
    nodes.length > 1 ||
    edges.length > 0 ||
    docId != null ||
    (name.trim() !== '' && name !== 'Untitled Flow');

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

  // Product picked from the name dropdown. Same product → no-op; empty canvas →
  // switch immediately; otherwise stage it and confirm (switching starts fresh).
  const handlePickProduct = (p: ProductKind) => {
    if (p === product) return;
    if (hasContent) {
      setPendingProduct(p);
      return;
    }
    newFlow(p);
    toastOk(`Switched to ${PRODUCT_LABELS[p]}`);
  };

  const confirmSwitchProduct = () => {
    if (pendingProduct == null) return;
    newFlow(pendingProduct);
    toastOk(`Switched to ${PRODUCT_LABELS[pendingProduct]}`);
    setPendingProduct(null);
  };

  // Convert a legacy ivr_flows row into a CallFlowDoc and drop it on the canvas
  // as a fresh unsaved draft (id: null) — Save then creates a new call_flows row.
  const handleImportLegacy = (row: LegacyIvrFlowRow) => {
    try {
      const doc = fromLegacyIvr(row.flow_config, {
        name: `${row.name} (imported)`,
        customerId: row.customer_id ?? null,
        did: row.did ?? '',
      });
      loadDoc(doc);
      setImportOpen(false);
      toastOk(`Imported "${row.name}" — review, then Save to create a call flow`);
    } catch {
      toastErr('Could not import this IVR flow');
    }
  };

  const setName = (v: string) => patchDoc({ name: v });
  const setDid = (v: string) => patchDoc({ entry: { kind: 'did', did: v } });

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 12,
        flexWrap: 'wrap',
        padding: '10px 16px',
        background: 'linear-gradient(180deg, #161922 0%, #13151d 100%)',
        borderBottom: '1px solid rgba(42,47,69,0.6)',
      }}
    >
      {/* Brand — replaces the removed PageHeader now that the builder is
          full-screen. The cyan bar is the Call Flow Builder accent (§15). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, alignSelf: 'stretch', paddingRight: 4 }}>
        <span
          style={{
            width: 3,
            alignSelf: 'stretch',
            borderRadius: 2,
            background: 'linear-gradient(180deg, #22d3ee 0%, #0891b2 100%)',
            boxShadow: '0 0 10px rgba(34,211,238,0.45)',
          }}
        />
        <span style={{ fontSize: '0.95rem', fontWeight: 800, color: '#e2e8f0', letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>
          Call Flow Builder
        </span>
      </div>

      {/* ── Flow-identity group ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
        {/* Product — the NAME is the control: click to switch product. */}
        <Field label="Product">
          <ProductSelect product={product} onPick={handlePickProduct} />
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
      </div>

      <div style={{ flex: 1, minWidth: 8 }} />

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
      <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)}>Import IVR</Button>
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
      <Button
        variant="ghost"
        size="sm"
        disabled={docId == null}
        title={docId == null ? 'Save the flow to enable simulation' : undefined}
        onClick={() => setSimulateOpen(true)}
      >
        Simulate
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
      <FlowSimulateModal open={simulateOpen} onClose={() => setSimulateOpen(false)} flowId={docId ?? null} />

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

      {/* Confirm switching product from the name dropdown — switching starts a
          fresh flow of the new product (the palette + compiler change). */}
      <Modal
        open={pendingProduct != null}
        onClose={() => setPendingProduct(null)}
        title="Switch product?"
        maxWidth="max-w-md"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setPendingProduct(null)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={confirmSwitchProduct}>
              Switch to {pendingProduct ? PRODUCT_LABELS[pendingProduct] : ''}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: '0.82rem', color: '#94a3b8', lineHeight: 1.6 }}>
          Switching from <strong style={{ color: '#22d3ee' }}>{PRODUCT_LABELS[product]}</strong> to{' '}
          <strong style={{ color: '#22d3ee' }}>{pendingProduct ? PRODUCT_LABELS[pendingProduct] : ''}</strong> changes
          the node palette and compiler, so this <strong style={{ color: '#e2e8f0' }}>starts a fresh flow</strong> and
          clears the current canvas. This can't be undone.
        </p>
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

      {/* Import legacy IVR — lists ivr_flows rows, converts the chosen one's
          flow_config into a CallFlowDoc draft on the canvas. */}
      <Modal open={importOpen} onClose={() => setImportOpen(false)} title="Import a legacy IVR flow">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ margin: 0, fontSize: '0.78rem', color: '#94a3b8', lineHeight: 1.5 }}>
            Pick an existing IVR flow to rebuild on the canvas. It loads as a new
            unsaved draft — Save to create a Call Flow (the original IVR is left
            untouched).
          </p>

          {legacyIvrQuery.isLoading && (
            <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>Loading IVR flows…</span>
          )}
          {legacyIvrQuery.isError && (
            <span style={{ fontSize: '0.78rem', color: '#ef4444' }}>Failed to load IVR flows.</span>
          )}
          {legacyIvrQuery.data?.length === 0 && (
            <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>No legacy IVR flows found.</span>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '50vh', overflow: 'auto' }}>
            {legacyIvrQuery.data?.map((row) => {
              const nodeCount = row.flow_config?.nodes?.length ?? 0;
              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => handleImportLegacy(row)}
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
                  <span style={{ fontSize: '0.86rem', fontWeight: 700 }}>
                    {row.name}
                    {!row.is_active ? ' (inactive)' : ''}
                  </span>
                  <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
                    {row.did ? `DID ${row.did} · ` : ''}
                    {nodeCount} node{nodeCount === 1 ? '' : 's'} · #{row.id}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </Modal>
    </div>
  );
}

/**
 * Product picker whose trigger IS the product name (Task 3). Clicking the name
 * opens a popover listing every selectable product with its one-line blurb; the
 * current product is marked. Picking a product calls `onPick` (the parent owns
 * the "switching starts a fresh flow" confirmation). Cyan accent (#22d3ee, §15).
 *
 * React #310: all hooks (state, ref, effect) are declared unconditionally at the
 * top, before any early return.
 */
function ProductSelect({ product, onPick }: { product: ProductKind; onPick: (p: ProductKind) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside-click / Escape while open.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (p: ProductKind) => {
    setOpen(false);
    onPick(p);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Change product"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          height: 34,
          padding: '0 10px 0 12px',
          borderRadius: 8,
          fontSize: '0.78rem',
          fontWeight: 700,
          color: '#22d3ee',
          background: 'rgba(34,211,238,0.12)',
          border: `1px solid ${open ? 'rgba(34,211,238,0.75)' : 'rgba(34,211,238,0.4)'}`,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          outline: 'none',
        }}
      >
        {PRODUCT_LABELS[product]}
        <span
          aria-hidden="true"
          style={{
            fontSize: '0.6rem',
            opacity: 0.85,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.15s',
          }}
        >
          ▾
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            zIndex: 50,
            width: 300,
            padding: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            borderRadius: 12,
            background: 'linear-gradient(180deg, #1c1f2b 0%, #15171f 100%)',
            border: '1px solid rgba(34,211,238,0.22)',
            boxShadow: '0 18px 48px -12px rgba(0,0,0,0.7), 0 0 0 1px rgba(0,0,0,0.4)',
          }}
        >
          {SELECTABLE_PRODUCTS.map((p) => {
            const active = p === product;
            return (
              <button
                key={p}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => pick(p)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  textAlign: 'left',
                  padding: '9px 11px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  color: '#e2e8f0',
                  background: active ? 'rgba(34,211,238,0.12)' : 'transparent',
                  border: `1px solid ${active ? 'rgba(34,211,238,0.4)' : 'transparent'}`,
                  transition: 'background 0.12s, border-color 0.12s',
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = 'transparent';
                }}
              >
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    fontSize: '0.82rem',
                    fontWeight: 700,
                    color: active ? '#22d3ee' : '#e2e8f0',
                  }}
                >
                  {PRODUCT_LABELS[p]}
                  {active && <span style={{ fontSize: '0.72rem', color: '#22d3ee' }}>✓</span>}
                </span>
                <span style={{ fontSize: '0.7rem', color: '#94a3b8', lineHeight: 1.4 }}>{PRODUCT_BLURBS[p]}</span>
              </button>
            );
          })}
        </div>
      )}
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
