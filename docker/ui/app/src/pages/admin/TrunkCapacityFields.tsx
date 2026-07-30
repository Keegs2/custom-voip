/**
 * Shared "Capacity" + "Authorized IPs" building blocks for the two admin
 * create-trunk forms (TrunksAdminPage and CustomerTrunkSection).
 *
 * Both forms need the SAME behaviour, so the state, validation, and the exact
 * payload contract all live here once:
 *
 *   Capacity — the admin picks EITHER
 *     • a purchased Tier  → submit `cps_tier_id` (server derives CPS + call
 *       paths from the tier); do NOT send cps_limit / max_channels.
 *     • a Custom config   → submit `cps_limit` + `max_channels`; no cps_tier_id.
 *
 *   Authorized IPs — zero or more IPv4 addresses (optional /CIDR suffix),
 *     submitted as `auth_ips: string[]`. Optional at creation; more can be
 *     added later on the trunk detail view.
 *
 * The hooks own all state (so callers keep hooks-first, above early returns —
 * React #310), and the presentational sections are driven by those hooks.
 */
import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listTrunkTiers } from '../../api/tiers';
import { Button } from '../../components/ui/Button';
import { FormField } from '../../components/ui/FormField';
import { Spinner } from '../../components/ui/Spinner';
import { fmtMoney } from '../../utils/format';
import type { Tier } from '../../types/tier';

// ─── IPv4 (+ optional CIDR) validation ───────────────────────────────────────

const IPV4_CIDR_RE =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(\/(3[0-2]|[12]?\d))?$/;

/** true when `value` is a dotted-quad IPv4 with an optional /0–/32 suffix. */
export function isValidAuthIp(value: string): boolean {
  return IPV4_CIDR_RE.test(value.trim());
}

// ─── Capacity mode ────────────────────────────────────────────────────────────

export type CapacityMode = 'tier' | 'custom';

/**
 * The capacity fragment of a TrunkCreate payload. Exactly one of the two
 * shapes is produced depending on the selected mode:
 *   tier   → { cps_tier_id }
 *   custom → { cps_limit, max_channels }
 */
export type CapacityPayload =
  | { cps_tier_id: number }
  | { cps_limit: number; max_channels: number };

export interface TrunkCapacityController {
  mode: CapacityMode;
  setMode: (mode: CapacityMode) => void;
  tiers: Tier[];
  tiersLoading: boolean;
  tiersError: boolean;
  tierId: string;
  setTierId: (id: string) => void;
  customCps: string;
  setCustomCps: (v: string) => void;
  customPaths: string;
  setCustomPaths: (v: string) => void;
  /** Reset all capacity state back to defaults (post-submit). */
  reset: () => void;
  /**
   * Validate the current selection. Returns an error string to surface via
   * toast, or null when the selection is valid.
   */
  validate: () => string | null;
  /**
   * Build the capacity fragment of the create payload. Call only after
   * `validate()` returns null.
   */
  buildPayload: () => CapacityPayload;
}

/**
 * Owns all Capacity state + the shared `['trunk-tiers']` query. Call this at
 * the TOP of a form component (hooks-first) — never inside a modal/render
 * branch — so hook order stays stable across renders (React #310).
 */
export function useTrunkCapacity(): TrunkCapacityController {
  const [mode, setMode] = useState<CapacityMode>('tier');
  const [tierId, setTierId] = useState('');
  const [customCps, setCustomCps] = useState('');
  const [customPaths, setCustomPaths] = useState('');

  const {
    data: tiers,
    isLoading: tiersLoading,
    isError: tiersError,
  } = useQuery({
    queryKey: ['trunk-tiers'],
    queryFn: listTrunkTiers,
  });

  const reset = useCallback(() => {
    setMode('tier');
    setTierId('');
    setCustomCps('');
    setCustomPaths('');
  }, []);

  const validate = useCallback((): string | null => {
    if (mode === 'tier') {
      if (!tierId) return 'Please select a service tier';
      return null;
    }
    const cps = Number(customCps);
    const paths = Number(customPaths);
    if (!Number.isFinite(cps) || cps <= 0) return 'CPS must be greater than 0';
    if (!Number.isFinite(paths) || paths <= 0) return 'Call paths must be greater than 0';
    return null;
  }, [mode, tierId, customCps, customPaths]);

  const buildPayload = useCallback((): CapacityPayload => {
    if (mode === 'tier') {
      return { cps_tier_id: parseInt(tierId, 10) };
    }
    return {
      cps_limit: parseInt(customCps, 10),
      max_channels: parseInt(customPaths, 10),
    };
  }, [mode, tierId, customCps, customPaths]);

  return {
    mode,
    setMode,
    tiers: tiers ?? [],
    tiersLoading,
    tiersError,
    tierId,
    setTierId,
    customCps,
    setCustomCps,
    customPaths,
    setCustomPaths,
    reset,
    validate,
    buildPayload,
  };
}

// ─── Authorized IPs state ─────────────────────────────────────────────────────

export interface TrunkAuthIpsController {
  ips: string[];
  draft: string;
  setDraft: (v: string) => void;
  /** Validate + append the current draft; no-ops on invalid/duplicate input. */
  add: () => void;
  remove: (ip: string) => void;
  reset: () => void;
  /** Inline validation message for the draft input (empty draft = no error). */
  draftError: string | null;
}

/** Owns the Authorized-IPs list + draft input. Hooks-first, like above. */
export function useTrunkAuthIps(): TrunkAuthIpsController {
  const [ips, setIps] = useState<string[]>([]);
  const [draft, setDraft] = useState('');

  const draftError = useMemo<string | null>(() => {
    const v = draft.trim();
    if (!v) return null;
    if (!isValidAuthIp(v)) return 'Enter a valid IPv4 address or CIDR';
    if (ips.includes(v)) return 'That IP is already in the list';
    return null;
  }, [draft, ips]);

  const add = useCallback(() => {
    const v = draft.trim();
    if (!v || !isValidAuthIp(v) || ips.includes(v)) return;
    setIps((prev) => [...prev, v]);
    setDraft('');
  }, [draft, ips]);

  const remove = useCallback((ip: string) => {
    setIps((prev) => prev.filter((x) => x !== ip));
  }, []);

  const reset = useCallback(() => {
    setIps([]);
    setDraft('');
  }, []);

  return { ips, draft, setDraft, add, remove, reset, draftError };
}

// ─── Shared style tokens ──────────────────────────────────────────────────────

const ACCENT = '#3b82f6';

const sectionLabelStyle: React.CSSProperties = {
  fontSize: '0.65rem',
  fontWeight: 700,
  color: ACCENT,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: 12,
};

const hintStyle: React.CSSProperties = {
  fontSize: '0.72rem',
  color: '#64748b',
};

const monoFont =
  '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

// ─── Capacity mode toggle (segmented) ─────────────────────────────────────────

function ModeToggle({
  mode,
  onChange,
}: {
  mode: CapacityMode;
  onChange: (mode: CapacityMode) => void;
}) {
  const options: { value: CapacityMode; label: string }[] = [
    { value: 'tier', label: 'Purchased tier' },
    { value: 'custom', label: 'Custom' },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Capacity source"
      style={{
        display: 'inline-flex',
        gap: 4,
        padding: 4,
        borderRadius: 10,
        background: 'rgba(13,15,21,0.55)',
        border: '1px solid rgba(59,130,246,0.15)',
        marginBottom: 14,
      }}
    >
      {options.map((opt) => {
        const active = mode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            style={{
              appearance: 'none',
              border: '1px solid ' + (active ? 'rgba(59,130,246,0.55)' : 'transparent'),
              borderRadius: 7,
              padding: '6px 14px',
              fontSize: '0.75rem',
              fontWeight: 600,
              letterSpacing: '0.01em',
              cursor: 'pointer',
              transition: 'all 0.15s',
              background: active
                ? 'linear-gradient(135deg, rgba(59,130,246,0.22) 0%, rgba(59,130,246,0.12) 100%)'
                : 'transparent',
              color: active ? '#bfdbfe' : '#718096',
              boxShadow: active ? '0 0 12px rgba(59,130,246,0.18)' : 'none',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** Human label for one tier option: "Standard — 1 CPS / 20 call paths — $25/mo". */
export function formatTierOption(tier: Tier): string {
  const paths = tier.call_paths != null ? `${tier.call_paths} call paths` : 'no bundled paths';
  return `${tier.name} — ${tier.cps_limit} CPS / ${paths} — ${fmtMoney(tier.monthly_fee)}/mo`;
}

// ─── Capacity section ─────────────────────────────────────────────────────────

/**
 * Renders the full Capacity picker (mode toggle + tier select OR custom
 * inputs). Fully controlled by a `useTrunkCapacity()` controller so it stays
 * identical across both create forms.
 */
export function TrunkCapacitySection({ ctl }: { ctl: TrunkCapacityController }) {
  return (
    <div>
      <div style={sectionLabelStyle}>Capacity</div>

      <ModeToggle mode={ctl.mode} onChange={ctl.setMode} />

      {ctl.mode === 'tier' ? (
        <div>
          {ctl.tiersLoading ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                color: '#718096',
                fontSize: '0.8rem',
                padding: '6px 0',
              }}
            >
              <Spinner size="xs" /> Loading tiers…
            </div>
          ) : ctl.tiersError ? (
            <div style={{ fontSize: '0.8rem', color: '#fca5a5' }}>
              Could not load tiers. Switch to Custom to set CPS and call paths manually.
            </div>
          ) : (
            <FormField
              label="Service Tier"
              as="select"
              value={ctl.tierId}
              onChange={(e) => ctl.setTierId((e.target as HTMLSelectElement).value)}
              hint="Server derives CPS and call paths from the selected tier."
            >
              <option value="">Select tier…</option>
              {ctl.tiers.map((tier) => (
                <option key={tier.id} value={tier.id}>
                  {formatTierOption(tier)}
                </option>
              ))}
            </FormField>
          )}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <FormField
            label="CPS"
            type="number"
            min="1"
            step="1"
            value={ctl.customCps}
            onChange={(e) => ctl.setCustomCps((e.target as HTMLInputElement).value)}
            placeholder="1"
            hint="Calls per second"
          />
          <FormField
            label="Call Paths"
            type="number"
            min="1"
            step="1"
            value={ctl.customPaths}
            onChange={(e) => ctl.setCustomPaths((e.target as HTMLInputElement).value)}
            placeholder="20"
            hint="Max concurrent channels"
          />
        </div>
      )}
    </div>
  );
}

// ─── Authorized IPs section ───────────────────────────────────────────────────

/**
 * Renders the add-to-list Authorized-IPs UI (input + Add, chip list with
 * remove, inline validation). Controlled by a `useTrunkAuthIps()` controller.
 */
export function TrunkAuthIpsSection({ ctl }: { ctl: TrunkAuthIpsController }) {
  const canAdd = ctl.draft.trim().length > 0 && ctl.draftError === null;

  return (
    <div>
      <div style={sectionLabelStyle}>Authorized IPs</div>
      <div style={{ ...hintStyle, marginBottom: 10 }}>
        Whitelist the customer&apos;s PBX IPs (IPv4, optional /CIDR). Optional — you can add
        more later.
      </div>

      {ctl.ips.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          {ctl.ips.map((ip) => (
            <span
              key={ip}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 8px 5px 12px',
                borderRadius: 20,
                background: 'rgba(59,130,246,0.08)',
                border: '1px solid rgba(59,130,246,0.22)',
                fontFamily: monoFont,
                fontSize: '0.78rem',
                color: '#e2e8f0',
              }}
            >
              {ip}
              <button
                type="button"
                onClick={() => ctl.remove(ip)}
                title={`Remove ${ip}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  border: 'none',
                  background: 'rgba(239,68,68,0.15)',
                  color: '#f87171',
                  cursor: 'pointer',
                  fontSize: '0.7rem',
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 220px', minWidth: 160 }}>
          <FormField
            label="IP Address"
            value={ctl.draft}
            onChange={(e) => ctl.setDraft((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                ctl.add();
              }
            }}
            placeholder="203.0.113.10 or 203.0.113.0/24"
            error={ctl.draftError ?? undefined}
            style={{ fontFamily: monoFont }}
          />
        </div>
        <div style={{ paddingTop: 22, flexShrink: 0 }}>
          <Button type="button" variant="ghost" size="sm" disabled={!canAdd} onClick={ctl.add}>
            + Add IP
          </Button>
        </div>
      </div>
    </div>
  );
}
