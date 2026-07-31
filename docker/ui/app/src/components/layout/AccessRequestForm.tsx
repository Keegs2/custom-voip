import { useState, useCallback, useEffect, type FormEvent, type CSSProperties } from 'react';
import { ChevronLeft, ChevronRight, CheckCircle, Send } from 'lucide-react';
import { submitOnboardingRequest } from '../../api/onboarding';

/* ─── Types ───────────────────────────────────────────────── */

interface FormData {
  company_name: string;
  contact_name: string;
  email: string;
  phone: string;
  did_count: string;
  porting: string;
  current_carrier: string;
  forwarding_setup: string;
  monthly_volume: string;
  timeline: string;
}

type FieldErrors = Partial<Record<keyof FormData, string>>;

const EMPTY_FORM: FormData = {
  company_name: '',
  contact_name: '',
  email: '',
  phone: '',
  did_count: '',
  porting: '',
  current_carrier: '',
  forwarding_setup: '',
  monthly_volume: '',
  timeline: '',
};

/* ─── Constants ───────────────────────────────────────────── */

const DID_COUNT_OPTIONS = ['1–10', '11–50', '51–200', '201–1,000', '1,000+'];

const PORTING_OPTIONS = [
  'Yes — porting from another carrier',
  'No — need new numbers',
  'Both — porting some + new numbers',
];

const FORWARDING_OPTIONS = [
  'All numbers forward to one destination',
  'Each number forwards to a different destination',
  'Need help deciding',
];

const VOLUME_OPTIONS = [
  'Under 1,000 calls',
  '1,000–10,000',
  '10,000–50,000',
  '50,000+',
];

const TIMELINE_OPTIONS = [
  'ASAP',
  'Within 30 days',
  '1–3 months',
  'Just exploring',
];

const ACCENT = '#3b82f6';
const ACCENT_BRIGHT = '#60a5fa';
const ACCENT_DIM = 'rgba(59,130,246,0.12)';
const ACCENT_BORDER = 'rgba(59,130,246,0.30)';

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
  fontWeight: 600,
  letterSpacing: '0.05em',
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
        border: `1px solid ${hasError ? 'rgba(239,68,68,0.55)' : isFocused ? ACCENT : 'rgba(42,47,69,0.8)'}`,
        boxShadow: hasError
          ? '0 0 0 2px rgba(239,68,68,0.12)'
          : isFocused
          ? `0 0 0 3px rgba(59,130,246,0.16)`
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
        border: `1px solid ${hasError ? 'rgba(239,68,68,0.55)' : isFocused ? ACCENT : 'rgba(42,47,69,0.8)'}`,
        boxShadow: hasError
          ? '0 0 0 2px rgba(239,68,68,0.12)'
          : isFocused
          ? `0 0 0 3px rgba(59,130,246,0.16)`
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
              ? ACCENT
              : i < current
              ? 'rgba(59,130,246,0.40)'
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
        type="button"
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
              ? 'rgba(59,130,246,0.35)'
              : `linear-gradient(135deg, #2563eb 0%, ${ACCENT} 100%)`
            : 'rgba(59,130,246,0.10)',
          border: `1px solid ${isLastStep ? ACCENT_BORDER : 'rgba(59,130,246,0.20)'}`,
          color: isLastStep ? '#fff' : ACCENT_BRIGHT,
          fontSize: '0.72rem',
          fontWeight: 700,
          cursor: isSubmitting ? 'not-allowed' : 'pointer',
          transition: 'background 0.15s, box-shadow 0.15s',
          boxShadow: isLastStep && !isSubmitting
            ? '0 2px 14px -4px rgba(59,130,246,0.50)'
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

// Returns true when the porting answer requires a current carrier field.
function portingRequiresCarrier(porting: string): boolean {
  return porting.startsWith('Yes') || porting.startsWith('Both');
}

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
    if (!data.did_count)        errs.did_count        = 'Please select an option';
    if (!data.porting)          errs.porting          = 'Please select an option';
    if (portingRequiresCarrier(data.porting) && !data.current_carrier.trim()) {
      errs.current_carrier = 'Required when porting numbers';
    }
    if (!data.forwarding_setup) errs.forwarding_setup = 'Please select an option';
    if (!data.monthly_volume)   errs.monthly_volume   = 'Please select an option';
    if (!data.timeline)         errs.timeline         = 'Please select an option';
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

/* ─── Step 1: RCF Requirements ────────────────────────────── */

interface Step1Props {
  data: FormData;
  errors: FieldErrors;
  onChange: (field: keyof FormData, value: string) => void;
}

function Step1({ data, errors, onChange }: Step1Props) {
  const [focused, setFocused] = useState<string | null>(null);

  // Derived — whether to show the current carrier field
  const showCarrier = portingRequiresCarrier(data.porting);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <Field label="How many phone numbers do you need?" error={errors.did_count}>
        <StyledSelect
          value={data.did_count}
          onChange={(e) => onChange('did_count', e.target.value)}
          hasError={!!errors.did_count}
          isFocused={focused === 'did_count'}
          onFocusChange={(f) => setFocused(f ? 'did_count' : null)}
        >
          <option value="" disabled>Select a range…</option>
          {DID_COUNT_OPTIONS.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </StyledSelect>
      </Field>

      <Field label="Are you porting existing numbers?" error={errors.porting}>
        <StyledSelect
          value={data.porting}
          onChange={(e) => onChange('porting', e.target.value)}
          hasError={!!errors.porting}
          isFocused={focused === 'porting'}
          onFocusChange={(f) => setFocused(f ? 'porting' : null)}
        >
          <option value="" disabled>Select an option…</option>
          {PORTING_OPTIONS.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </StyledSelect>
      </Field>

      {/* Conditional: only shown when porting is Yes or Both */}
      {showCarrier && (
        <Field label="Current carrier" error={errors.current_carrier}>
          <StyledInput
            type="text"
            placeholder="e.g. AT&T, Lumen, Verizon"
            value={data.current_carrier}
            onChange={(e) => onChange('current_carrier', e.target.value)}
            hasError={!!errors.current_carrier}
            isFocused={focused === 'current_carrier'}
            onFocusChange={(f) => setFocused(f ? 'current_carrier' : null)}
          />
        </Field>
      )}

      <Field label="Forwarding setup" error={errors.forwarding_setup}>
        <StyledSelect
          value={data.forwarding_setup}
          onChange={(e) => onChange('forwarding_setup', e.target.value)}
          hasError={!!errors.forwarding_setup}
          isFocused={focused === 'forwarding_setup'}
          onFocusChange={(f) => setFocused(f ? 'forwarding_setup' : null)}
        >
          <option value="" disabled>Select an option…</option>
          {FORWARDING_OPTIONS.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </StyledSelect>
      </Field>

      <Field label="Expected monthly call volume" error={errors.monthly_volume}>
        <StyledSelect
          value={data.monthly_volume}
          onChange={(e) => onChange('monthly_volume', e.target.value)}
          hasError={!!errors.monthly_volume}
          isFocused={focused === 'monthly_volume'}
          onFocusChange={(f) => setFocused(f ? 'monthly_volume' : null)}
        >
          <option value="" disabled>Select a range…</option>
          {VOLUME_OPTIONS.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </StyledSelect>
      </Field>

      <Field label="When do you need this live?" error={errors.timeline}>
        <StyledSelect
          value={data.timeline}
          onChange={(e) => onChange('timeline', e.target.value)}
          hasError={!!errors.timeline}
          isFocused={focused === 'timeline'}
          onFocusChange={(f) => setFocused(f ? 'timeline' : null)}
        >
          <option value="" disabled>Select a timeline…</option>
          {TIMELINE_OPTIONS.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </StyledSelect>
      </Field>
    </div>
  );
}

/* ─── Step 2: Review & Submit ─────────────────────────────── */

interface Step2Props {
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
          fontWeight: 600,
          letterSpacing: '0.05em',
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

const sectionHeadStyle: CSSProperties = {
  fontSize: '0.58rem',
  fontWeight: 600,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: ACCENT_BRIGHT,
  marginBottom: 2,
  opacity: 0.8,
};

function Step2({ data }: Step2Props) {
  const showCarrier = portingRequiresCarrier(data.porting);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {/* Section: Contact */}
      <p style={sectionHeadStyle}>Contact</p>
      <ReviewRow label="Company"      value={data.company_name} />
      <ReviewRow label="Contact"      value={data.contact_name} />
      <ReviewRow label="Email"        value={data.email} />
      <ReviewRow label="Phone"        value={data.phone} />

      {/* Section: RCF Requirements */}
      <p style={{ ...sectionHeadStyle, marginTop: 6 }}>RCF Requirements</p>
      <ReviewRow label="Phone Numbers"    value={data.did_count} />
      <ReviewRow label="Porting"          value={data.porting} />
      {showCarrier && (
        <ReviewRow label="Current Carrier" value={data.current_carrier} />
      )}
      <ReviewRow label="Forwarding Setup" value={data.forwarding_setup} />
      <ReviewRow label="Monthly Volume"   value={data.monthly_volume} />
      <ReviewRow label="Timeline"         value={data.timeline} />

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
          background: ACCENT_DIM,
          border: `1.5px solid ${ACCENT_BORDER}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <CheckCircle size={22} strokeWidth={1.8} style={{ color: ACCENT_BRIGHT }} />
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
  const [expanded, setExpanded]           = useState(false);
  const [step, setStep]                   = useState(0);
  const [formData, setFormData]           = useState<FormData>(EMPTY_FORM);
  const [errors, setErrors]               = useState<FieldErrors>({});
  const [submitted, setSubmitted]         = useState(false);
  const [isSubmitting, setIsSubmitting]   = useState(false);
  const [submitError, setSubmitError]     = useState<string | null>(null);
  const [headerHovered, setHeaderHovered] = useState(false);

  const TOTAL_STEPS = 3; // Step 0: Contact, Step 1: RCF Requirements, Step 2: Review

  // Listen for the 'open-access-request' custom event dispatched by the dashboard
  // when an unauthenticated user clicks the RCF tile or the CTA button. This avoids
  // prop drilling through AppLayout → Sidebar → AccessRequestForm.
  useEffect(() => {
    function handleOpen() { setExpanded(true); }
    window.addEventListener('open-access-request', handleOpen);
    return () => window.removeEventListener('open-access-request', handleOpen);
  }, []);

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

  const handleSubmit = useCallback(async () => {
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await submitOnboardingRequest({
        company_name: formData.company_name,
        contact_name: formData.contact_name,
        email: formData.email,
        // Human contact field, not a routable DID — light touch, just trim. We do
        // NOT force E.164 here (see utils/phone.ts for the DID-normalization path).
        phone: formData.phone.trim(),
        did_count: formData.did_count,
        porting: formData.porting,
        current_carrier: formData.current_carrier || undefined,
        forwarding_setup: formData.forwarding_setup,
        monthly_volume: formData.monthly_volume,
        timeline: formData.timeline,
      });
      setSubmitted(true);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submission failed. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
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
            New to Granite CRAG?
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
              border: `1px solid ${headerHovered && !expanded ? 'rgba(59,130,246,0.50)' : ACCENT_BORDER}`,
              background: expanded ? ACCENT_DIM : headerHovered ? 'rgba(59,130,246,0.08)' : 'transparent',
              color: ACCENT_BRIGHT,
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
                <path d="M1 9 9 1M9 1H3M9 1v6" stroke={ACCENT_BRIGHT} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
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
                    <Step2 data={formData} />
                  )}

                  {submitError && (
                    <p style={{ ...errorStyle, marginTop: 10, textAlign: 'center' }}>
                      {submitError}
                    </p>
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
