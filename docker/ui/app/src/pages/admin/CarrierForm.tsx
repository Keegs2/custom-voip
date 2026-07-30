import { useState, useCallback } from 'react';
import { FormField } from '../../components/ui/FormField';
import { Button } from '../../components/ui/Button';
import { cn } from '../../utils/cn';
import type { Carrier, CarrierCreate, CarrierTransport, CarrierAuthType } from '../../types/carrier';

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
    <div className="-m-5 flex flex-col">
      {/* Intro / subtitle — clarifies purpose beneath the modal title, with a divider */}
      <div className="px-6 pt-5 pb-4 border-b border-[#2a2f45]">
        <p className="text-[0.82rem] leading-relaxed text-[#718096]">
          {carrier
            ? 'Update the SIP trunk connection and routing options for this carrier.'
            : 'Configure a SIP trunk connection to an upstream carrier. Fields marked with an asterisk are required.'}
        </p>
      </div>

      {/* Scrollable body — generous padding and consistent vertical rhythm between sections */}
      <div className="px-6 py-6 space-y-8">
        {error && (
          <p className="text-red-400 text-[0.82rem] bg-red-500/[0.08] border border-red-500/25 rounded-lg px-4 py-3">
            {error}
          </p>
        )}

        {/* Identity */}
        <FormSection
          title="Identity"
          description="How this carrier is labelled across the platform."
        >
          <FormField
            label="Display Name"
            required
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Acme Carrier"
          />
          <FormField
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
          />
        </FormSection>

        {/* Connection */}
        <FormSection
          title="Connection"
          description="Where SIP signaling is sent and how it is transported."
        >
          <FormField
            fullWidth
            label="SIP Proxy Hostname / IP"
            required
            value={sipProxy}
            onChange={(e) => setSipProxy(e.target.value)}
            placeholder="sip.carrier.com"
          />
          <FormField
            label="Port"
            type="number"
            min="1"
            max="65535"
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
          <FormField
            as="select"
            label="Transport"
            value={transport}
            onChange={(e) => setTransport(e.target.value as CarrierTransport)}
          >
            {TRANSPORTS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </FormField>
        </FormSection>

        {/* Authentication */}
        <FormSection
          title="Authentication"
          description="How the carrier authenticates this trunk."
        >
          <FormField
            as="select"
            label="Auth Type"
            value={authType}
            onChange={(e) => setAuthType(e.target.value as CarrierAuthType)}
          >
            {AUTH_TYPES.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </FormField>

          {showCredentials && (
            <>
              <FormField
                label="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="sip-user"
              />
              <FormField
                label="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={carrier ? 'leave blank to keep unchanged' : ''}
              />
            </>
          )}
        </FormSection>

        {/* Capacity & Media */}
        <FormSection
          title="Capacity & Media"
          description="Optional limits and negotiated codecs. Leave blank for unlimited."
        >
          <FormField
            fullWidth
            label="Codec Preferences"
            value={codecPrefs}
            onChange={(e) => setCodecPrefs(e.target.value)}
            placeholder="PCMU,PCMA"
            hint="Comma-separated codec list"
          />
          <FormField
            label="Max Channels"
            type="number"
            min="1"
            value={maxChannels}
            onChange={(e) => setMaxChannels(e.target.value)}
            placeholder="unlimited"
          />
          <FormField
            label="CPS Limit"
            type="number"
            min="1"
            value={cpsLimit}
            onChange={(e) => setCpsLimit(e.target.value)}
            placeholder="unlimited"
          />
        </FormSection>

        {/* Routing & Roles */}
        <FormSection
          title="Routing & Roles"
          description="Which products use this carrier and how it behaves in the route plan."
        >
          <div className="col-span-2 space-y-4">
            <div>
              <p className="text-[0.68rem] font-semibold text-[#4a5568] uppercase tracking-[0.04em] mb-2.5">
                Product Types
              </p>
              <div className="flex flex-wrap gap-2.5">
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
              <p className="text-[0.68rem] font-semibold text-[#4a5568] uppercase tracking-[0.04em] mb-2.5">
                Role &amp; Options
              </p>
              <div className="flex flex-wrap gap-2.5">
                <CheckboxPill label="Primary" checked={isPrimary} onChange={() => setIsPrimary((p) => !p)} />
                <CheckboxPill label="Failover" checked={isFailover} onChange={() => setIsFailover((p) => !p)} />
                <CheckboxPill label="Register" checked={register} onChange={() => setRegister((p) => !p)} />
                <CheckboxPill label="Caller ID in From" checked={callerIdInFrom} onChange={() => setCallerIdInFrom((p) => !p)} />
                <CheckboxPill label="Enabled" checked={enabled} onChange={() => setEnabled((p) => !p)} />
              </div>
            </div>
          </div>
        </FormSection>
      </div>

      {/* Footer actions — separated by a top divider, right-aligned, primary uses blue brand */}
      <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[#2a2f45] bg-[#161925]/60 rounded-b-xl">
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} loading={submitting}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

interface FormSectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
}

/**
 * A labelled group of form fields. Renders a section heading + optional
 * description, then a responsive grid (single column on narrow widths,
 * two columns from `sm` up). Use `fullWidth` on a FormField to make it
 * span both columns.
 */
function FormSection({ title, description, children }: FormSectionProps) {
  return (
    <section>
      <div className="mb-4">
        <h3 className="text-[0.82rem] font-bold text-[#e2e8f0] tracking-[-0.01em]">
          {title}
        </h3>
        {description && (
          <p className="text-[0.75rem] text-[#718096] mt-1 leading-relaxed">
            {description}
          </p>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4">
        {children}
      </div>
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
    <label
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 rounded-lg cursor-pointer',
        'border text-[0.8rem] font-medium transition-[background,border-color] duration-150 select-none',
        checked
          ? 'bg-blue-500/[0.12] border-blue-500/30 text-blue-300'
          : 'bg-transparent border-[#2a2f45] text-[#718096] hover:border-[#363c57] hover:text-[#e2e8f0]',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="sr-only"
      />
      <span
        className={cn(
          'w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0',
          checked
            ? 'bg-blue-500 border-blue-500 text-white'
            : 'border-[#2a2f45]',
        )}
      >
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
