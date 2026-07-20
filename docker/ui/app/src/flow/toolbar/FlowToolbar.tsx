/**
 * Builder toolbar — TWO ROWS, reorganised around a gated setup chain.
 *
 * The Customer → Product → Line selection is now made in the centre "Set up this
 * flow" card (`FlowBuilderShell.GuidedSetup`), not here. This toolbar MIRRORS that
 * selection: `SetupSummary` reads the same shared `setupStore` the card writes to,
 * so the customer · product · line "fills in" live as the operator picks it. Once
 * the flow is configured, the summary persists (so the operator always sees what
 * they're editing while the canvas is up) and a small "Change" re-opens the setup
 * card (`setupStore.beginEdit`, seeded from the committed doc).
 *
 * Row 1 (identity): brand + the live selection summary + (when configured) Change.
 * Row 2 (controls): flow name + DRAFT/PUBLISHED badge + "Open flow" on the left;
 * Undo/Redo, a "More" overflow (New / Import IVR / Preview / History / Simulate),
 * and the primary Save / Publish on the right.
 *
 * Bypass paths: "Open flow" and "Import IVR" set product/customer/entry directly
 * and seed the shared staging so the summary reflects the loaded doc immediately.
 *
 * React #310: ALL hooks (store, query, local state, effect) are declared
 * unconditionally at the top, before any early return or conditional render.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFlowStore, useFlowTemporal } from '../store/flowStore';
import { useSetupStore } from '../store/setupStore';
import { compileFlow, validateFlow } from '../compile/registry';
import { fromLegacyIvr } from '../compile/fromLegacyIvr';
import { listIvrFlows, type LegacyIvrFlowRow } from '../../api/ivr';
import { PRODUCT_LABELS, SELECTABLE_PRODUCTS } from '../model/palette';
import { entryKey, entryLabel, isEntryBound } from '../model/setup';
import {
  createCallFlow,
  getCallFlow,
  listCallFlows,
  publishCallFlow,
  updateCallFlow,
} from '../../api/callFlows';
import { listCustomers } from '../../api/customers';
import type { CallFlow } from '../../types/callFlow';
import type { CallFlowDoc, EntryBinding, ProductKind } from '../model/types';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { ApiError } from '../../api/client';
import { fmt } from '../../utils/format';
import { FlowHistoryModal } from './FlowHistoryModal';
import { FlowSimulateModal } from './FlowSimulateModal';

/** One-line blurb per selectable product, shown in the New-flow picker. */
const PRODUCT_BLURBS: Record<ProductKind, string> = {
  ivr: 'Multi-step menus, gather, dial, record — the full programmable-voice palette.',
  api: 'Webhook-driven programmable voice — same palette as IVR, API product tag.',
  rcf: 'Remote call forwarding — a DID forwards to a single destination.',
  conference: 'A greeting, then join a conference room.',
  trunk: 'SIP trunk inbound delivery — try the PBX endpoints in order or in parallel.',
  ucaas: 'Find-me / follow-me ring plans.',
};

/** Short, human label for a bound entry — used in the summary's Line segment. */
function lineText(entry: EntryBinding): string {
  return entry.kind === 'did' ? fmt(entry.did) || entry.did : entryLabel(entry);
}

export function FlowToolbar() {
  // ── Hooks (all unconditional, top of component) ──────────────────────────
  const docId = useFlowStore((s) => s.doc.id);
  const product = useFlowStore((s) => s.doc.product);
  const name = useFlowStore((s) => s.doc.name);
  const status = useFlowStore((s) => s.doc.status);
  const entry = useFlowStore((s) => s.doc.entry);
  const customerId = useFlowStore((s) => s.doc.customerId);
  const patchDoc = useFlowStore((s) => s.patchDoc);
  const getDoc = useFlowStore((s) => s.getDoc);
  const loadDoc = useFlowStore((s) => s.loadDoc);
  const newFlow = useFlowStore((s) => s.newFlow);

  const editing = useSetupStore((s) => s.editing);
  const seedSetup = useSetupStore((s) => s.seed);
  const resetSetup = useSetupStore((s) => s.reset);
  const beginEdit = useSetupStore((s) => s.beginEdit);

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
  // Holds the server's 409 detail when publishing would overwrite a diverging
  // live config — drives the overwrite-confirm modal. Null = no conflict pending.
  const [publishConflict, setPublishConflict] = useState<string | null>(null);

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

  // `overwrite` is the publish variable: false on the first attempt, true after
  // the operator confirms overwriting a diverging live config (the 409 path).
  const publishMutation = useMutation<CallFlow, Error, boolean>({
    mutationFn: async (overwrite): Promise<CallFlow> => {
      const doc = getDoc();
      const result = validateFlow(doc);
      if (!result.ok) throw new Error('Fix validation errors before publishing.');
      if (doc.customerId == null) throw new Error('Select a customer before publishing.');
      if (!isEntryBound(doc.entry)) throw new Error('Select a line before publishing.');
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
      return publishCallFlow(id, { compiled, overwrite_existing: overwrite ? true : undefined });
    },
    onSuccess: (flow) => {
      patchDoc({ id: flow.id, status: flow.status, version: flow.version });
      queryClient.invalidateQueries({ queryKey });
      toastOk('Flow published — routing updated');
    },
    onError: (e) => {
      // 409 = the live config diverged from what this flow last published. Don't
      // treat it as an error — open a confirm modal so the operator can choose to
      // overwrite (re-publishing with overwrite_existing: true).
      if (e instanceof ApiError && e.status === 409) {
        setPublishConflict(e.message);
        return;
      }
      toastErr(e.message);
    },
  });

  // ── Derived (no hooks) — safe after the hooks above ──────────────────────
  const configured = customerId != null && isEntryBound(entry);
  // "Change" is offered only while the live canvas is up (configured + not already
  // re-staging) — it re-opens setup pre-filled from the committed doc.
  const showChange = configured && !editing;

  const validation = validateFlow(getDoc());
  const hasErrors = !validation.ok;
  const compiledPreview = JSON.stringify(compileFlow(getDoc()), null, 2);

  // ── Flow actions ─────────────────────────────────────────────────────────
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
      // Reflect the loaded selection into staging so the summary fills in.
      seedSetup({ customerId: flow.customer_id, product: flow.product, lineKey: entryKey(flow.entry) });
      toastOk(`Loaded "${flow.name}"`);
    } catch (e) {
      toastErr(e instanceof ApiError ? e.message : 'Failed to load flow');
    }
  };

  const handleNewFlow = (p: ProductKind) => {
    newFlow(p);
    resetSetup();
    setNewOpen(false);
    toastOk(`New ${PRODUCT_LABELS[p]} flow — pick a customer + line to start`);
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
      seedSetup({ customerId: doc.customerId, product: doc.product, lineKey: entryKey(doc.entry) });
      setImportOpen(false);
      toastOk(`Imported "${row.name}" — review, then Save to create a call flow`);
    } catch {
      toastErr('Could not import this IVR flow');
    }
  };

  const handleChange = () =>
    beginEdit({ customerId, product, lineKey: entryKey(entry) });

  const setName = (v: string) => patchDoc({ name: v });

  const moreItems: MoreItem[] = [
    { label: 'New flow…', onClick: () => setNewOpen(true) },
    { label: 'Import IVR…', onClick: () => setImportOpen(true) },
    { label: 'Preview compiled…', onClick: () => setPreviewOpen(true) },
    {
      label: 'Version history…',
      onClick: () => setHistoryOpen(true),
      disabled: docId == null,
      title: docId == null ? 'Save the flow to enable version history' : undefined,
    },
    {
      label: 'Simulate…',
      onClick: () => setSimulateOpen(true),
      disabled: docId == null,
      title: docId == null ? 'Save the flow to enable simulation' : undefined,
    },
  ];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '10px 16px',
        background: 'linear-gradient(180deg, #161922 0%, #13151d 100%)',
        borderBottom: '1px solid rgba(42,47,69,0.6)',
      }}
    >
      {/* ── Row 1 — brand + the live selection summary ─────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <span
            style={{
              width: 3,
              height: 22,
              borderRadius: 2,
              background: 'linear-gradient(180deg, #22d3ee 0%, #0891b2 100%)',
              boxShadow: '0 0 10px rgba(34,211,238,0.45)',
            }}
          />
          <span
            style={{
              fontSize: '0.95rem',
              fontWeight: 800,
              color: '#e2e8f0',
              letterSpacing: '-0.01em',
              whiteSpace: 'nowrap',
            }}
          >
            Call Flow Builder
          </span>
        </div>

        <SetupSummary />

        <div style={{ flex: 1, minWidth: 8 }} />

        {showChange && (
          <Button variant="ghost" size="sm" onClick={handleChange}>
            Change
          </Button>
        )}
      </div>

      {/* ── Row 2 — flow identity + actions ────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <InlineField label="Flow name">
          <input style={{ ...inputStyle, width: 200 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Untitled Flow" />
        </InlineField>

        <span
          style={{
            flexShrink: 0,
            padding: '4px 9px',
            borderRadius: 6,
            fontSize: '0.66rem',
            fontWeight: 800,
            textTransform: 'uppercase',
            lineHeight: 1.2,
            color: status === 'published' ? '#22c55e' : '#f59e0b',
            background: status === 'published' ? 'rgba(34,197,94,0.12)' : 'rgba(245,158,11,0.12)',
            border: `1px solid ${status === 'published' ? 'rgba(34,197,94,0.4)' : 'rgba(245,158,11,0.4)'}`,
          }}
        >
          {status}
          {docId != null ? ` · #${docId}` : ''}
        </span>

        <InlineField label="Open flow">
          <select
            style={{ ...inputStyle, width: 180, cursor: 'pointer' }}
            value=""
            onChange={(e) => e.target.value && handleLoad(Number(e.target.value))}
          >
            <option value="">{flowsQuery.isLoading ? 'Loading…' : 'Open a saved flow…'}</option>
            {flowsQuery.data?.items.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} ({f.status})
              </option>
            ))}
          </select>
        </InlineField>

        <div style={{ flex: 1, minWidth: 8 }} />

        {/* Edit history */}
        <div style={{ display: 'flex', gap: 6 }}>
          <Button variant="ghost" size="sm" onClick={() => undo()} disabled={!canUndo}>Undo</Button>
          <Button variant="ghost" size="sm" onClick={() => redo()} disabled={!canRedo}>Redo</Button>
        </div>

        {/* Less-used actions, grouped behind an overflow menu */}
        <MoreMenu items={moreItems} />

        {/* Primary actions */}
        <div style={{ display: 'flex', gap: 6 }}>
          <Button
            variant="primary"
            size="sm"
            loading={saveMutation.isPending}
            disabled={!configured}
            title={!configured ? 'Select a customer, product, and line first' : undefined}
            onClick={() => saveMutation.mutate()}
          >
            Save
          </Button>
          <Button
            variant="success"
            size="sm"
            loading={publishMutation.isPending}
            disabled={!configured || hasErrors}
            title={!configured ? 'Select a customer, product, and line first' : undefined}
            onClick={() => publishMutation.mutate(false)}
          >
            Publish
          </Button>
        </div>
      </div>

      <FlowHistoryModal open={historyOpen} onClose={() => setHistoryOpen(false)} flowId={docId ?? null} />
      {/* Mounted only while open: every open starts with fresh lazy-initialised
          state ("now" timestamp, pristine mutation) — see the freshness contract
          note in FlowSimulateModal. */}
      {simulateOpen && (
        <FlowSimulateModal open onClose={() => setSimulateOpen(false)} flowId={docId ?? null} />
      )}

      {/* Overwrite-guard — shown when publish returns 409 because the live config
          has diverged. The server's detail names the DID + current vs new forward. */}
      <Modal
        open={publishConflict != null}
        onClose={() => setPublishConflict(null)}
        title="Live config has changed"
        maxWidth="max-w-md"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setPublishConflict(null)}>
              Cancel
            </Button>
            <Button
              variant="success"
              size="sm"
              loading={publishMutation.isPending}
              onClick={() => {
                setPublishConflict(null);
                publishMutation.mutate(true);
              }}
            >
              Overwrite &amp; publish
            </Button>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: '0.82rem', color: '#94a3b8', lineHeight: 1.6 }}>
          {publishConflict}
        </p>
      </Modal>

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

      {/* New-flow product selector — picks palette + compiler + tag. */}
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New call flow — choose a product">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ margin: 0, fontSize: '0.78rem', color: '#94a3b8', lineHeight: 1.5 }}>
            The product sets the node palette, the compiler, and how this flow publishes.
            (This clears the current canvas — you'll then pick a customer + line to start building.)
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

/* ─── Selection summary — the live mirror of the centre card ───────────────── */

/**
 * Read-only customer · product · line breadcrumb that "fills in" live as the
 * operator picks in the centre setup card. Reads the shared `setupStore` (the
 * staged customer + product) and the committed doc (the bound line), so it tracks
 * both mid-setup staging AND a configured flow. The card is the input — this never
 * edits; the toolbar's "Change" is what re-opens setup.
 *
 * React #310: the customers query + store reads are unconditional at the top.
 */
function SetupSummary() {
  const customersQuery = useQuery({
    queryKey: ['customers-dropdown'],
    queryFn: () => listCustomers({ limit: 500 }),
    staleTime: 60_000,
  });
  const stgCustomerId = useSetupStore((s) => s.customerId);
  const stgProduct = useSetupStore((s) => s.product);
  const docCustomerId = useFlowStore((s) => s.doc.customerId);
  const docProduct = useFlowStore((s) => s.doc.product);
  const docEntry = useFlowStore((s) => s.doc.entry);

  // Derived (no hooks below).
  const configured = docCustomerId != null && isEntryBound(docEntry);
  // Staging is seeded on every load/commit, so it's the live source for the first
  // two segments; fall back to the committed doc for safety.
  const custId = stgCustomerId ?? (configured ? docCustomerId : null);
  const prod = stgProduct ?? (configured ? docProduct : null);

  const customers = customersQuery.data?.items ?? [];
  const customerName =
    custId != null ? customers.find((c) => c.id === custId)?.name ?? `Customer #${custId}` : null;
  const productName = prod != null ? PRODUCT_LABELS[prod] : null;
  const line = configured ? lineText(docEntry) : null;

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 9,
        minWidth: 0,
        padding: '5px 12px',
        borderRadius: 9,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        background: configured ? 'rgba(34,211,238,0.08)' : 'rgba(26,29,39,0.7)',
        border: `1px solid ${configured ? 'rgba(34,211,238,0.3)' : 'rgba(42,47,69,0.6)'}`,
      }}
    >
      <span style={{ fontSize: '0.7rem', color: configured ? '#22d3ee' : '#475569', flexShrink: 0 }}>●</span>
      <Seg value={customerName} placeholder="Customer" />
      <Sep />
      <Seg value={productName} placeholder="Product" />
      <Sep />
      <Seg value={line} placeholder="Line" accent />
    </div>
  );
}

function Seg({ value, placeholder, accent = false }: { value: string | null; placeholder: string; accent?: boolean }) {
  const filled = value != null && value !== '';
  return (
    <span
      style={{
        fontSize: '0.78rem',
        fontWeight: filled ? 700 : 600,
        color: filled ? (accent ? '#22d3ee' : '#e2e8f0') : '#475569',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        minWidth: 0,
      }}
    >
      {filled ? value : placeholder}
    </span>
  );
}

function Sep() {
  return <span aria-hidden="true" style={{ fontSize: '0.72rem', color: '#475569', flexShrink: 0 }}>·</span>;
}

/* ─── Actions overflow menu ────────────────────────────────────────────────── */

interface MoreItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}

/**
 * Compact "More ▾" popover grouping the least-used actions so the toolbar
 * doesn't wrap chaotically. React #310: all hooks declared unconditionally.
 */
function MoreMenu({ items }: { items: MoreItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
        More ▾
      </Button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 50,
            width: 210,
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
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              title={it.title}
              onClick={() => {
                if (it.disabled) return;
                setOpen(false);
                it.onClick();
              }}
              style={{
                textAlign: 'left',
                padding: '8px 10px',
                borderRadius: 8,
                cursor: it.disabled ? 'not-allowed' : 'pointer',
                fontSize: '0.8rem',
                fontWeight: 600,
                color: it.disabled ? '#475569' : '#e2e8f0',
                background: 'transparent',
                border: '1px solid transparent',
                transition: 'background 0.12s',
              }}
              onMouseEnter={(e) => {
                if (!it.disabled) e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Shared field primitives ──────────────────────────────────────────────── */

/** Inline label + control on one baseline — keeps Row 2 vertically centred. */
function InlineField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
      <span
        style={{
          fontSize: '0.6rem',
          fontWeight: 800,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: '#4a5568',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  height: 32,
  padding: '0 10px',
  borderRadius: 8,
  fontSize: '0.8rem',
  color: '#e2e8f0',
  background: '#1e2130',
  border: '1px solid #2a2f45',
  outline: 'none',
};
