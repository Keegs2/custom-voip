/**
 * CarrierForm — create/edit form for a carrier gateway.
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css, the
 * admin `dlx-*` layer in styles/dl-admin.css, and the platform-scoped
 * `dlx2-*` layer in styles/dl-platform.css). Renders inside a dl-panel
 * body (the add-carrier panel on CarriersTab, or a CarrierCard in edit
 * mode) — it contributes fields and its own footer actions only.
 *
 * React #310: every hook is called unconditionally at the top.
 */
import { useState, useCallback } from 'react';
import type { Carrier, CarrierCreate, CarrierTransport, CarrierAuthType } from '../../types/carrier';
import '../../styles/dl-admin.css';
import '../../styles/dl-platform.css';

type CarrierFormValues = CarrierCreate;

interface CarrierFormProps {
  /** Carrier to pre-populate the form. Omit for "create" mode. */
  carrier?: Carrier;
  onSubmit: (values: CarrierFormValues) => Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
}

const TRANSPORTS: CarrierTransport[] = ['UDP', 'TCP', 'TLS'];
const AUTH_TYPES: Array<{ value: CarrierAuthType; label: string }> = [
  { value: 'ip', label: 'IP-based' },
  { value: 'credentials', label: 'Credentials' },
  { value: 'none', label: 'None' },
];

const PRODUCT_TYPE_OPTIONS = ['rcf', 'api', 'trunk'] as const;
type ProductType = typeof PRODUCT_TYPE_OPTIONS[number];

function generateGatewayName(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

export function CarrierForm({ carrier, onSubmit, onCancel, submitLabel = 'Save' }: CarrierFormProps) {
  const c = carrier;

  const [displayName, setDisplayName] = useState(c?.display_name ?? '');
  const [description, setDescription] = useState(c?.description ?? '');
  const [sipProxy, setSipProxy] = useState(c?.sip_proxy ?? '');
  const [port, setPort] = useState(String(c?.port ?? 5060));
  const [transport, setTransport] = useState<CarrierTransport>(c?.transport ?? 'UDP');
  const [authType, setAuthType] = useState<CarrierAuthType>(c?.auth_type ?? 'ip');
  const [username, setUsername] = useState(c?.username ?? '');
  const [password, setPassword] = useState('');
  const [codecPrefs, setCodecPrefs] = useState(
    Array.isArray(c?.codec_prefs) ? c.codec_prefs.join(',') : 'PCMU,PCMA',
  );
  const [maxChannels, setMaxChannels] = useState(
    c?.max_channels != null ? String(c.max_channels) : '',
  );
  const [cpsLimit, setCpsLimit] = useState(
    c?.cps_limit != null ? String(c.cps_limit) : '',
  );

  const [productTypes, setProductTypes] = useState<Set<ProductType>>(
    new Set((c?.product_types ?? []) as ProductType[]),
  );
  const [isPrimary, setIsPrimary] = useState(c?.is_primary ?? false);
  const [isFailover, setIsFailover] = useState(c?.is_failover ?? false);
  const [register, setRegister] = useState(c?.register ?? false);
  const [callerIdInFrom, setCallerIdInFrom] = useState(c?.caller_id_in_from ?? false);
  const [enabled, setEnabled] = useState(c?.enabled !== false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showCredentials = authType === 'credentials';

  const toggleProductType = useCallback((pt: ProductType) => {
    setProductTypes((prev) => {
      const next = new Set(prev);
      if (next.has(pt)) {
        next.delete(pt);
      } else {
        next.add(pt);
      }
      return next;
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!displayName.trim()) {
      setError('Display name is required');
      return;
    }
    if (!sipProxy.trim()) {
      setError('SIP proxy hostname is required');
      return;
    }

    setError(null);
    setSubmitting(true);

    const values: CarrierFormValues = {
      gateway_name: carrier?.gateway_name ?? generateGatewayName(displayName),
      display_name: displayName.trim(),
      description: description.trim() || null,
      sip_proxy: sipProxy.trim(),
      port: parseInt(port, 10) || 5060,
      transport,
      auth_type: authType,
      username: showCredentials && username ? username : null,
      password: password || null,
      codec_prefs: codecPrefs
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean),
      max_channels: maxChannels ? parseInt(maxChannels, 10) : null,
      cps_limit: cpsLimit ? parseInt(cpsLimit, 10) : null,
      product_types: Array.from(productTypes),
      is_primary: isPrimary,
      is_failover: isFailover,
      register,
      caller_id_in_from: callerIdInFrom,
      enabled,
    };

    try {
      await onSubmit(values);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSubmitting(false);
    }
  }, [
    displayName, description, sipProxy, port, transport, authType, username, password,
    codecPrefs, maxChannels, cpsLimit, productTypes, isPrimary, isFailover,
    register, callerIdInFrom, enabled, showCredentials, onSubmit, carrier,
  ]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Intro — clarifies purpose beneath the panel title */}
      <p style={{ fontSize: '0.8rem', lineHeight: 1.55, color: 'var(--rcf-ink-dim)', margin: 0 }}>
        {carrier
          ? 'Update the SIP trunk connection and routing options for this carrier.'
          : 'Configure a SIP trunk connection to an upstream carrier. Fields marked with an asterisk are required.'}
      </p>

      {error && <div className="dl-banner dl-banner-err">{error}</div>}

      {/* Identity */}
      <FormSection
        title="Identity"
        description="How this carrier is labelled across the platform."
      >
        <Field label="Display Name" required>
          <input
            className="dl-input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Acme Carrier"
          />
        </Field>
        <Field label="Description">
          <input
            className="dl-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
          />
        </Field>
      </FormSection>

      {/* Connection */}
      <FormSection
        title="Connection"
        description="Where SIP signaling is sent and how it is transported."
      >
        <Field label="SIP Proxy Hostname / IP" required fullWidth>
          <input
            className="dl-input dl-input-mono"
            value={sipProxy}
            onChange={(e) => setSipProxy(e.target.value)}
            placeholder="sip.carrier.com"
          />
        </Field>
        <Field label="Port">
          <input
            className="dl-input dl-input-mono"
            type="number"
            min="1"
            max="65535"
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </Field>
        <Field label="Transport">
          <select
            className="dl-input"
            value={transport}
            onChange={(e) => setTransport(e.target.value as CarrierTransport)}
          >
            {TRANSPORTS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </Field>
      </FormSection>

      {/* Authentication */}
      <FormSection
        title="Authentication"
        description="How the carrier authenticates this trunk."
      >
        <Field label="Auth Type">
          <select
            className="dl-input"
            value={authType}
            onChange={(e) => setAuthType(e.target.value as CarrierAuthType)}
          >
            {AUTH_TYPES.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </select>
        </Field>

        {showCredentials && (
          <>
            <Field label="Username">
              <input
                className="dl-input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="sip-user"
              />
            </Field>
            <Field label="Password">
              <input
                className="dl-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={carrier ? 'leave blank to keep unchanged' : ''}
              />
            </Field>
          </>
        )}
      </FormSection>

      {/* Capacity & Media */}
      <FormSection
        title="Capacity & Media"
        description="Optional limits and negotiated codecs. Leave blank for unlimited."
      >
        <Field label="Codec Preferences" hint="Comma-separated codec list" fullWidth>
          <input
            className="dl-input dl-input-mono"
            value={codecPrefs}
            onChange={(e) => setCodecPrefs(e.target.value)}
            placeholder="PCMU,PCMA"
          />
        </Field>
        <Field label="Max Channels">
          <input
            className="dl-input"
            type="number"
            min="1"
            value={maxChannels}
            onChange={(e) => setMaxChannels(e.target.value)}
            placeholder="unlimited"
          />
        </Field>
        <Field label="CPS Limit">
          <input
            className="dl-input"
            type="number"
            min="1"
            value={cpsLimit}
            onChange={(e) => setCpsLimit(e.target.value)}
            placeholder="unlimited"
          />
        </Field>
      </FormSection>

      {/* Routing & Roles */}
      <FormSection
        title="Routing & Roles"
        description="Which products use this carrier and how it behaves in the route plan."
        grid={false}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <span className="dl-flabel">Product Types</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {PRODUCT_TYPE_OPTIONS.map((pt) => (
                <CheckboxPill
                  key={pt}
                  label={pt.toUpperCase()}
                  checked={productTypes.has(pt)}
                  onChange={() => toggleProductType(pt)}
                />
              ))}
            </div>
          </div>

          <div>
            <span className="dl-flabel">Role &amp; Options</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              <CheckboxPill label="Primary" checked={isPrimary} onChange={() => setIsPrimary((p) => !p)} />
              <CheckboxPill label="Failover" checked={isFailover} onChange={() => setIsFailover((p) => !p)} />
              <CheckboxPill label="Register" checked={register} onChange={() => setRegister((p) => !p)} />
              <CheckboxPill label="Caller ID in From" checked={callerIdInFrom} onChange={() => setCallerIdInFrom((p) => !p)} />
              <CheckboxPill label="Enabled" checked={enabled} onChange={() => setEnabled((p) => !p)} />
            </div>
          </div>
        </div>
      </FormSection>

      {/* Footer actions */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          paddingTop: 18,
          borderTop: '1px solid var(--rcf-line)',
        }}
      >
        <button
          type="button"
          className="dl-btn dl-btn-primary"
          onClick={() => void handleSubmit()}
          disabled={submitting}
        >
          {submitting ? 'Saving…' : submitLabel}
        </button>
        <button
          type="button"
          className="dl-btn dl-btn-ghost"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Local presentation helpers
 * ──────────────────────────────────────────────────────────────────────── */

interface FieldProps {
  label: string;
  required?: boolean;
  hint?: string;
  fullWidth?: boolean;
  children: React.ReactNode;
}

/** Vertical dl-flabel + field group. `fullWidth` spans the whole form grid. */
function Field({ label, required, hint, fullWidth, children }: FieldProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        ...(fullWidth ? { gridColumn: '1 / -1' } : {}),
      }}
    >
      <span className="dl-flabel">
        {label}
        {required && <span style={{ color: 'var(--rcf-red)', marginLeft: 3 }}>*</span>}
      </span>
      {children}
      {hint && <span className="dl-help">{hint}</span>}
    </div>
  );
}

interface FormSectionProps {
  title: string;
  description?: string;
  /** When false, children render in a plain column instead of the field grid. */
  grid?: boolean;
  children: React.ReactNode;
}

/**
 * A labelled group of form fields — daylight section title + optional dim
 * description, then a responsive auto-fill field grid (`dlx-form-grid`).
 */
function FormSection({ title, description, grid = true, children }: FormSectionProps) {
  return (
    <section>
      <div style={{ marginBottom: 12 }}>
        <h3 className="dl-section-title" style={{ marginBottom: description ? 4 : 0 }}>
          {title}
        </h3>
        {description && (
          <p style={{ fontSize: '0.74rem', lineHeight: 1.5, color: 'var(--rcf-ink-dim)', margin: 0 }}>
            {description}
          </p>
        )}
      </div>
      {grid ? <div className="dlx-form-grid">{children}</div> : children}
    </section>
  );
}

interface CheckboxPillProps {
  label: string;
  checked: boolean;
  onChange: () => void;
}

function CheckboxPill({ label, checked, onChange }: CheckboxPillProps) {
  return (
    <label className={checked ? 'dlx2-checkpill dlx2-checkpill-on' : 'dlx2-checkpill'}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      />
      <span className="dlx2-checkpill-box" aria-hidden="true">
        {checked && (
          <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
            <path d="M1 3.5L3.5 6L8 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      {label}
    </label>
  );
}
