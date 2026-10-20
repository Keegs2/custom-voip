/**
 * NewMailboxDialog — staff (admin) only. Creates a dedicated-DID mailbox
 * (contract §4.1 POST /mailboxes, design change 5: tenants never create).
 *
 *   Customer   fixed (preview customer / console scope) or picked here
 *   Number     GET /available-numbers?q= (digits) → pick one
 *   Name · Timezone · optional PIN (masked, 4–10 digits, confirmed)
 *
 * The API claims the DID, switches voicemail on for the customer and makes
 * sure the customer's KMS key exists — a 503 means nothing was created; a
 * 409 means someone took the number first (the list refreshes).
 */
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import type { Mailbox } from '../../types/voicemail';
import { createMailbox } from '../../api/voicemail';
import { ApiError } from '../../api/client';
import { useToast } from '../../components/ui/ToastContext';
import { Spinner } from '../../components/ui/Spinner';
import { useAdminCustomers } from '../dashboard/adminData';
import { VmDialog } from './VmDialog';
import { invalidateVoicemail, isUnavailable, useAvailableNumbers, vmErrorText, vmKeys } from './voicemailData';
import { DEFAULT_TIMEZONE, formatPhone, PIN_PATTERN, TIMEZONES } from './format';

export interface NewMailboxDialogProps {
  /** The customer the mailbox is for, or null to pick one in the dialog. */
  customer: { id: number; name: string } | null;
  onClose: () => void;
  onCreated: (mailbox: Mailbox) => void;
}

export function NewMailboxDialog({ customer, onClose, onCreated }: NewMailboxDialogProps) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const queryClient = useQueryClient();
  const { toastOk } = useToast();
  const customers = useAdminCustomers(customer === null);
  const [customerId, setCustomerId] = useState<number | null>(customer?.id ?? null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [did, setDid] = useState<string | null>(null);
  const [label, setLabel] = useState('Voicemail');
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE);
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const ids = { customer: useId(), search: useId(), label: useId(), tz: useId(), pin: useId(), pin2: useId() };

  // Debounce the number search (digits only).
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(search.replace(/\D/g, '')), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  const numbers = useAvailableNumbers(query, true);

  const create = useMutation({
    mutationFn: () => {
      if (customerId === null || did === null) throw new Error('Pick a customer and a number.');
      return createMailbox({
        customer_id: customerId,
        did,
        label: label.trim() || 'Voicemail',
        timezone,
        ...(pin ? { pin } : {}),
      });
    },
    onSuccess: (mailbox) => {
      invalidateVoicemail(queryClient);
      toastOk(`Mailbox ready on ${formatPhone(mailbox.did)}.`);
      onCreated(mailbox);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        setDid(null);
        void queryClient.invalidateQueries({ queryKey: vmKeys.available(query) });
      }
    },
  });

  // ── Derived (after all hooks) ──
  const pinOk = pin === '' || PIN_PATTERN.test(pin);
  const pinMatch = pin === pinConfirm;
  const canSubmit = customerId !== null && did !== null && label.trim().length > 0 && pinOk && pinMatch && !create.isPending;
  const list = numbers.data ?? [];
  const customerName = customer?.name ?? customers.data?.find((c) => c.id === customerId)?.name ?? null;

  const errorText = create.isError
    ? create.error instanceof ApiError && create.error.status === 409
      ? 'That number was just taken. Pick another one.'
      : isUnavailable(create.error)
        ? 'Voicemail encryption is temporarily unavailable, so nothing was created. Try again in a few minutes.'
        : vmErrorText(create.error, 'The mailbox couldn’t be created.')
    : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (canSubmit) create.mutate();
  };

  return (
    <VmDialog
      title="New voicemail mailbox"
      sub={customerName ? <>For <strong>{customerName}</strong>. The number rings straight to voicemail.</> : 'Pick the customer and a number from the pool.'}
      onClose={onClose}
      busy={create.isPending}
      width={600}
      footer={
        <>
          <button type="button" className="dl-btn dl-btn-ghost" onClick={onClose} disabled={create.isPending}>
            Cancel
          </button>
          <button type="submit" form="vm-new-mailbox" className="dl-btn dl-btn-primary" disabled={!canSubmit}>
            {create.isPending && <span className="vm-spin vm-spin-light" aria-hidden="true" />}
            {create.isPending ? 'Creating…' : 'Create mailbox'}
          </button>
        </>
      }
    >
      <form id="vm-new-mailbox" className="vm-form" onSubmit={submit} autoComplete="off">
        {customer === null && (
          <div className="vm-field">
            <label className="dl-flabel" htmlFor={ids.customer}>
              Customer
            </label>
            <select
              id={ids.customer}
              className="dl-input vm-input-full"
              value={customerId ?? ''}
              onChange={(e) => setCustomerId(e.target.value ? Number(e.target.value) : null)}
              data-autofocus
            >
              <option value="" disabled>
                {customers.isLoading ? 'Loading customers…' : customers.isError ? 'Customers couldn’t load' : 'Pick a customer…'}
              </option>
              {(customers.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.status !== 'active' ? ` (${c.status})` : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="vm-field">
          <label className="dl-flabel" htmlFor={ids.search}>
            Number
          </label>
          <div className="vm-search">
            <Search size={14} aria-hidden="true" />
            <input
              id={ids.search}
              className="dl-input vm-input-full"
              inputMode="numeric"
              placeholder="Area code or digits, e.g. 617"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-autofocus={customer !== null ? true : undefined}
            />
          </div>
          <div className="vm-numbers" role="radiogroup" aria-label="Available numbers">
            {numbers.isLoading ? (
              <div className="vm-state-line" role="status">
                <Spinner size="sm" /> Finding numbers…
              </div>
            ) : numbers.isError ? (
              <div className="vm-state-line vm-state-err" role="alert">
                {vmErrorText(numbers.error, 'Available numbers couldn’t load.')}
              </div>
            ) : list.length === 0 ? (
              <div className="vm-state-line">No available numbers{query ? ` matching ${query}` : ''}.</div>
            ) : (
              list.map((n) => (
                <label key={n.did} className={`vm-number${did === n.did ? ' vm-number-on' : ''}`}>
                  <input type="radio" name="vm-new-did" checked={did === n.did} onChange={() => setDid(n.did)} />
                  <span className="vm-mono">{formatPhone(n.did)}</span>
                  <span className="vm-number-where">{[n.city, n.state].filter(Boolean).join(', ') || '—'}</span>
                </label>
              ))
            )}
          </div>
          <p className="dl-help">Unassigned numbers in the pool (up to 50 shown). The number is claimed when you create the mailbox.</p>
        </div>

        <div className="vm-field-row">
          <div className="vm-field">
            <label className="dl-flabel" htmlFor={ids.label}>
              Name
            </label>
            <input id={ids.label} className="dl-input vm-input-full" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="vm-field">
            <label className="dl-flabel" htmlFor={ids.tz}>
              Timezone
            </label>
            <select id={ids.tz} className="dl-input vm-input-full" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {TIMEZONES.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="vm-field-row">
          <div className="vm-field">
            <label className="dl-flabel" htmlFor={ids.pin}>
              PIN (optional)
            </label>
            <input
              id={ids.pin}
              className="dl-input dl-input-mono vm-input-full"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={10}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              aria-invalid={!pinOk}
            />
          </div>
          <div className="vm-field">
            <label className="dl-flabel" htmlFor={ids.pin2}>
              Confirm PIN
            </label>
            <input
              id={ids.pin2}
              className="dl-input dl-input-mono vm-input-full"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={10}
              value={pinConfirm}
              disabled={pin === ''}
              onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, ''))}
              aria-invalid={pin !== '' && pinConfirm !== '' && !pinMatch}
            />
          </div>
        </div>
        <p className={`dl-help${!pinOk || (pinConfirm !== '' && !pinMatch) ? ' vm-help-err' : ''}`}>
          {!pinOk
            ? 'A PIN is 4 to 10 digits.'
            : pinConfirm !== '' && !pinMatch
              ? 'The two PINs don’t match.'
              : 'For phone access later — the customer can set or change it themselves.'}
        </p>

        {errorText && (
          <div className="dl-banner dl-banner-err" role="alert">
            {errorText}
          </div>
        )}
      </form>
    </VmDialog>
  );
}
