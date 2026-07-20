/**
 * Builder layout shell: toolbar across the top, then the workspace.
 *
 * The workspace is GATED behind a Customer → Product → Line selection: a flow can
 * only be built once a concrete line + product are known (they define the flow's
 * capabilities). Until the doc is "configured" (a customer + a bound line — see
 * `model/setup.isFlowConfigured`) — or while the operator has re-opened setup via
 * the toolbar's "Change" (`setupStore.editing`) — we render the centred,
 * INTERACTIVE "Set up this flow" card instead of the live palette + canvas, so the
 * operator can't drag nodes onto a flow with no line.
 *
 * The setup card IS the primary input: its three numbered steps each carry a real
 * dropdown (Customer / Product / Line). Picking the line commits and initialises a
 * fresh flow, flipping `isFlowConfigured` true so the card is replaced by the live
 * palette (left), canvas (centre), and config + validation panels (right). The
 * selection is staged in the shared `setupStore` so the toolbar mirrors it live.
 *
 * React #310: every store/query read in each component is unconditional at the top,
 * before any early return. The setup card is a separate component, so its hooks are
 * only ever mounted as a whole (never half-rendered).
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useFlowStore, useFlowTemporal } from './store/flowStore';
import { useSetupStore } from './store/setupStore';
import {
  entryKey,
  entryLabel,
  fetchLines,
  isFlowConfigured,
  productsForAccountType,
  type LineOption,
} from './model/setup';
import { PRODUCT_LABELS } from './model/palette';
import { fromLiveRcf } from './compile/fromLiveConfig';
import { getCallFlow, listCallFlows } from '../api/callFlows';
import { listCustomers } from '../api/customers';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { fmt } from '../utils/format';
import type { EntryBinding, ProductKind } from './model/types';
import { FlowToolbar } from './toolbar/FlowToolbar';
import { NodePalette } from './palette/NodePalette';
import { CallFlowCanvas } from './CallFlowCanvas';
import { NodeConfigPanel } from './config/NodeConfigPanel';
import { ValidationPanel } from './validation/ValidationPanel';

export function FlowBuilderShell() {
  // Hooks first (React #310).
  const customerId = useFlowStore((s) => s.doc.customerId);
  const entry = useFlowStore((s) => s.doc.entry);
  const editing = useSetupStore((s) => s.editing);
  const configured = isFlowConfigured({ customerId, entry });

  // Show the live workspace only once configured AND not mid-"Change".
  const showWorkspace = configured && !editing;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <FlowToolbar />

      {showWorkspace ? (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <HydrationBanner key={entryKey(entry)} />
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            <NodePalette />

            <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
              <CallFlowCanvas />
            </div>

            <div
              style={{
                width: 280,
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                background: '#13151d',
                borderLeft: '1px solid rgba(42,47,69,0.6)',
                minHeight: 0,
              }}
            >
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                <NodeConfigPanel />
              </div>
              <div style={{ height: 220, flexShrink: 0, borderTop: '1px solid rgba(42,47,69,0.6)' }}>
                <ValidationPanel />
              </div>
            </div>
          </div>
        </div>
      ) : (
        <GuidedSetup />
      )}
    </div>
  );
}

/* ─── Guided setup card — the primary, interactive setup surface ───────────── */

/**
 * Shown until a customer + product + line are chosen (or while "Change" re-opens
 * setup). A polished, on-brand card whose three numbered steps each carry the real
 * control:
 *   1 Customer — always enabled; drives the allowed product list.
 *   2 Product  — enabled once a customer is chosen; options from the account type.
 *   3 Line     — enabled once a product is chosen; the customer's provisioned lines.
 *
 * Picking a line commits: `newFlow(product)` then `patchDoc({customerId, entry,
 * name})`, which flips `isFlowConfigured` true → this card is replaced by the live
 * canvas. If the canvas already has content, a confirm modal gates the reset. The
 * staged selection lives in `setupStore` so the toolbar summary mirrors it live.
 *
 * React #310: all hooks are declared unconditionally at the top.
 */
function GuidedSetup() {
  // Shared staging (mirrored by the toolbar summary).
  const selCustomerId = useSetupStore((s) => s.customerId);
  const selProduct = useSetupStore((s) => s.product);
  const lineKey = useSetupStore((s) => s.lineKey);
  const setCustomer = useSetupStore((s) => s.setCustomer);
  const setProduct = useSetupStore((s) => s.setProduct);
  const setLineKey = useSetupStore((s) => s.setLineKey);
  const seed = useSetupStore((s) => s.seed);
  const setHydratedFrom = useSetupStore((s) => s.setHydratedFrom);
  const endEdit = useSetupStore((s) => s.endEdit);

  // Flow doc — for the confirm-on-content guard + the editing-existing-flow case.
  const docCustomerId = useFlowStore((s) => s.doc.customerId);
  const docEntry = useFlowStore((s) => s.doc.entry);
  const nodes = useFlowStore((s) => s.nodes);
  const edges = useFlowStore((s) => s.edges);
  const docName = useFlowStore((s) => s.doc.name);
  const docId = useFlowStore((s) => s.doc.id);
  const patchDoc = useFlowStore((s) => s.patchDoc);
  const newFlow = useFlowStore((s) => s.newFlow);
  const loadDoc = useFlowStore((s) => s.loadDoc);
  const { toastOk } = useToast();

  const [pendingLine, setPendingLine] = useState<LineOption | null>(null);

  const customersQuery = useQuery({
    queryKey: ['customers-dropdown'],
    queryFn: () => listCustomers({ limit: 500 }),
    staleTime: 60_000,
  });

  const linesQuery = useQuery({
    queryKey: ['flow-lines', selCustomerId, selProduct],
    queryFn: () => fetchLines(selCustomerId as number, selProduct as ProductKind),
    enabled: selCustomerId != null && selProduct != null,
  });

  // ── Derived (no hooks below) ──────────────────────────────────────────────
  const customers = customersQuery.data?.items ?? [];
  const selectedCustomer = customers.find((c) => c.id === selCustomerId);
  const productOptions = productsForAccountType(selectedCustomer?.account_type);
  const lines = linesQuery.data ?? [];
  const productDisabled = selCustomerId == null;
  const lineDisabled = selCustomerId == null || selProduct == null;

  // True when an already-configured flow had its setup re-opened ("Change") — we
  // offer a Cancel back to the live canvas in that case only.
  const reopened = isFlowConfigured({ customerId: docCustomerId, entry: docEntry });

  // Switching the bound line starts a fresh flow (palette + compiler rebuilt), so
  // existing work is confirmed first.
  const hasContent =
    nodes.length > 1 ||
    edges.length > 0 ||
    docId != null ||
    (docName.trim() !== '' && docName !== 'Untitled Flow');

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handlePickCustomer = (id: number | null) => {
    setCustomer(id);
    if (id == null) return;
    // Auto-select the product when the customer has exactly one (rcf/api/trunk/
    // ucaas accounts) — only `hybrid` needs an explicit product step.
    const opts = productsForAccountType(customers.find((c) => c.id === id)?.account_type);
    if (opts.length === 1) setProduct(opts[0]);
  };

  /**
   * Commit a chosen line with 3-way hydration precedence (newest → oldest):
   *   (a) saved   — an existing `call_flows` row bound to this line → load it.
   *   (b) live    — RCF only: the line's live `rcf_numbers` config → rebuild it.
   *   (c) fresh   — nothing to hydrate → an empty draft for the product.
   * Any hydration failure falls back to a fresh flow. The resulting source is
   * recorded in `setupStore.hydratedFrom` to drive the review banner.
   */
  const commitLine = async (opt: LineOption) => {
    if (selProduct == null || selCustomerId == null) return;
    const product = selProduct;
    const customer = selCustomerId;
    const freshName = `${opt.label} flow`;

    const buildFresh = () => {
      newFlow(product);
      patchDoc({ customerId: customer, entry: opt.binding, name: freshName });
    };

    let source: 'saved' | 'live' | 'fresh' = 'fresh';
    try {
      // (a) An existing saved flow for this exact line wins.
      const existing = await listCallFlows({ product, customer_id: customer });
      const match = existing.items.find((f) => bindingMatches(f.entry, opt.binding));
      if (match) {
        const flow = await getCallFlow(match.id);
        loadDoc(flow.flow_graph);
        patchDoc({
          id: flow.id,
          product: flow.product,
          name: flow.name,
          status: flow.status,
          version: flow.version,
          customerId: flow.customer_id,
          entry: flow.entry,
        });
        source = 'saved';
      } else if (product === 'rcf' && opt.raw && opt.raw.forward_to) {
        // (b) No saved flow, but the RCF line has a live config to hydrate from.
        const doc = fromLiveRcf(opt.raw);
        if (doc) {
          loadDoc(doc);
          patchDoc({ customerId: customer, entry: opt.binding, name: freshName });
          source = 'live';
        } else {
          buildFresh();
        }
      } else {
        // (c) Nothing to hydrate — a clean draft.
        buildFresh();
      }
    } catch {
      buildFresh();
      source = 'fresh';
    }

    // Reflect the committed selection back into staging (also exits edit mode),
    // then stamp where the canvas came from so the banner can react.
    seed({ customerId: customer, product, lineKey: opt.key });
    setHydratedFrom(source);

    if (source === 'saved') {
      toastOk(`Opened saved flow for ${opt.label}`);
    } else if (source === 'live') {
      toastOk(`Imported live config for ${opt.label} — review before publishing`);
    } else {
      toastOk(`Building ${PRODUCT_LABELS[product]} flow for ${opt.label}`);
    }
  };

  const handlePickLineKey = (key: string) => {
    if (!key) return;
    const opt = lines.find((o) => o.key === key);
    if (!opt) return;
    setLineKey(key);
    if (hasContent) {
      setPendingLine(opt);
    } else {
      void commitLine(opt);
    }
  };

  const confirmPendingLine = () => {
    if (pendingLine) void commitLine(pendingLine);
    setPendingLine(null);
  };

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
        overflowY: 'auto',
        background:
          'radial-gradient(circle at 50% 0%, rgba(34,211,238,0.06) 0%, rgba(15,17,23,0) 60%), #0f1117',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 520,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 22,
          padding: '34px 32px',
          borderRadius: 18,
          textAlign: 'center',
          background: 'linear-gradient(180deg, #161922 0%, #13151d 100%)',
          border: '1px solid rgba(42,47,69,0.6)',
          boxShadow: '0 24px 64px -24px rgba(0,0,0,0.8)',
        }}
      >
        <span
          style={{
            width: 48,
            height: 48,
            borderRadius: 14,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1.4rem',
            color: '#22d3ee',
            background: 'rgba(34,211,238,0.12)',
            border: '1px solid rgba(34,211,238,0.35)',
            boxShadow: '0 0 18px rgba(34,211,238,0.25)',
          }}
        >
          ●
        </span>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 800, color: '#e2e8f0', letterSpacing: '-0.01em' }}>
            {reopened ? 'Change this flow’s line' : 'Set up this flow'}
          </h2>
          <p style={{ margin: 0, fontSize: '0.85rem', color: '#94a3b8', lineHeight: 1.6 }}>
            Select a customer, product, and line to start building this flow. The line and
            product define which call-handling capabilities are available.
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
          <SetupStep
            n={1}
            title="Pick a customer"
            detail="Who owns this flow."
            state={selCustomerId == null ? 'todo' : 'done'}
          >
            <select
              style={cardSelectStyle(false)}
              value={selCustomerId ?? ''}
              onChange={(e) => handlePickCustomer(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">{customersQuery.isLoading ? 'Loading customers…' : 'Select customer…'}</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.account_type.toUpperCase()})
                </option>
              ))}
            </select>
          </SetupStep>

          <SetupStep
            n={2}
            title="Pick a product"
            detail="RCF, API, SIP Trunk, or UCaaS — from the customer’s account."
            disabled={productDisabled}
            state={productDisabled ? 'locked' : selProduct == null ? 'todo' : 'done'}
          >
            <select
              style={cardSelectStyle(productDisabled)}
              disabled={productDisabled}
              value={selProduct ?? ''}
              onChange={(e) => setProduct(e.target.value ? (e.target.value as ProductKind) : null)}
            >
              <option value="">Select product…</option>
              {productOptions.map((p) => (
                <option key={p} value={p}>
                  {PRODUCT_LABELS[p]}
                </option>
              ))}
            </select>
          </SetupStep>

          <SetupStep
            n={3}
            title="Pick a line"
            detail="The DID, trunk, or extension this flow answers."
            disabled={lineDisabled}
            state={lineDisabled ? 'locked' : lineKey ? 'done' : 'todo'}
          >
            <select
              style={cardSelectStyle(lineDisabled)}
              disabled={lineDisabled}
              value={lineKey}
              onChange={(e) => handlePickLineKey(e.target.value)}
            >
              <option value="">
                {linesQuery.isLoading
                  ? 'Loading lines…'
                  : lineDisabled
                    ? 'Select line…'
                    : lines.length === 0
                      ? `No ${PRODUCT_LABELS[selProduct as ProductKind]} lines for this customer`
                      : 'Select line…'}
              </option>
              {lines.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </SetupStep>
        </div>

        {reopened ? (
          <Button variant="ghost" size="sm" onClick={() => endEdit()}>
            Cancel — keep current flow
          </Button>
        ) : (
          <p style={{ margin: 0, fontSize: '0.72rem', color: '#64748b', lineHeight: 1.5 }}>
            Already have a flow? Open it or import a legacy IVR from{' '}
            <strong style={{ color: '#94a3b8' }}>More ▾</strong> in the bar above.
          </p>
        )}
      </div>

      {/* Confirm a line change on a non-empty canvas — it starts a fresh flow. */}
      <Modal
        open={pendingLine != null}
        onClose={() => setPendingLine(null)}
        title="Start a new flow?"
        maxWidth="max-w-md"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setPendingLine(null)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={confirmPendingLine}>
              Start fresh
            </Button>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: '0.82rem', color: '#94a3b8', lineHeight: 1.6 }}>
          Binding this flow to{' '}
          <strong style={{ color: '#22d3ee' }}>{pendingLine?.label}</strong> starts a{' '}
          <strong style={{ color: '#e2e8f0' }}>fresh flow</strong> and clears the current canvas. This can’t be undone.
        </p>
      </Modal>
    </div>
  );
}

/* ─── Binding equality (saved-flow lookup) ─────────────────────────────────── */

/** Two entry bindings point at the same line when kind + identifier both match. */
function bindingMatches(a: EntryBinding, b: EntryBinding): boolean {
  return a.kind === b.kind && entryKey(a) === entryKey(b);
}

/* ─── Hydration banner — "imported from live, review before publishing" ──────── */

/**
 * Thin bar shown above the canvas when the line's flow was hydrated from an
 * existing source (live RCF config or a saved flow), prompting a review before
 * publish. It auto-dismisses the moment the operator makes a graph edit (zundo's
 * `pastStates` grows past the post-load reset) and offers a "Start fresh" action
 * that blanks the canvas for the same line.
 *
 * Mounted with `key={entryKey(entry)}` by the shell, so switching lines remounts
 * it (resetting the local dismissed flag). React #310: all hooks are at the top.
 */
function HydrationBanner() {
  const hydratedFrom = useSetupStore((s) => s.hydratedFrom);
  const setHydratedFrom = useSetupStore((s) => s.setHydratedFrom);
  const entry = useFlowStore((s) => s.doc.entry);
  const product = useFlowStore((s) => s.doc.product);
  const name = useFlowStore((s) => s.doc.name);
  const customerId = useFlowStore((s) => s.doc.customerId);
  const newFlow = useFlowStore((s) => s.newFlow);
  const patchDoc = useFlowStore((s) => s.patchDoc);
  // loadDoc clears the undo timeline, so any past state = a real post-load edit.
  const edited = useFlowTemporal((s) => s.pastStates.length > 0);
  const [dismissed, setDismissed] = useState(false);

  // Only show for hydrated-from-source canvases that are still untouched.
  if (dismissed || edited || (hydratedFrom !== 'live' && hydratedFrom !== 'saved')) {
    return null;
  }

  const did = entry.kind === 'did' ? fmt(entry.did) || entry.did : entryLabel(entry);
  const message =
    hydratedFrom === 'live'
      ? `Imported from current live config for ${did} — review before publishing.`
      : `Opened the saved flow for ${did} — review before publishing.`;

  const startFresh = () => {
    newFlow(product);
    patchDoc({ customerId, entry, name });
    setHydratedFrom('fresh');
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexShrink: 0,
        padding: '8px 16px',
        fontSize: '0.78rem',
        color: '#e2e8f0',
        background: 'rgba(34,211,238,0.08)',
        borderBottom: '1px solid rgba(34,211,238,0.3)',
      }}
    >
      <span style={{ color: '#22d3ee', flexShrink: 0 }}>●</span>
      <span style={{ flex: 1, minWidth: 0, lineHeight: 1.5 }}>{message}</span>
      <Button variant="ghost" size="xs" onClick={startFresh}>
        Start fresh
      </Button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        style={{
          flexShrink: 0,
          width: 22,
          height: 22,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 6,
          cursor: 'pointer',
          color: '#94a3b8',
          background: 'transparent',
          border: '1px solid transparent',
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  );
}

/* ─── Setup-card step ──────────────────────────────────────────────────────── */

type StepState = 'locked' | 'todo' | 'done';

function SetupStep({
  n,
  title,
  detail,
  state,
  disabled = false,
  children,
}: {
  n: number;
  title: string;
  detail: string;
  state: StepState;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const badgeColor = state === 'done' ? '#22d3ee' : disabled ? '#475569' : '#94a3b8';
  const badgeBg = state === 'done' ? 'rgba(34,211,238,0.15)' : 'rgba(148,163,184,0.08)';
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: '12px 14px',
        borderRadius: 12,
        textAlign: 'left',
        background: 'rgba(26,29,39,0.7)',
        border: `1px solid ${state === 'done' ? 'rgba(34,211,238,0.3)' : 'rgba(42,47,69,0.6)'}`,
        opacity: disabled ? 0.6 : 1,
        transition: 'border-color 0.15s, opacity 0.15s',
      }}
    >
      <span
        style={{
          width: 24,
          height: 24,
          flexShrink: 0,
          marginTop: 1,
          borderRadius: '50%',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '0.74rem',
          fontWeight: 800,
          color: badgeColor,
          background: badgeBg,
          border: `1px solid ${badgeColor}66`,
        }}
      >
        {state === 'done' ? '✓' : n}
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 }}>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#e2e8f0' }}>{title}</span>
          <span style={{ fontSize: '0.7rem', color: '#64748b' }}>{detail}</span>
        </span>
        {children}
      </div>
    </div>
  );
}

/** Full-width select inside a setup step — disabled steps are dimmed + inert. */
function cardSelectStyle(disabled: boolean): React.CSSProperties {
  return {
    width: '100%',
    height: 38,
    marginTop: 2,
    padding: '0 12px',
    borderRadius: 8,
    fontSize: '0.82rem',
    color: '#e2e8f0',
    background: '#1e2130',
    border: '1px solid #2a2f45',
    outline: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}
