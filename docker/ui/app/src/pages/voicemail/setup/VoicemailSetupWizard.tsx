import { useReducer, useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, Link2, Search, Check, ChevronLeft, Loader2, ArrowRightLeft } from 'lucide-react';
import { Modal } from '../../../components/ui/Modal';
import { Button } from '../../../components/ui/Button';
import { useToast } from '../../../components/ui/Toast';
import { fmt } from '../../../utils/format';
import { listAvailableDids, listMyDids, requestDid } from '../../../api/didInventory';
import {
  createMailbox,
  createBinding,
  setMailboxPin,
  updateMailboxSettings,
} from '../../../api/voicemail';
import { EncryptionBadge } from '../shared/EncryptionBadge';
import type { AttachProduct } from '../../../types/voicemail';

/* ─────────────────────────────────────────────────────────────────────────
 * Wizard state
 * ──────────────────────────────────────────────────────────────────────── */

type DeliveryModel = 'dedicated_did' | 'attached';
type BuyMode = 'search' | 'port';

const ACCENT = '#818cf8';
const ATTACH_PRODUCTS: AttachProduct[] = ['rcf', 'trunk', 'ucaas', 'api'];
const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
];

interface WizardState {
  step: 1 | 2 | 3 | 4;
  delivery: DeliveryModel | null;
  buyMode: BuyMode;
  selectedDid: string | null;
  portNumber: string;
  attachProduct: AttachProduct | null;
  attachRef: string | null;
  label: string;
  timezone: string;
  pin: string;
  notifyEmail: boolean;
  notifyEmailAddress: string;
}

const initialState: WizardState = {
  step: 1,
  delivery: null,
  buyMode: 'search',
  selectedDid: null,
  portNumber: '',
  attachProduct: null,
  attachRef: null,
  label: '',
  timezone: 'America/New_York',
  pin: '',
  notifyEmail: false,
  notifyEmailAddress: '',
};

type Action =
  | { type: 'setDelivery'; delivery: DeliveryModel }
  | { type: 'setBuyMode'; mode: BuyMode }
  | { type: 'selectDid'; did: string | null }
  | { type: 'selectAttach'; product: AttachProduct; ref: string }
  | { type: 'patch'; patch: Partial<WizardState> }
  | { type: 'next' }
  | { type: 'back' };

function reducer(state: WizardState, action: Action): WizardState {
  switch (action.type) {
    case 'setDelivery':
      return { ...state, delivery: action.delivery };
    case 'setBuyMode':
      return { ...state, buyMode: action.mode, selectedDid: null };
    case 'selectDid':
      return { ...state, selectedDid: action.did };
    case 'selectAttach':
      return { ...state, attachProduct: action.product, attachRef: action.ref };
    case 'patch':
      return { ...state, ...action.patch };
    case 'next':
      return { ...state, step: Math.min(4, state.step + 1) as WizardState['step'] };
    case 'back':
      return { ...state, step: Math.max(1, state.step - 1) as WizardState['step'] };
    default:
      return state;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Wizard
 * ──────────────────────────────────────────────────────────────────────── */

interface VoicemailSetupWizardProps {
  open: boolean;
  onClose: () => void;
  /** Called with the new mailbox id after a successful create. */
  onCreated: (mailboxId: number) => void;
  /** Admin-only: provision the mailbox for this customer. */
  customerId?: number;
}

export function VoicemailSetupWizard({ open, onClose, onCreated, customerId }: VoicemailSetupWizardProps) {
  // All hooks unconditionally at the top (React #310).
  const [state, dispatch] = useReducer(reducer, initialState);
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { toastOk, toastErr } = useToast();
  const queryClient = useQueryClient();

  const availableQuery = useQuery({
    queryKey: ['voicemail', 'available-dids', search],
    queryFn: () => listAvailableDids({ search: search || undefined, limit: 40 }),
    enabled: open && state.step === 2 && state.delivery === 'dedicated_did' && state.buyMode === 'search',
    staleTime: 30_000,
  });

  const myDidsQuery = useQuery({
    queryKey: ['voicemail', 'my-dids'],
    queryFn: () => listMyDids(),
    enabled: open && state.step === 2 && state.delivery === 'attached',
    staleTime: 30_000,
  });

  /* ── step gating ──────────────────────────────────────────── */

  const pinValid = state.pin === '' || (/^\d{4,10}$/.test(state.pin));
  const emailValid = !state.notifyEmail || state.notifyEmailAddress.trim().length > 3;

  const canAdvance = (): boolean => {
    switch (state.step) {
      case 1:
        return state.delivery !== null;
      case 2:
        if (state.delivery === 'dedicated_did') {
          return state.buyMode === 'search'
            ? state.selectedDid !== null
            : state.portNumber.trim().length >= 7;
        }
        return state.attachProduct !== null && !!state.attachRef;
      case 3:
        return state.label.trim().length > 0 && pinValid && emailValid;
      default:
        return true;
    }
  };

  const reset = useCallback(() => {
    dispatch({ type: 'patch', patch: initialState });
    setSearch('');
  }, []);

  const handleClose = useCallback(() => {
    if (submitting) return;
    reset();
    onClose();
  }, [submitting, reset, onClose]);

  /* ── finish — create mailbox, bind, PIN/settings ───────────── */

  const handleFinish = useCallback(async () => {
    setSubmitting(true);
    try {
      const mailbox = await createMailbox({
        label: state.label.trim(),
        timezone: state.timezone,
        customer_id: customerId,
      });

      let bindingPending = false;

      if (state.delivery === 'dedicated_did') {
        const did = state.buyMode === 'search' ? state.selectedDid! : state.portNumber.trim();
        try {
          await createBinding(mailbox.id, { binding_type: 'dedicated_did', did });
        } catch {
          // A customer can't bind a DID that isn't yet assigned to them (SEC-3).
          // Reserve it for admin assignment and leave the mailbox pending.
          bindingPending = true;
          try {
            await requestDid(did, `Voicemail mailbox #${mailbox.id} access number`);
          } catch {
            /* number not in our inventory (port) — provisioning handles it */
          }
        }
      } else {
        await createBinding(mailbox.id, {
          binding_type: 'attached',
          attach_product: state.attachProduct!,
          attach_ref: state.attachRef!,
        });
      }

      if (state.pin) await setMailboxPin(mailbox.id, state.pin);
      if (state.notifyEmail && state.notifyEmailAddress.trim()) {
        await updateMailboxSettings(mailbox.id, {
          notify_email: true,
          notify_email_address: state.notifyEmailAddress.trim(),
        });
      }

      void queryClient.invalidateQueries({ queryKey: ['voicemail', 'mailboxes'] });
      if (bindingPending) {
        toastOk(`Mailbox created. We've requested the number — it'll activate once our team assigns it.`);
      } else {
        toastOk(`Voicemail mailbox "${mailbox.label ?? mailbox.id}" is ready.`);
      }
      reset();
      onCreated(mailbox.id);
    } catch (err) {
      toastErr(err instanceof Error ? err.message : 'Could not create the mailbox');
    } finally {
      setSubmitting(false);
    }
  }, [state, customerId, queryClient, toastOk, toastErr, reset, onCreated]);

  /* ── footer ───────────────────────────────────────────────── */

  const footer = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
      <div style={{ display: 'flex', gap: 5 }}>
        {[1, 2, 3, 4].map((s) => (
          <span
            key={s}
            style={{
              width: state.step === s ? 22 : 7,
              height: 7,
              borderRadius: 4,
              background: s <= state.step ? ACCENT : 'rgba(148,163,184,0.25)',
              transition: 'all 0.2s',
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {state.step > 1 && (
          <Button variant="ghost" size="sm" onClick={() => dispatch({ type: 'back' })} disabled={submitting} icon={<ChevronLeft size={14} />}>
            Back
          </Button>
        )}
        {state.step < 4 ? (
          <Button size="sm" onClick={() => dispatch({ type: 'next' })} disabled={!canAdvance()}>
            Continue
          </Button>
        ) : (
          <Button size="sm" onClick={() => void handleFinish()} loading={submitting} icon={<Check size={14} />}>
            Create mailbox
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <Modal open={open} onClose={handleClose} title="Set up a voicemail box" footer={footer} maxWidth="max-w-2xl">
      <div style={{ minHeight: 360 }}>
        {state.step === 1 && <StepDelivery state={state} dispatch={dispatch} />}
        {state.step === 2 && (
          <StepNumber
            state={state}
            dispatch={dispatch}
            search={search}
            setSearch={setSearch}
            availableLoading={availableQuery.isLoading}
            availableDids={availableQuery.data ?? []}
            myDidsLoading={myDidsQuery.isLoading}
            myDids={myDidsQuery.data ?? []}
          />
        )}
        {state.step === 3 && <StepPersonalize state={state} dispatch={dispatch} pinValid={pinValid} emailValid={emailValid} />}
        {state.step === 4 && <StepReview state={state} />}
      </div>
    </Modal>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Step 1 — delivery model
 * ──────────────────────────────────────────────────────────────────────── */

function StepDelivery({ state, dispatch }: { state: WizardState; dispatch: React.Dispatch<Action> }) {
  return (
    <div>
      <p style={{ color: '#94a3b8', fontSize: '0.85rem', lineHeight: 1.6, marginBottom: 20 }}>
        How should callers reach this voicemail box? Both options keep the number on
        our platform, so messages route deterministically — no carrier setup required.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <DeliveryCard
          active={state.delivery === 'dedicated_did'}
          icon={<Phone size={20} />}
          title="Buy a voicemail number"
          body="We provision a dedicated number that goes straight to this mailbox. Best for a standalone voicemail line."
          onClick={() => dispatch({ type: 'setDelivery', delivery: 'dedicated_did' })}
        />
        <DeliveryCard
          active={state.delivery === 'attached'}
          icon={<Link2 size={20} />}
          title="Add to a line you already have"
          body="Attach voicemail to an existing revup number (RCF / trunk / UCaaS) as its no-answer fallback."
          onClick={() => dispatch({ type: 'setDelivery', delivery: 'attached' })}
        />
      </div>
    </div>
  );
}

function DeliveryCard({
  active,
  icon,
  title,
  body,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'left',
        padding: 18,
        borderRadius: 14,
        cursor: 'pointer',
        background: active ? `linear-gradient(135deg, ${ACCENT}1c 0%, ${ACCENT}0a 100%)` : 'rgba(255,255,255,0.02)',
        border: `1px solid ${active ? ACCENT + '66' : 'rgba(255,255,255,0.08)'}`,
        boxShadow: active ? `0 0 18px ${ACCENT}22` : 'none',
        transition: 'all 0.15s',
        fontFamily: 'inherit',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <span
        style={{
          width: 42,
          height: 42,
          borderRadius: 11,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: active ? ACCENT : '#64748b',
          background: active ? `${ACCENT}22` : 'rgba(255,255,255,0.04)',
          border: `1px solid ${active ? ACCENT + '44' : 'rgba(255,255,255,0.07)'}`,
        }}
      >
        {icon}
      </span>
      <span style={{ fontSize: '0.92rem', fontWeight: 700, color: active ? '#f1f5f9' : '#cbd5e0' }}>{title}</span>
      <span style={{ fontSize: '0.78rem', color: '#718096', lineHeight: 1.55 }}>{body}</span>
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Step 2 — pick the number / line
 * ──────────────────────────────────────────────────────────────────────── */

interface StepNumberProps {
  state: WizardState;
  dispatch: React.Dispatch<Action>;
  search: string;
  setSearch: (s: string) => void;
  availableLoading: boolean;
  availableDids: { id: number; did: string; city?: string; state?: string }[];
  myDidsLoading: boolean;
  myDids: { id: number; did: string; product_type?: string }[];
}

function StepNumber({
  state,
  dispatch,
  search,
  setSearch,
  availableLoading,
  availableDids,
  myDidsLoading,
  myDids,
}: StepNumberProps) {
  if (state.delivery === 'dedicated_did') {
    return (
      <div>
        {/* Buy-mode toggle */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <ModeTab active={state.buyMode === 'search'} onClick={() => dispatch({ type: 'setBuyMode', mode: 'search' })} icon={<Search size={13} />} label="Find a number" />
          <ModeTab active={state.buyMode === 'port'} onClick={() => dispatch({ type: 'setBuyMode', mode: 'port' })} icon={<ArrowRightLeft size={13} />} label="Port my number" />
        </div>

        {state.buyMode === 'search' ? (
          <>
            <div style={{ position: 'relative', marginBottom: 12 }}>
              <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#475569' }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by area code or digits, e.g. 617"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '9px 12px 9px 34px',
                  borderRadius: 9,
                  border: '1px solid rgba(255,255,255,0.1)',
                  background: 'rgba(15,17,23,0.8)',
                  color: '#e2e8f0',
                  fontSize: '0.83rem',
                  outline: 'none',
                }}
              />
            </div>
            <div style={{ maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {availableLoading ? (
                <Centered><Loader2 size={20} className="animate-spin" style={{ color: ACCENT }} /></Centered>
              ) : availableDids.length === 0 ? (
                <Centered>
                  <span style={{ color: '#64748b', fontSize: '0.82rem' }}>No available numbers match. Try a different area code, or port a number you own.</span>
                </Centered>
              ) : (
                availableDids.map((d) => (
                  <NumberRow
                    key={d.id}
                    primary={fmt(d.did)}
                    secondary={[d.city, d.state].filter(Boolean).join(', ') || d.did}
                    selected={state.selectedDid === d.did}
                    onClick={() => dispatch({ type: 'selectDid', did: d.did })}
                  />
                ))
              )}
            </div>
          </>
        ) : (
          <div>
            <label style={labelStyle}>Number to port in</label>
            <input
              value={state.portNumber}
              onChange={(e) => dispatch({ type: 'patch', patch: { portNumber: e.target.value } })}
              placeholder="+1XXXXXXXXXX"
              style={inputStyle}
            />
            <p style={{ color: '#718096', fontSize: '0.76rem', lineHeight: 1.6, marginTop: 10 }}>
              Enter the number you'd like to bring to us. We'll create the mailbox now
              and our provisioning team will complete the port — the mailbox activates
              once the number lands on the platform.
            </p>
          </div>
        )}
      </div>
    );
  }

  // ── attached ──
  return (
    <div>
      <p style={{ color: '#94a3b8', fontSize: '0.83rem', lineHeight: 1.6, marginBottom: 14 }}>
        Pick one of your existing revup numbers. Voicemail becomes its no-answer /
        busy fallback — the rest of its routing is unchanged.
      </p>
      <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
        {myDidsLoading ? (
          <Centered><Loader2 size={20} className="animate-spin" style={{ color: ACCENT }} /></Centered>
        ) : myDids.length === 0 ? (
          <Centered><span style={{ color: '#64748b', fontSize: '0.82rem' }}>No numbers found on your account. Enter one manually below.</span></Centered>
        ) : (
          myDids.map((d) => {
            const product = normalizeProduct(d.product_type);
            return (
              <NumberRow
                key={d.id}
                primary={fmt(d.did)}
                secondary={(product ?? 'line').toUpperCase()}
                selected={state.attachRef === d.did}
                onClick={() => dispatch({ type: 'selectAttach', product: product ?? 'rcf', ref: d.did })}
              />
            );
          })
        )}
      </div>

      {/* Manual fallback — covers admin-on-behalf and any gaps */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 14 }}>
        <label style={labelStyle}>Or enter a line manually</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <select
            value={state.attachProduct ?? ''}
            onChange={(e) => dispatch({ type: 'selectAttach', product: e.target.value as AttachProduct, ref: state.attachRef ?? '' })}
            style={{ ...inputStyle, flex: '0 0 120px', cursor: 'pointer' }}
          >
            <option value="">Product…</option>
            {ATTACH_PRODUCTS.map((p) => (
              <option key={p} value={p}>{p.toUpperCase()}</option>
            ))}
          </select>
          <input
            value={state.attachRef ?? ''}
            onChange={(e) => dispatch({ type: 'selectAttach', product: state.attachProduct ?? 'rcf', ref: e.target.value })}
            placeholder="Number or extension"
            style={{ ...inputStyle, flex: 1 }}
          />
        </div>
      </div>
    </div>
  );
}

function normalizeProduct(p: string | undefined): AttachProduct | null {
  if (!p) return null;
  return (ATTACH_PRODUCTS as string[]).includes(p) ? (p as AttachProduct) : null;
}

function ModeTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 12px',
        borderRadius: 8,
        fontSize: '0.76rem',
        fontWeight: 700,
        fontFamily: 'inherit',
        cursor: 'pointer',
        border: `1px solid ${active ? ACCENT + '55' : 'rgba(255,255,255,0.08)'}`,
        background: active ? `${ACCENT}1c` : 'transparent',
        color: active ? ACCENT : '#64748b',
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function NumberRow({ primary, secondary, selected, onClick }: { primary: string; secondary: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 14px',
        borderRadius: 10,
        cursor: 'pointer',
        fontFamily: 'inherit',
        textAlign: 'left',
        background: selected ? `${ACCENT}1c` : 'rgba(255,255,255,0.02)',
        border: `1px solid ${selected ? ACCENT + '66' : 'rgba(255,255,255,0.07)'}`,
        transition: 'all 0.12s',
      }}
    >
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: '0.86rem', fontWeight: 700, color: '#e2e8f0', fontFamily: 'monospace' }}>{primary}</span>
        <span style={{ fontSize: '0.7rem', color: '#64748b' }}>{secondary}</span>
      </span>
      {selected && (
        <span style={{ width: 22, height: 22, borderRadius: '50%', background: ACCENT, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>
          <Check size={13} strokeWidth={3} />
        </span>
      )}
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Step 3 — personalize
 * ──────────────────────────────────────────────────────────────────────── */

function StepPersonalize({
  state,
  dispatch,
  pinValid,
  emailValid,
}: {
  state: WizardState;
  dispatch: React.Dispatch<Action>;
  pinValid: boolean;
  emailValid: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <label style={labelStyle}>Mailbox name *</label>
        <input
          value={state.label}
          autoFocus
          onChange={(e) => dispatch({ type: 'patch', patch: { label: e.target.value } })}
          placeholder="e.g. Main Line, Support, Dr. Patel"
          style={inputStyle}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div>
          <label style={labelStyle}>Time zone</label>
          <select
            value={state.timezone}
            onChange={(e) => dispatch({ type: 'patch', patch: { timezone: e.target.value } })}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>{tz.replace('America/', '').replace('_', ' ')}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Access PIN (optional)</label>
          <input
            value={state.pin}
            inputMode="numeric"
            onChange={(e) => dispatch({ type: 'patch', patch: { pin: e.target.value.replace(/\D/g, '') } })}
            placeholder="4–10 digits"
            style={{ ...inputStyle, borderColor: pinValid ? 'rgba(255,255,255,0.1)' : 'rgba(239,68,68,0.5)' }}
          />
          {!pinValid && <span style={{ fontSize: '0.7rem', color: '#f87171' }}>PIN must be 4–10 digits.</span>}
        </div>
      </div>

      <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 14 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={state.notifyEmail}
            onChange={(e) => dispatch({ type: 'patch', patch: { notifyEmail: e.target.checked } })}
            style={{ width: 16, height: 16, accentColor: ACCENT }}
          />
          <span style={{ fontSize: '0.85rem', color: '#cbd5e0', fontWeight: 600 }}>Email me when a new message arrives</span>
        </label>
        {state.notifyEmail && (
          <input
            value={state.notifyEmailAddress}
            onChange={(e) => dispatch({ type: 'patch', patch: { notifyEmailAddress: e.target.value } })}
            placeholder="you@company.com"
            style={{ ...inputStyle, marginTop: 10, borderColor: emailValid ? 'rgba(255,255,255,0.1)' : 'rgba(239,68,68,0.5)' }}
          />
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Step 4 — review
 * ──────────────────────────────────────────────────────────────────────── */

function StepReview({ state }: { state: WizardState }) {
  const numberLine =
    state.delivery === 'dedicated_did'
      ? state.buyMode === 'search'
        ? `New number — ${fmt(state.selectedDid ?? '')}`
        : `Port in — ${fmt(state.portNumber)}`
      : `Attached to ${(state.attachProduct ?? '').toUpperCase()} ${fmt(state.attachRef ?? '')}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '0.95rem', fontWeight: 700, color: '#e2e8f0' }}>Review</span>
        <EncryptionBadge />
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          borderRadius: 12,
          overflow: 'hidden',
          border: '1px solid rgba(255,255,255,0.07)',
        }}
      >
        <ReviewRow label="Mailbox" value={state.label || '—'} />
        <ReviewRow label="Delivery" value={state.delivery === 'dedicated_did' ? 'Dedicated number' : 'Attached to existing line'} />
        <ReviewRow label="Number" value={numberLine} />
        <ReviewRow label="Time zone" value={state.timezone.replace('America/', '').replace('_', ' ')} />
        <ReviewRow label="Access PIN" value={state.pin ? '•'.repeat(state.pin.length) : 'Not set'} />
        <ReviewRow label="Email alerts" value={state.notifyEmail ? state.notifyEmailAddress || 'On' : 'Off'} />
      </div>

      <p style={{ fontSize: '0.78rem', color: '#718096', lineHeight: 1.6 }}>
        Every message in this box is encrypted at rest the moment it arrives. You can
        change the name, PIN, greetings and notifications any time from the mailbox.
      </p>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '11px 14px', background: 'rgba(255,255,255,0.02)' }}>
      <span style={{ fontSize: '0.76rem', color: '#64748b', fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: '0.82rem', color: '#e2e8f0', fontWeight: 600, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

/* ─── shared bits ─────────────────────────────────────────── */

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 16px', textAlign: 'center' }}>
      {children}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.68rem',
  fontWeight: 700,
  color: '#64748b',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  marginBottom: 7,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '9px 12px',
  borderRadius: 9,
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(15,17,23,0.8)',
  color: '#e2e8f0',
  fontSize: '0.84rem',
  outline: 'none',
  fontFamily: 'inherit',
};
