import { useState, useCallback, type FormEvent, type CSSProperties } from 'react';
import { ChevronLeft, ChevronRight, CheckCircle, Send } from 'lucide-react';

/* ─── Types ───────────────────────────────────────────────── */

interface FormData {
  company_name: string;
  contact_name: string;
  email: string;
  phone: string;
  did_count: string;
  use_case: string;
  current_provider: string;
  regions: string[];
  monthly_volume: string;
  redundancy: string;
  integration_notes: string;
}

type FieldErrors = Partial<Record<keyof FormData, string>>;

const EMPTY_FORM: FormData = {
  company_name: '',
  contact_name: '',
  email: '',
  phone: '',
  did_count: '',
  use_case: '',
  current_provider: '',
  regions: [],
  monthly_volume: '',
  redundancy: '',
  integration_notes: '',
};

/* ─── Constants ───────────────────────────────────────────── */

const DID_COUNT_OPTIONS = ['1–10', '11–50', '51–200', '201–500', '500+'];
const USE_CASE_OPTIONS  = [
  'Remote Call Forwarding',
  'SIP Trunking',
  'API Calling',
  'Full UCaaS',
  'Not sure',
];
const REGIONS = ['Northeast', 'Southeast', 'Midwest', 'West Coast', 'Nationwide'];
const VOLUME_OPTIONS = [
  'Under 1,000',
  '1,000–10,000',
  '10,000–100,000',
  '100,000+',
];
const REDUNDANCY_OPTIONS = ['Standard', 'High Availability', 'Carrier-Grade'];

const AMBER = '#f59e0b';
const AMBER_DIM = 'rgba(245,158,11,0.12)';
const AMBER_BORDER = 'rgba(245,158,11,0.25)';

/* ─── Style helpers ───────────────────────────────────────── */

const inputBase: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'rgba(13,15,21,0.8)',
  borderRadius: 7,
  padding: '7px 9px',
  fontSize: '0.75rem',
  color: '#e2e8f0',
  outline: 'none',
  transition: 'border-color 0.15s, box-shadow 0.15s',
  fontFamily: 'inherit',
};

const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: '0.62rem',
  fontWeight: 700,
  letterSpacing: '0.07em',
  textTransform: 'uppercase',
  color: '#475569',
  marginBottom: 4,
  userSelect: 'none',
};

const errorStyle: CSSProperties = {
  fontSize: '0.62rem',
  color: '#f87171',
  marginTop: 3,
  lineHeight: 1.35,
};

/* ─── Sub-components ──────────────────────────────────────── */

interface FieldProps {
  label: string;
  error?: string;
  children: React.ReactNode;
}

function Field({ label, error, children }: FieldProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <label style={labelStyle}>{label}</label>
      {children}
      {error && <span style={errorStyle}>{error}</span>}
    </div>
  );
}

interface StyledInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  hasError?: boolean;
  isFocused?: boolean;
  onFocusChange?: (f: boolean) => void;
}

function StyledInput({ hasError, isFocused, onFocusChange, style, ...rest }: StyledInputProps) {
  return (
    <input
      {...rest}
      onFocus={() => onFocusChange?.(true)}
      onBlur={() => onFocusChange?.(false)}
      style={{
        ...inputBase,
        border: `1px solid ${hasError ? 'rgba(239,68,68,0.55)' : isFocused ? AMBER : 'rgba(42,47,69,0.8)'}`,
        boxShadow: hasError
          ? '0 0 0 2px rgba(239,68,68,0.12)'
          : isFocused
          ? `0 0 0 2px rgba(245,158,11,0.12)`
          : 'none',
        ...style,
      }}
    />
  );
}

interface StyledSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  hasError?: boolean;
  isFocused?: boolean;
  onFocusChange?: (f: boolean) => void;
}

function StyledSelect({ hasError, isFocused, onFocusChange, children, style, ...rest }: StyledSelectProps) {
  return (
    <select
      {...rest}
      onFocus={() => onFocusChange?.(true)}
      onBlur={() => onFocusChange?.(false)}
      style={{
        ...inputBase,
        border: `1px solid ${hasError ? 'rgba(239,68,68,0.55)' : isFocused ? AMBER : 'rgba(42,47,69,0.8)'}`,
        boxShadow: hasError
          ? '0 0 0 2px rgba(239,68,68,0.12)'
          : isFocused
          ? `0 0 0 2px rgba(245,158,11,0.12)`
          : 'none',
        appearance: 'none',
        cursor: 'pointer',
        ...style,
      }}
    >
      {children}
    </select>
  );
}

/* ─── Step indicator ──────────────────────────────────────── */

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        marginBottom: 14,
      }}
    >
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          style={{
            width: i === current ? 16 : 6,
            height: 6,
            borderRadius: 3,
            background: i === current
              ? AMBER
              : i < current
              ? 'rgba(245,158,11,0.35)'
              : 'rgba(42,47,69,0.7)',
            transition: 'width 0.2s ease, background 0.2s ease',
          }}
        />
      ))}
      <span
        style={{
          fontSize: '0.58rem',
          color: '#334155',
          marginLeft: 4,
          fontWeight: 600,
          letterSpacing: '0.05em',
        }}
      >
        {current + 1}/{total}
      </span>
    </div>
  );
}

/* ─── Navigation buttons ──────────────────────────────────── */

interface NavButtonsProps {
  onBack?: () => void;
  onNext?: () => void;
  onSubmit?: () => void;
  isSubmitting?: boolean;
  isLastStep?: boolean;
}

function NavButtons({ onBack, onNext, onSubmit, isSubmitting, isLastStep }: NavButtonsProps) {
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            padding: '7px 10px',
            borderRadius: 7,
            background: 'transparent',
            border: '1px solid rgba(42,47,69,0.7)',
            color: '#475569',
            fontSize: '0.72rem',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'background 0.15s, border-color 0.15s, color 0.15s',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
            e.currentTarget.style.color = '#64748b';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = '#475569';
          }}
        >
          <ChevronLeft size={12} strokeWidth={2.5} />
          Back
        </button>
      )}

      <button
        type={isLastStep ? 'button' : 'button'}
        onClick={isLastStep ? onSubmit : onNext}
        disabled={isSubmitting}
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 5,
          padding: '7px 12px',
          borderRadius: 7,
          background: isLastStep
            ? isSubmitting
              ? 'rgba(245,158,11,0.35)'
              : `linear-gradient(135deg, #d97706 0%, ${AMBER} 100%)`
            : 'rgba(245,158,11,0.10)',
          border: `1px solid ${isLastStep ? AMBER_BORDER : 'rgba(245,158,11,0.20)'}`,
          color: isLastStep ? '#0f1117' : AMBER,
          fontSize: '0.72rem',
          fontWeight: 700,
          cursor: isSubmitting ? 'not-allowed' : 'pointer',
          transition: 'background 0.15s, box-shadow 0.15s',
          boxShadow: isLastStep && !isSubmitting
            ? '0 2px 14px -4px rgba(245,158,11,0.45)'
            : 'none',
          letterSpacing: '-0.01em',
        }}
      >
        {isLastStep ? (
          isSubmitting ? (
            'Submitting…'
          ) : (
            <>
              <Send size={11} strokeWidth={2.2} />
              Submit Request
            </>
          )
        ) : (
          <>
            Next
            <ChevronRight size={12} strokeWidth={2.5} />
          </>
        )}
      </button>
    </div>
  );
}

/* ─── Validation ──────────────────────────────────────────── */

function validateStep(step: number, data: FormData): FieldErrors {
  const errs: FieldErrors = {};
  if (step === 0) {
    if (!data.company_name.trim()) errs.company_name = 'Required';
    if (!data.contact_name.trim()) errs.contact_name = 'Required';
    if (!data.email.trim())        errs.email = 'Required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errs.email = 'Invalid email';
    if (!data.phone.trim())        errs.phone = 'Required';
  }
  if (step === 1) {
    if (!data.did_count) errs.did_count = 'Please select an option';
    if (!data.use_case)  errs.use_case  = 'Please select an option';
  }
  if (step === 2) {
    if (data.regions.length === 0)  errs.regions       = 'Select at least one region';
    if (!data.monthly_volume)       errs.monthly_volume = 'Please select an option';
    if (!data.redundancy)           errs.redundancy     = 'Please select an option';
  }
  return errs;
}

/* ─── Step 0: Contact Information ─────────────────────────── */

interface Step0Props {
  data: FormData;
  errors: FieldErrors;
  onChange: (field: keyof FormData, value: string) => void;
}

function Step0({ data, errors, onChange }: Step0Props) {
  const [focused, setFocused] = useState<string | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <Field label="Company Name" error={errors.company_name}>
        <StyledInput
          type="text"
          placeholder="Acme Corporation"
          value={data.company_name}
          onChange={(e) => onChange('company_name', e.target.value)}
          hasError={!!errors.company_name}
          isFocused={focused === 'company_name'}
          onFocusChange={(f) => setFocused(f ? 'company_name' : null)}
          autoComplete="organization"
        />
      </Field>

      <Field label="Contact Name" error={errors.contact_name}>
        <StyledInput
          type="text"
          placeholder="John Smith"
          value={data.contact_name}
          onChange={(e) => onChange('contact_name', e.target.value)}
          hasError={!!errors.contact_name}
          isFocused={focused === 'contact_name'}
          onFocusChange={(f) => setFocused(f ? 'contact_name' : null)}
          autoComplete="name"
        />
      </Field>

      <Field label="Work Email" error={errors.email}>
        <StyledInput
          type="email"
          placeholder="john@acme.com"
          value={data.email}
          onChange={(e) => onChange('email', e.target.value)}
          hasError={!!errors.email}
          isFocused={focused === 'email'}
          onFocusChange={(f) => setFocused(f ? 'email' : null)}
          autoComplete="email"
        />
      </Field>

      <Field label="Phone Number" error={errors.phone}>
        <StyledInput
          type="tel"
          placeholder="+1 (617) 555-0100"
          value={data.phone}
          onChange={(e) => onChange('phone', e.target.value)}
          hasError={!!errors.phone}
          isFocused={focused === 'phone'}
          onFocusChange={(f) => setFocused(f ? 'phone' : null)}
          autoComplete="tel"
        />
      </Field>
    </div>
  );
}

/* ─── Step 1: Service Requirements ────────────────────────── */

interface Step1Props {
  data: FormData;
  errors: FieldErrors;
  onChange: (field: keyof FormData, value: string) => void;
}

function Step1({ data, errors, onChange }: Step1Props) {
  const [focused, setFocused] = useState<string | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <Field label="DID Count" error={errors.did_count}>
        <StyledSelect
          value={data.did_count}
          onChange={(e) => onChange('did_count', e.target.value)}
          hasError={!!errors.did_count}
          isFocused={focused === 'did_count'}
          onFocusChange={(f) => setFocused(f ? 'did_count' : null)}
        >
          <option value="" disabled>Phone numbers needed…</option>
          {DID_COUNT_OPTIONS.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </StyledSelect>
      </Field>

      <Field label="Primary Use Case" error={errors.use_case}>
        <StyledSelect
          value={data.use_case}
          onChange={(e) => onChange('use_case', e.target.value)}
          hasError={!!errors.use_case}
          isFocused={focused === 'use_case'}
          onFocusChange={(f) => setFocused(f ? 'use_case' : null)}
        >
          <option value="" disabled>Select use case…</option>
          {USE_CASE_OPTIONS.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </StyledSelect>
      </Field>

      <Field label="Current Provider (optional)">
        <StyledInput
          type="text"
          placeholder="e.g. AT&T, Lumen, Twilio"
          value={data.current_provider}
          onChange={(e) => onChange('current_provider', e.target.value)}
          isFocused={focused === 'current_provider'}
          onFocusChange={(f) => setFocused(f ? 'current_provider' : null)}
        />
      </Field>
    </div>
  );
}

/* ─── Step 2: Technical Details ───────────────────────────── */

interface Step2Props {
  data: FormData;
  errors: FieldErrors;
  onChange: (field: keyof FormData, value: string) => void;
  onToggleRegion: (region: string) => void;
}

function Step2({ data, errors, onChange, onToggleRegion }: Step2Props) {
  const [focused, setFocused] = useState<string | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {/* Regions checkboxes */}
      <Field label="Geographic Regions" error={errors.regions}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: '6px 8px',
            borderRadius: 7,
            border: `1px solid ${errors.regions ? 'rgba(239,68,68,0.55)' : 'rgba(42,47,69,0.8)'}`,
            background: 'rgba(13,15,21,0.8)',
          }}
        >
          {REGIONS.map((region) => {
            const checked = data.regions.includes(region);
            return (
              <label
                key={region}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  cursor: 'pointer',
                  userSelect: 'none',
                  fontSize: '0.72rem',
                  color: checked ? '#e2e8f0' : '#64748b',
                  transition: 'color 0.12s',
                  padding: '1px 0',
                }}
              >
                <span
                  style={{
                    width: 13,
                    height: 13,
                    borderRadius: 3,
                    border: `1px solid ${checked ? AMBER : 'rgba(42,47,69,0.9)'}`,
                    background: checked ? AMBER_DIM : 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    transition: 'border-color 0.12s, background 0.12s',
                  }}
                >
                  {checked && (
                    <svg viewBox="0 0 10 8" fill="none" style={{ width: 8, height: 8 }}>
                      <path d="M1 4l2.5 2.5L9 1" stroke={AMBER} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleRegion(region)}
                  style={{ display: 'none' }}
                />
                {region}
              </label>
            );
          })}
        </div>
      </Field>

      <Field label="Monthly Call Volume" error={errors.monthly_volume}>
        <StyledSelect
          value={data.monthly_volume}
          onChange={(e) => onChange('monthly_volume', e.target.value)}
          hasError={!!errors.monthly_volume}
          isFocused={focused === 'monthly_volume'}
          onFocusChange={(f) => setFocused(f ? 'monthly_volume' : null)}
        >
          <option value="" disabled>Select volume…</option>
          {VOLUME_OPTIONS.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </StyledSelect>
      </Field>

      <Field label="Redundancy Requirements" error={errors.redundancy}>
        <StyledSelect
          value={data.redundancy}
          onChange={(e) => onChange('redundancy', e.target.value)}
          hasError={!!errors.redundancy}
          isFocused={focused === 'redundancy'}
          onFocusChange={(f) => setFocused(f ? 'redundancy' : null)}
        >
          <option value="" disabled>Select level…</option>
          {REDUNDANCY_OPTIONS.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </StyledSelect>
      </Field>

      <Field label="Integration Notes (optional)">
        <textarea
          value={data.integration_notes}
          onChange={(e) => onChange('integration_notes', e.target.value)}
          placeholder="Existing PBX, SBC, or cloud infrastructure to integrate with…"
          rows={3}
          onFocus={() => setFocused('integration_notes')}
          onBlur={() => setFocused(null)}
          style={{
            ...inputBase,
            border: `1px solid ${focused === 'integration_notes' ? AMBER : 'rgba(42,47,69,0.8)'}`,
            boxShadow: focused === 'integration_notes' ? `0 0 0 2px rgba(245,158,11,0.12)` : 'none',
            resize: 'vertical',
            minHeight: 56,
            lineHeight: 1.45,
          }}
        />
      </Field>
    </div>
  );
}

/* ─── Step 3: Review & Submit ─────────────────────────────── */

interface Step3Props {
  data: FormData;
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        padding: '6px 9px',
        borderRadius: 6,
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(42,47,69,0.4)',
      }}
    >
      <span
        style={{
          fontSize: '0.58rem',
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: '#334155',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: '0.73rem',
          color: '#94a3b8',
          lineHeight: 1.35,
          wordBreak: 'break-word',
        }}
      >
        {value || '—'}
      </span>
    </div>
  );
}

function Step3({ data }: Step3Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {/* Section: Contact */}
      <p
        style={{
          fontSize: '0.58rem',
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: AMBER,
          marginBottom: 2,
          opacity: 0.8,
        }}
      >
        Contact
      </p>
      <ReviewRow label="Company"  value={data.company_name} />
      <ReviewRow label="Contact"  value={data.contact_name} />
      <ReviewRow label="Email"    value={data.email} />
      <ReviewRow label="Phone"    value={data.phone} />

      {/* Section: Service */}
      <p
        style={{
          fontSize: '0.58rem',
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: AMBER,
          marginTop: 6,
          marginBottom: 2,
          opacity: 0.8,
        }}
      >
        Service
      </p>
      <ReviewRow label="DIDs Needed"      value={data.did_count} />
      <ReviewRow label="Use Case"         value={data.use_case} />
      <ReviewRow label="Current Provider" value={data.current_provider} />

      {/* Section: Technical */}
      <p
        style={{
          fontSize: '0.58rem',
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: AMBER,
          marginTop: 6,
          marginBottom: 2,
          opacity: 0.8,
        }}
      >
        Technical
      </p>
      <ReviewRow label="Regions"       value={data.regions.join(', ')} />
      <ReviewRow label="Monthly Volume" value={data.monthly_volume} />
      <ReviewRow label="Redundancy"    value={data.redundancy} />
      {data.integration_notes && (
        <ReviewRow label="Integration Notes" value={data.integration_notes} />
      )}

      {/* Note */}
      <p
        style={{
          fontSize: '0.65rem',
          color: '#334155',
          lineHeight: 1.45,
          marginTop: 8,
          textAlign: 'center',
        }}
      >
        A Granite solution engineer will contact you within 1 business day.
      </p>
    </div>
  );
}

/* ─── Success state ───────────────────────────────────────── */

interface SuccessStateProps {
  onReset: () => void;
}

function SuccessState({ onReset }: SuccessStateProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: 10,
        padding: '20px 8px 12px',
      }}
    >
      {/* Checkmark ring */}
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: '50%',
          background: AMBER_DIM,
          border: `1.5px solid ${AMBER_BORDER}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <CheckCircle size={22} strokeWidth={1.8} style={{ color: AMBER }} />
      </div>

      <div>
        <p
          style={{
            fontSize: '0.85rem',
            fontWeight: 700,
            color: '#e2e8f0',
            marginBottom: 4,
            letterSpacing: '-0.01em',
          }}
        >
          Request Submitted!
        </p>
        <p style={{ fontSize: '0.7rem', color: '#64748b', lineHeight: 1.5 }}>
          Your request has been sent to our solutions team at{' '}
          <span style={{ color: '#94a3b8' }}>solutions@granitenet.com</span>.
        </p>
      </div>

      <p style={{ fontSize: '0.68rem', color: '#475569', lineHeight: 1.45 }}>
        We'll reach out within 1 business day to discuss your needs.
      </p>

      <button
        type="button"
        onClick={onReset}
        style={{
          marginTop: 4,
          background: 'transparent',
          border: 'none',
          color: '#475569',
          fontSize: '0.68rem',
          cursor: 'pointer',
          textDecoration: 'underline',
          textDecorationColor: 'rgba(71,85,105,0.4)',
          transition: 'color 0.15s',
          padding: 0,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = '#64748b'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = '#475569'; }}
      >
        Start Over
      </button>
    </div>
  );
}

/* ─── Main component ──────────────────────────────────────── */

export function AccessRequestForm() {
  // All hooks unconditionally at the top — React #310 prevention
  const [expanded, setExpanded]         = useState(false);
  const [step, setStep]                 = useState(0);
  const [formData, setFormData]         = useState<FormData>(EMPTY_FORM);
  const [errors, setErrors]             = useState<FieldErrors>({});
  const [submitted, setSubmitted]       = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [headerHovered, setHeaderHovered] = useState(false);

  const TOTAL_STEPS = 4;

  const handleChange = useCallback((field: keyof FormData, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    // Clear error for the field being edited
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  const handleToggleRegion = useCallback((region: string) => {
    setFormData((prev) => {
      const regions = prev.regions.includes(region)
        ? prev.regions.filter((r) => r !== region)
        : [...prev.regions, region];
      return { ...prev, regions };
    });
    setErrors((prev) => {
      if (!prev.regions) return prev;
      const next = { ...prev };
      delete next.regions;
      return next;
    });
  }, []);

  const handleNext = useCallback(() => {
    const errs = validateStep(step, formData);
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setErrors({});
    setStep((s) => s + 1);
  }, [step, formData]);

  const handleBack = useCallback(() => {
    setErrors({});
    setStep((s) => s - 1);
  }, []);

  const handleSubmit = useCallback(() => {
    // Payload ready for the future API call
    const payload = {
      ...formData,
      submitted_at: new Date().toISOString(),
    };
    // eslint-disable-next-line no-console
    console.log('[AccessRequest] Form submitted:', JSON.stringify(payload, null, 2));

    setIsSubmitting(true);
    // Simulate a brief network delay so the UI feedback feels real
    setTimeout(() => {
      setIsSubmitting(false);
      setSubmitted(true);
    }, 600);
  }, [formData]);

  const handleReset = useCallback(() => {
    setFormData(EMPTY_FORM);
    setErrors({});
    setStep(0);
    setSubmitted(false);
    setExpanded(false);
  }, []);

  const handleToggleExpanded = useCallback(() => {
    setExpanded((v) => !v);
  }, []);

  /* ── Render ────────────────────────────────────────────── */

  return (
    <div style={{ flexShrink: 0 }}>
      {/* Divider */}
      <div
        style={{
          margin: '0 16px',
          height: 1,
          background: 'linear-gradient(90deg, transparent, rgba(42,47,69,0.6) 20%, rgba(42,47,69,0.6) 80%, transparent)',
        }}
      />

      {/* Collapsed header — always visible */}
      <div style={{ padding: '10px 16px 0' }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span
            style={{
              fontSize: '0.62rem',
              color: '#334155',
              letterSpacing: '0.02em',
              userSelect: 'none',
            }}
          >
            New to Granite Keystone?
          </span>

          <button
            type="button"
            onClick={handleToggleExpanded}
            onMouseEnter={() => setHeaderHovered(true)}
            onMouseLeave={() => setHeaderHovered(false)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              padding: '6px 14px',
              borderRadius: 6,
              border: `1px solid ${headerHovered && !expanded ? 'rgba(245,158,11,0.45)' : AMBER_BORDER}`,
              background: expanded ? AMBER_DIM : headerHovered ? 'rgba(245,158,11,0.08)' : 'transparent',
              color: AMBER,
              fontSize: '0.7rem',
              fontWeight: 700,
              cursor: 'pointer',
              transition: 'background 0.15s, border-color 0.15s',
              letterSpacing: '-0.01em',
              width: '100%',
            }}
          >
            {expanded ? 'Close' : 'Request Access'}
            {!expanded && (
              <svg viewBox="0 0 10 10" fill="none" style={{ width: 8, height: 8 }}>
                <path d="M1 9 9 1M9 1H3M9 1v6" stroke={AMBER} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </div>

        {/* Expandable wizard panel */}
        <div
          style={{
            overflow: 'hidden',
            maxHeight: expanded ? 900 : 0,
            opacity: expanded ? 1 : 0,
            transition: 'max-height 0.3s ease, opacity 0.2s ease',
          }}
        >
          <div
            style={{
              paddingTop: 14,
              paddingBottom: 18,
              // Inner scrolling if content overflows
              maxHeight: 'calc(100vh - 320px)',
              overflowY: 'auto',
              scrollbarWidth: 'thin',
              scrollbarColor: 'rgba(42,47,69,0.6) transparent',
            }}
          >
            {submitted ? (
              <SuccessState onReset={handleReset} />
            ) : (
              <>
                <StepIndicator current={step} total={TOTAL_STEPS} />

                <form
                  onSubmit={(e: FormEvent) => e.preventDefault()}
                  noValidate
                  style={{ display: 'flex', flexDirection: 'column' }}
                >
                  {step === 0 && (
                    <Step0 data={formData} errors={errors} onChange={handleChange} />
                  )}
                  {step === 1 && (
                    <Step1 data={formData} errors={errors} onChange={handleChange} />
                  )}
                  {step === 2 && (
                    <Step2
                      data={formData}
                      errors={errors}
                      onChange={handleChange}
                      onToggleRegion={handleToggleRegion}
                    />
                  )}
                  {step === 3 && (
                    <Step3 data={formData} />
                  )}

                  <NavButtons
                    onBack={step > 0 ? handleBack : undefined}
                    onNext={step < TOTAL_STEPS - 1 ? handleNext : undefined}
                    onSubmit={step === TOTAL_STEPS - 1 ? handleSubmit : undefined}
                    isSubmitting={isSubmitting}
                    isLastStep={step === TOTAL_STEPS - 1}
                  />
                </form>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Bottom breathing room */}
      <div style={{ height: 18 }} />
    </div>
  );
}
