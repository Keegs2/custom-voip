/**
 * TransferPicker — "Where should this call go?" (plan D3/D4, contract §6).
 *
 *   Your numbers   the account's own numbers from GET /ivr/destinations,
 *                  grouped Call forwarding (RCF) / Voicemail boxes / Other
 *                  IVRs / SIP trunk numbers, each with its name and what it
 *                  does ("Forwards to …"). A click, not typing a number.
 *                  This IVR's own numbers are shown but can't be picked
 *                  (that would loop the caller back here).
 *   Outside number any US number, checked as you type with the same rule
 *                  the server enforces (US only, incl. toll-free).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { DestinationProduct, Destinations, DialTarget } from '../../types/ivr';
import { groupLabel, orderedGroups } from './destinations';
import { VmDialog } from '../../pages/voicemail/VmDialog';
import { fmt } from '../../utils/format';
import { checkExternalNumber } from '../compile/policy';
import { ProductGlyph } from './ProductGlyph';

const CHIP_LABEL: Partial<Record<DestinationProduct, string>> = {
  rcf: 'Call forwarding',
  voicemail: 'Voicemail',
  ivr: 'IVRs',
  trunk: 'SIP trunk',
};

export interface TransferPickerProps {
  value: DialTarget;
  destinations: Destinations | undefined;
  loading: boolean;
  failed: boolean;
  /** This flow's own numbers — never a valid target. */
  ownDids: readonly string[];
  onChoose: (target: DialTarget) => void;
  onClose: () => void;
}

export function TransferPicker({ value, destinations, loading, failed, ownDids, onChoose, onClose }: TransferPickerProps) {
  // ── Hooks first (React #310) ──
  const [tab, setTab] = useState<'own' | 'external'>(value.kind);
  const [query, setQuery] = useState('');
  const [did, setDid] = useState(value.kind === 'own' ? value.did : '');
  const [number, setNumber] = useState(value.kind === 'external' ? value.number : '');
  const [touched, setTouched] = useState(value.kind === 'external' && value.number !== '');
  const [only, setOnly] = useState<DestinationProduct | 'all'>('all');
  const listRef = useRef<HTMLDivElement>(null);
  const ids = { tabs: useId(), search: useId(), ext: useId(), extMsg: useId(), list: useId() };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    return orderedGroups(destinations)
      .filter((g) => only === 'all' || g.product === only)
      .map((g) => ({
        g,
        numbers: g.numbers.filter((n) => {
          if (!q) return true;
          const hay = `${n.name ?? ''} ${n.detail ?? ''} ${groupLabel(g)}`.toLowerCase();
          return hay.includes(q) || (digits.length >= 3 && n.did.replace(/\D/g, '').includes(digits));
        }),
      }))
      .filter((x) => x.numbers.length > 0);
  }, [destinations, query, only]);

  // Open with the current destination in view.
  useEffect(() => {
    const on = listRef.current?.querySelector<HTMLElement>('.ivr-dest-on');
    on?.scrollIntoView({ block: 'center' });
  }, [tab, destinations]);

  // ── Derived (after all hooks) ──
  const check = checkExternalNumber(number);
  const showProblem = touched && check.problem !== null;
  const total = (destinations?.groups ?? []).reduce((n, g) => n + g.numbers.length, 0);
  const allGroups = orderedGroups(destinations);
  const canUse = tab === 'own' ? did !== '' && !ownDids.includes(did) : check.problem === null && check.e164 !== null;

  const use = () => {
    if (!canUse) return;
    onChoose(tab === 'own' ? { kind: 'own', did } : { kind: 'external', number: check.e164 ?? number });
    onClose();
  };

  return (
    <VmDialog
      title="Where should this call go?"
      sub="Ring one of your own numbers, or an outside US number."
      onClose={onClose}
      width={620}
      footer={
        <>
          <button type="button" className="dl-btn dl-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="dl-btn dl-btn-primary" disabled={!canUse} onClick={use}>
            Use this destination
          </button>
        </>
      }
    >
      <div className="vm-seg ivr-seg2" role="tablist" aria-label="Destination type" id={ids.tabs}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'own'}
          className={`vm-seg-opt${tab === 'own' ? ' vm-seg-on' : ''}`}
          onClick={() => setTab('own')}
        >
          Your numbers
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'external'}
          className={`vm-seg-opt${tab === 'external' ? ' vm-seg-on' : ''}`}
          onClick={() => setTab('external')}
        >
          An outside US number
        </button>
      </div>

      {tab === 'own' && (
        <div className="ivr-pick-own">
          {total > 6 && (
            <div className="ivr-search">
              <Search size={15} aria-hidden="true" />
              <label className="ivr-sr" htmlFor={ids.search}>
                Search your numbers
              </label>
              <input
                id={ids.search}
                className="dl-input ivr-search-input"
                placeholder="Search by name or number"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                data-autofocus
              />
            </div>
          )}
          {allGroups.length > 1 && (
            <div className="ivr-filter" role="group" aria-label="Show">
              <button type="button" className={`ivr-filter-chip${only === 'all' ? ' ivr-filter-on' : ''}`} aria-pressed={only === 'all'} onClick={() => setOnly('all')}>
                All <span>{total}</span>
              </button>
              {allGroups.map((g) => (
                <button
                  key={g.product}
                  type="button"
                  className={`ivr-filter-chip${only === g.product ? ' ivr-filter-on' : ''}`}
                  aria-pressed={only === g.product}
                  onClick={() => setOnly(g.product)}
                >
                  {CHIP_LABEL[g.product] ?? groupLabel(g)} <span>{g.numbers.length}</span>
                </button>
              ))}
            </div>
          )}
          {loading ? (
            <p className="ivr-state" role="status">
              <span className="vm-spin" aria-hidden="true" /> Loading your numbers…
            </p>
          ) : failed ? (
            <div className="dl-banner dl-banner-err">Your numbers couldn’t be loaded. Close this and try again.</div>
          ) : total === 0 ? (
            <div className="dl-banner dl-banner-warn">This account has no other numbers yet. Use an outside number instead.</div>
          ) : groups.length === 0 ? (
            <p className="ivr-field-empty">No number matches “{query}”.</p>
          ) : (
            <div role="radiogroup" aria-label="Your numbers" className="ivr-dest-groups" id={ids.list} ref={listRef}>
              {groups.map(({ g, numbers }) => (
                <fieldset key={g.product} className="ivr-dest-group">
                  <legend className="ivr-dest-legend">
                    <span className={`ivr-dest-glyph ivr-dest-glyph--${g.product}`}>
                      <ProductGlyph product={g.product} size={13} />
                    </span>
                    {groupLabel(g)}
                    <span className="ivr-dest-count">{numbers.length}</span>
                  </legend>
                  {numbers.map((n) => {
                    const self = ownDids.includes(n.did);
                    const on = did === n.did;
                    return (
                      <label
                        key={n.did}
                        className={`ivr-dest${on ? ' ivr-dest-on' : ''}${self ? ' ivr-dest-self' : ''}`}
                      >
                        <input
                          type="radio"
                          name={ids.list}
                          value={n.did}
                          checked={on}
                          disabled={self}
                          onChange={() => setDid(n.did)}
                        />
                        <span className="ivr-dest-main">
                          <span className="ivr-dest-name">
                            {n.name ?? fmt(n.did)}
                            {self && <span className="ivr-tag">This IVR</span>}
                            {!n.enabled && !self && <span className="ivr-tag ivr-tag-warn">Switched off</span>}
                          </span>
                          {n.detail && <span className="ivr-dest-detail">{n.detail}</span>}
                        </span>
                        <span className="ivr-dest-num">{fmt(n.did)}</span>
                      </label>
                    );
                  })}
                </fieldset>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'external' && (
        <div className="ivr-pick-ext">
          <label className="ivr-label" htmlFor={ids.ext}>
            US phone number
          </label>
          <input
            id={ids.ext}
            className={`dl-input vm-input-full ivr-ext-input${showProblem ? ' ivr-input-bad' : ''}`}
            inputMode="tel"
            autoComplete="off"
            placeholder="(617) 555-0234"
            value={number}
            aria-invalid={showProblem || undefined}
            aria-describedby={ids.extMsg}
            onChange={(e) => {
              setNumber(e.target.value);
              if (e.target.value.replace(/\D/g, '').length >= 10) setTouched(true);
            }}
            onBlur={() => setTouched(number.trim() !== '')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') use();
            }}
            data-autofocus
          />
          <p id={ids.extMsg} className={`ivr-ext-msg${showProblem ? ' ivr-ext-msg-bad' : check.e164 && !check.problem ? ' ivr-ext-msg-ok' : ''}`} role="status">
            {showProblem
              ? check.message
              : check.e164 && !check.problem
                ? `Will dial ${fmt(check.e164)}.`
                : 'Any US number, including toll-free (800, 833 … 888). Canada and other countries can’t be dialed.'}
          </p>
        </div>
      )}
    </VmDialog>
  );
}
