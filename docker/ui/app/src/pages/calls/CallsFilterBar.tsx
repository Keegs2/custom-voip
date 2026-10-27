/**
 * CallsFilterBar — the Calls & Quality search row.
 *
 * ONE compact, centered toolbar row (wraps cleanly below ~1440px for staff):
 *
 *   Customer* · Trunk · Product · Direction · Dest. prefix · Time range
 *   [· From · To — only while "Custom range" is chosen] · More* | Search · Export*
 *
 *   (* staff only)
 *
 * Every control is a uniform 36px; labels sit above in the shared `dl-flabel`
 * treatment so baselines line up and the row reads as one strip. Every
 * dropdown is the themed `Select` wearing `dl-input` (the Customer one is the
 * shared AdminCustomerPicker — "All customers" pinned on top, searchable;
 * the rest are short fixed lists, not searchable). The staff
 * power filters that rarely change — Zone, the Rows row model (Calls / All
 * legs / Carrier legs — the CDR A/B leg split, docs/CDR_LEG_SPLIT_CONTRACT.md)
 * and Rated only — live behind "More" (a small anchored popover) with a
 * count badge whenever any of them is non-default, so a narrowed search is
 * never invisible. Validation errors and the staff "Call: <id>" single-call
 * chip render on a slim line under the row ONLY when present.
 *
 * Role gating (presentation only — the API tenant-scopes server-side):
 * - Staff (admin + support): Customer, More (Zone / Rows / Rated only), the
 *   "Call: <id>" chip (its × clears the filter AND re-runs the search via
 *   onClearCallId), and Export CSV.
 * - Tenants: none of those; the Trunk selector stays (listTrunks is
 *   tenant-scoped, so tenants only ever see their own trunks).
 * - Product "Voicemail": always for staff; for everyone else only while
 *   Visual Voicemail is on for their account (the same summary query and
 *   cache key as the sidebar — an admin in "View as Customer" reads the
 *   previewed customer's).
 *
 * Time-range semantics (state + serialization live in ./callsFilters —
 * unchanged):
 * - Presets are RELATIVE — they resolve to concrete instants when Search is
 *   clicked, so "Last 24h" always means 24h before the search.
 * - "Custom range" reveals From / To pickers inline, seeded from the window
 *   the active preset currently covers. The user enters LOCAL wall-clock
 *   time; filtersToParams() converts to ISO 8601 UTC for the wire.
 *
 * Enter in any text/date field submits the form (= Search).
 *
 * React #310: every hook is called unconditionally at the top.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Search, SlidersHorizontal, X } from 'lucide-react';
import { listCustomers } from '../../api/customers';
import { listTrunks } from '../../api/trunks';
import { AdminCustomerPicker } from '../../components/AdminCustomerPicker';
import { Select, type SelectOption } from '../../components/ui/Select';
import { API_CALLING_ENABLED } from '../../config/features';
import { useAuth } from '../../contexts/AuthContext';
import { staffScope, tenantScope, useVoicemailSummary } from '../voicemail/voicemailData';
import {
  PRESET_LABELS,
  ROWS_MODE_OPTIONS,
  presetRange,
  toDatetimeLocal,
  validateCallsFilters,
} from './callsFilters';
import type { CallsFilters, CdrRangePreset } from './callsFilters';

/** Select order for the time-range control. */
const RANGE_OPTIONS: ReadonlyArray<SelectOption<CdrRangePreset>> = [
  ...(Object.keys(PRESET_LABELS) as Array<Exclude<CdrRangePreset, 'custom'>>).map((p) => ({
    value: p as CdrRangePreset,
    label: PRESET_LABELS[p],
  })),
  { value: 'custom', label: 'Custom range' },
];

/** '' = no filter: a real option, so the trigger shows "All", never a placeholder. */
const DIRECTION_OPTIONS: ReadonlyArray<SelectOption<string>> = [
  { value: '', label: 'All' },
  { value: 'inbound', label: 'Inbound' },
  { value: 'outbound', label: 'Outbound' },
];

/** Static zones — each is a self-contained SIP stack. Per-SBC granularity stays in the call-detail modal. */
const ZONE_OPTIONS: ReadonlyArray<SelectOption<string>> = [
  { value: '', label: 'All zones' },
  { value: 'east', label: 'East' },
  { value: 'west', label: 'West' },
  { value: 'central', label: 'Central' },
];

interface CallsFilterBarProps {
  filters: CallsFilters;
  onChange: (filters: CallsFilters) => void;
  onSearch: () => void;
  onExport: () => void;
  searching: boolean;
  exporting: boolean;
  /** Admin or support — shows Customer, More (Zone / Rows / Rated) and Export CSV. */
  isStaff: boolean;
  /** Clears the single-call filter AND re-runs the search (staff chip ×). */
  onClearCallId?: () => void;
}

export function CallsFilterBar({
  filters,
  onChange,
  onSearch,
  onExport,
  searching,
  exporting,
  isStaff,
  onClearCallId,
}: CallsFilterBarProps) {
  // ALL hooks unconditionally at the top — React #310 prevention.
  const { effectiveCustomer, isActualAdmin } = useAuth();
  // Scope rule mirrors the Sidebar so both share one cache entry: a tenant's
  // own account (no customer_id), or the customer an admin previews.
  const voicemailScope = effectiveCustomer
    ? isActualAdmin
      ? staffScope(effectiveCustomer.id)
      : tenantScope(effectiveCustomer.id)
    : staffScope('all');
  const voicemailSummary = useVoicemailSummary(voicemailScope, !isStaff && effectiveCustomer !== null);
  const customers = useQuery({
    queryKey: ['customers-all'],
    queryFn: () => listCustomers({ limit: 500 }),
    staleTime: 5 * 60 * 1000,
    enabled: isStaff, // tenants have no customer filter (and no /customers read)
  });

  // Trunk options follow the selected customer for staff; tenants always get
  // their own trunks (listTrunks is tenant-scoped server-side).
  const { data: trunksData } = useQuery({
    queryKey: ['trunks-for-cdr-filter', filters.customer_id],
    queryFn: () =>
      listTrunks({
        customer_id: filters.customer_id ? Number(filters.customer_id) : undefined,
        limit: 500,
      }),
    staleTime: 2 * 60 * 1000,
  });

  const trunkOptions = useMemo<SelectOption<string>[]>(
    () => [
      { value: '', label: 'All trunks' },
      ...(trunksData?.items ?? []).map((t) => ({ value: String(t.id), label: t.trunk_name })),
    ],
    [trunksData],
  );

  // Keep "Voicemail" while it is the selected filter, so the control never shows a value it can't name.
  const showVoicemail =
    isStaff || voicemailSummary.data?.enabled === true || filters.product_type === 'voicemail';
  const productOptions = useMemo<SelectOption<string>[]>(
    () => [
      { value: '', label: 'All' },
      { value: 'rcf', label: 'RCF' },
      // API Calling is retired — its product filter only shows while enabled.
      ...(API_CALLING_ENABLED ? [{ value: 'api', label: 'API' }] : []),
      { value: 'trunk', label: 'Trunk' },
      ...(showVoicemail ? [{ value: 'voicemail', label: 'Voicemail' }] : []),
    ],
    [showVoicemail],
  );

  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  const morePanelId = useId();

  const closeMore = useCallback((restoreFocus: boolean) => {
    setMoreOpen(false);
    if (restoreFocus) moreBtnRef.current?.focus();
  }, []);

  // Dismiss the More popover on outside pointer-down or Escape. Listeners
  // exist only while it is open.
  useEffect(() => {
    if (!moreOpen) return undefined;
    function onPointerDown(e: PointerEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) closeMore(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeMore(true);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [moreOpen, closeMore]);

  /* ── Derived ─────────────────────────────────────────────────────── */

  const rangeError = validateCallsFilters(filters);
  const rangePreset = filters.range_preset;
  const isCustom = rangePreset === 'custom';
  // While a preset is active, the window it currently covers (recomputed per
  // render) seeds the pickers when the operator switches to Custom.
  const preview = rangePreset === 'custom' ? null : presetRange(rangePreset, new Date());
  const startValue = preview ? toDatetimeLocal(preview.start) : filters.start_local;
  const endValue = preview ? toDatetimeLocal(preview.end) : filters.end_local;

  /** Non-default "More" filters — drives the badge so nothing hides silently. */
  const moreCount =
    (filters.zone ? 1 : 0) + (filters.rows !== 'calls' ? 1 : 0) + (filters.rated_only ? 1 : 0);
  const activeRows = ROWS_MODE_OPTIONS.find((o) => o.id === filters.rows) ?? ROWS_MODE_OPTIONS[0];
  const showCallChip = isStaff && filters.call_id !== '';
  // '' (no customer filter) = All customers; the URL / filter semantics are unchanged.
  const customerValue: number | 'all' = /^\d+$/.test(filters.customer_id) ? Number(filters.customer_id) : 'all';

  /* ── Mutators ────────────────────────────────────────────────────── */

  function set<K extends keyof CallsFilters>(key: K, value: CallsFilters[K]) {
    onChange({ ...filters, [key]: value });
  }

  /** Changing customer invalidates the trunk choice (trunks are per-customer). */
  function setCustomer(value: string) {
    onChange({ ...filters, customer_id: value, trunk_id: '' });
  }

  function selectPreset(preset: CdrRangePreset) {
    if (preset === 'custom') {
      // Seed the editable pickers from whatever window is currently covered.
      onChange({ ...filters, range_preset: 'custom', start_local: startValue, end_local: endValue });
    } else {
      onChange({ ...filters, range_preset: preset });
    }
  }

  function resetMore() {
    onChange({ ...filters, zone: '', rows: 'calls', rated_only: false });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (rangeError) return;
    setMoreOpen(false);
    onSearch();
  }

  return (
    <section className="cqf-card" aria-label="Search calls">
      <form onSubmit={handleSubmit} className="cqf-form">
        <div className="cqf-row">
          {isStaff && (
            <div className="cqf-field cqf-w-customer">
              <label className="dl-flabel" htmlFor="cdr-f-customer">Customer</label>
              <AdminCustomerPicker
                id="cdr-f-customer"
                className="dl-input"
                value={customerValue}
                onChange={(next) => setCustomer(next === 'all' ? '' : String(next))}
                customers={customers.data?.items}
                loading={customers.isLoading}
                error={customers.isError}
              />
            </div>
          )}

          <div className="cqf-field cqf-w-trunk">
            <label className="dl-flabel" htmlFor="cdr-f-trunk">Trunk</label>
            <Select
              id="cdr-f-trunk"
              className="dl-input"
              value={filters.trunk_id}
              onChange={(v) => set('trunk_id', v)}
              options={trunkOptions}
              searchable={false}
            />
          </div>

          <div className="cqf-field cqf-w-product">
            <label className="dl-flabel" htmlFor="cdr-f-product">Product</label>
            <Select
              id="cdr-f-product"
              className="dl-input"
              value={filters.product_type}
              onChange={(v) => set('product_type', v)}
              options={productOptions}
              searchable={false}
            />
          </div>

          <div className="cqf-field cqf-w-direction">
            <label className="dl-flabel" htmlFor="cdr-f-direction">Direction</label>
            <Select
              id="cdr-f-direction"
              className="dl-input"
              value={filters.direction}
              onChange={(v) => set('direction', v)}
              options={DIRECTION_OPTIONS}
              searchable={false}
            />
          </div>

          <div className="cqf-field cqf-w-dest">
            <label className="dl-flabel" htmlFor="cdr-f-dest">Dest. prefix</label>
            <input
              id="cdr-f-dest"
              type="text"
              inputMode="numeric"
              className="dl-input"
              placeholder="e.g. 1800"
              title="Destination number prefix"
              value={filters.destination}
              onChange={(e) => set('destination', e.target.value)}
            />
          </div>

          <div className="cqf-field cqf-w-range">
            <label className="dl-flabel" htmlFor="cdr-f-range">Time range</label>
            <Select<CdrRangePreset>
              id="cdr-f-range"
              className="dl-input"
              value={filters.range_preset}
              onChange={selectPreset}
              options={RANGE_OPTIONS}
              searchable={false}
            />
          </div>

          {isCustom && (
            <>
              <div className="cqf-field cqf-w-date">
                <label className="dl-flabel" htmlFor="cdr-f-start">From <span className="cqf-flabel-note">local</span></label>
                <input
                  id="cdr-f-start"
                  type="datetime-local"
                  className="dl-input"
                  value={filters.start_local}
                  aria-invalid={rangeError != null}
                  onChange={(e) => set('start_local', e.target.value)}
                />
              </div>
              <div className="cqf-field cqf-w-date">
                <label className="dl-flabel" htmlFor="cdr-f-end">To <span className="cqf-flabel-note">local</span></label>
                <input
                  id="cdr-f-end"
                  type="datetime-local"
                  className="dl-input"
                  value={filters.end_local}
                  aria-invalid={rangeError != null}
                  onChange={(e) => set('end_local', e.target.value)}
                />
              </div>
            </>
          )}

          {/* Staff power filters — Zone / Rows / Rated only. Tenants never see
              them and never send `zone` / `leg` / `rated_only`. */}
          {isStaff && (
            <div className="cqf-field cqf-more" ref={moreRef}>
              <button
                ref={moreBtnRef}
                type="button"
                className={moreCount > 0 ? 'cqf-btn cqf-more-btn cqf-more-btn-on' : 'cqf-btn cqf-more-btn'}
                aria-haspopup="dialog"
                aria-expanded={moreOpen}
                aria-controls={moreOpen ? morePanelId : undefined}
                title="Zone, row model, rated only"
                onClick={() => setMoreOpen((o) => !o)}
              >
                <SlidersHorizontal size={14} strokeWidth={2} aria-hidden="true" />
                More
                {moreCount > 0 && (
                  <span className="cqf-count" aria-label={`${moreCount} active`}>{moreCount}</span>
                )}
              </button>

              {moreOpen && (
                <div id={morePanelId} className="cqf-pop" role="dialog" aria-label="More filters">
                  <div className="cqf-pop-body">
                    <div className="cqf-pop-field">
                      <label className="dl-flabel" htmlFor="cdr-f-zone">Zone</label>
                      {/* Its menu is portaled out of this popover; presses inside the
                          menu stop there, so the popover's outside-press close
                          doesn't fire (components/ui/Select). */}
                      <Select
                        id="cdr-f-zone"
                        className="dl-input"
                        value={filters.zone}
                        onChange={(v) => set('zone', v)}
                        options={ZONE_OPTIONS}
                        searchable={false}
                      />
                    </div>

                    <div className="cqf-pop-field">
                      <span className="dl-flabel" id={`${morePanelId}-rows`}>Rows</span>
                      <div className="dlx-seg cqf-seg" role="group" aria-labelledby={`${morePanelId}-rows`}>
                        {ROWS_MODE_OPTIONS.map((opt) => (
                          <button
                            key={opt.id}
                            type="button"
                            title={opt.title}
                            aria-pressed={filters.rows === opt.id}
                            className={filters.rows === opt.id ? 'dlx-seg-btn dlx-seg-btn-active' : 'dlx-seg-btn'}
                            onClick={() => set('rows', opt.id)}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                      <p className="cqf-pop-hint">{activeRows.title}.</p>
                    </div>

                    {/* Rating state is a billing internal — staff only (the API
                        also ignores rated_only for tenants). */}
                    <label className="cqf-check">
                      <input
                        type="checkbox"
                        checked={filters.rated_only}
                        onChange={(e) => set('rated_only', e.target.checked)}
                      />
                      <span>
                        <span className="cqf-check-label">Rated only</span>
                        <span className="cqf-pop-hint">Only records that have been costed.</span>
                      </span>
                    </label>
                  </div>

                  <div className="cqf-pop-foot">
                    <button
                      type="button"
                      className="cqf-link"
                      disabled={moreCount === 0}
                      onClick={resetMore}
                    >
                      Reset
                    </button>
                    <span className="cqf-pop-note">Applied on Search</span>
                    <button type="button" className="cqf-btn cqf-btn-sm" onClick={() => closeMore(true)}>
                      Done
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="cqf-actions">
            <button
              type="submit"
              className="dl-btn dl-btn-primary cqf-action"
              disabled={searching || rangeError != null}
              aria-busy={searching || undefined}
            >
              {/* Fixed label + icon↔spinner swap: the button never changes
                  width mid-search, so the row can't reflow/wrap. */}
              {searching
                ? <span className="cqf-spin" aria-hidden="true" />
                : <Search size={14} strokeWidth={2.25} aria-hidden="true" />}
              Search
            </button>
            {isStaff && (
              <button
                type="button"
                className="dl-btn dl-btn-ghost cqf-action"
                disabled={exporting || rangeError != null}
                onClick={onExport}
                title="Export the current search as CSV (up to 1,000 rows)"
                aria-busy={exporting || undefined}
              >
                {exporting
                  ? <span className="cqf-spin" aria-hidden="true" />
                  : <Download size={14} strokeWidth={2.25} aria-hidden="true" />}
                Export
              </button>
            )}
          </div>
        </div>

        {/* Slim meta line — ONLY when there is something to say: the staff
            single-call chip and/or the custom-range validation message. */}
        <div className={showCallChip || rangeError ? 'cqf-meta' : undefined}>
          {showCallChip && (
            <span className="dl-chip cqf-callchip" title={`Showing only rows of call ${filters.call_id}`}>
              <span className="cqf-callchip-key">Call</span>
              <span className="cqf-callchip-id">{filters.call_id}</span>
              <button
                type="button"
                onClick={() => (onClearCallId ? onClearCallId() : set('call_id', ''))}
                aria-label="Clear call filter"
                title="Clear call filter"
                className="cqf-callchip-x"
              >
                <X size={12} strokeWidth={2.5} aria-hidden="true" />
              </button>
            </span>
          )}
          <div role="alert" aria-live="polite">
            {rangeError && <span className="dlx4-ferr">{rangeError}</span>}
          </div>
        </div>
      </form>
    </section>
  );
}
