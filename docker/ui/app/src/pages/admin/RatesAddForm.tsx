import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createRate } from '../../api/rates';
import { Button } from '../../components/ui/Button';
import { useToast } from '../../components/ui/Toast';
import { cn } from '../../utils/cn';

const labelStyle: React.CSSProperties = {
  fontSize: '0.65rem',
  fontWeight: 700,
  color: '#4a5568',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  marginBottom: 6,
  display: 'block',
};

const inputStyle: React.CSSProperties = {
  fontSize: '0.875rem',
  padding: '8px 12px',
  borderRadius: 8,
  width: '100%',
  border: '1px solid rgba(42,47,69,0.8)',
  background: 'rgba(13,15,21,0.8)',
  color: '#e2e8f0',
  outline: 'none',
  transition: 'border-color 0.15s, box-shadow 0.15s',
};

function handleFocus(e: React.FocusEvent<HTMLInputElement>) {
  e.currentTarget.style.borderColor = '#3b82f6';
  e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.15)';
}

function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
  e.currentTarget.style.borderColor = 'rgba(42,47,69,0.8)';
  e.currentTarget.style.boxShadow = 'none';
}

interface FormState {
  prefix: string;
  description: string;
  rate_per_min: string;
  cost_per_min: string;
  connection_fee: string;
  increment: string;
}

const defaultForm: FormState = {
  prefix: '',
  description: '',
  rate_per_min: '',
  cost_per_min: '',
  connection_fee: '0',
  increment: '6',
};

export function RatesAddForm() {
  const { toastOk, toastErr } = useToast();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [form, setForm] = useState<FormState>(defaultForm);

  function set<K extends keyof FormState>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const sell = parseFloat(form.rate_per_min);
  const cost = parseFloat(form.cost_per_min);
  const marginValue = !isNaN(sell) && !isNaN(cost) ? sell - cost : null;
  const marginPct =
    marginValue != null && sell > 0
      ? (marginValue / sell) * 100
      : marginValue != null && cost === 0 && sell === 0
        ? 0
        : null;

  const marginPreviewClass =
    marginValue == null
      ? 'text-[#718096]'
      : marginValue < 0
        ? 'text-red-400'
        : 'text-green-400';

  const createMutation = useMutation({
    mutationFn: () =>
      createRate({
        prefix: form.prefix.trim(),
        description: form.description.trim() || null,
        rate_per_min: parseFloat(form.rate_per_min),
        cost_per_min: parseFloat(form.cost_per_min),
        connection_fee: parseFloat(form.connection_fee) || 0,
        increment: parseInt(form.increment, 10) || 6,
      }),
    onSuccess: () => {
      toastOk(`Rate ${form.prefix} added`);
      setForm(defaultForm);
      setIsOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['rates'] });
      void queryClient.invalidateQueries({ queryKey: ['margins'] });
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleCreate() {
    const prefix = form.prefix.trim();
    if (!prefix) { toastErr('Prefix is required'); return; }
    if (isNaN(sell)) { toastErr('Sell rate is required'); return; }
    if (isNaN(cost)) { toastErr('Cost rate is required'); return; }
    if (sell < 0) { toastErr('Sell rate must be non-negative'); return; }
    if (cost < 0) { toastErr('Cost rate must be non-negative'); return; }
    createMutation.mutate();
  }

  function toggleOpen() {
    setIsOpen((o) => {
      if (o) setForm(defaultForm);
      return !o;
    });
  }

  return (
    <div>
      <Button variant="primary" size="sm" onClick={toggleOpen}>
        {isOpen ? '— Cancel' : '+ Add Rate'}
      </Button>

      {isOpen && (
        <div
          style={{
            marginTop: 16,
            background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
            border: '1px solid rgba(42,47,69,0.6)',
            borderRadius: 16,
            padding: '28px 28px 24px',
            boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          {/* Top accent line */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 32,
              right: 32,
              height: 2,
              background: 'linear-gradient(90deg, transparent, #3b82f6, transparent)',
              opacity: 0.6,
            }}
          />

          <div
            style={{
              fontSize: '0.65rem',
              fontWeight: 700,
              color: '#3b82f6',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              marginBottom: 20,
            }}
          >
            New Rate
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Prefix */}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <label style={labelStyle}>
                Prefix <span style={{ color: '#f87171', marginLeft: 2 }}>*</span>
              </label>
              <input
                style={inputStyle}
                placeholder="e.g. 1800"
                value={form.prefix}
                onChange={(e) => set('prefix', e.target.value)}
                onFocus={handleFocus}
                onBlur={handleBlur}
              />
            </div>

            {/* Description */}
            <div style={{ display: 'flex', flexDirection: 'column' }} className="lg:col-span-2">
              <label style={labelStyle}>Description</label>
              <input
                style={inputStyle}
                placeholder="e.g. US Toll-Free"
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                onFocus={handleFocus}
                onBlur={handleBlur}
              />
            </div>

            {/* Sell rate */}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <label style={labelStyle}>
                Sell Rate / Min <span style={{ color: '#f87171', marginLeft: 2 }}>*</span>
              </label>
              <input
                style={inputStyle}
                type="number"
                step="0.0001"
                min="0"
                placeholder="0.0100"
                value={form.rate_per_min}
                onChange={(e) => set('rate_per_min', e.target.value)}
                onFocus={handleFocus}
                onBlur={handleBlur}
              />
            </div>

            {/* Cost rate */}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <label style={labelStyle}>
                Cost Rate / Min <span style={{ color: '#f87171', marginLeft: 2 }}>*</span>
              </label>
              <input
                style={inputStyle}
                type="number"
                step="0.0001"
                min="0"
                placeholder="0.0060"
                value={form.cost_per_min}
                onChange={(e) => set('cost_per_min', e.target.value)}
                onFocus={handleFocus}
                onBlur={handleBlur}
              />
            </div>

            {/* Margin preview */}
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
              <label style={labelStyle}>Margin Preview</label>
              <div
                style={{
                  padding: '9px 12px',
                  fontSize: '0.88rem',
                  fontWeight: 600,
                  minHeight: 38,
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(42,47,69,0.5)',
                  borderRadius: 8,
                }}
              >
                {marginValue != null ? (
                  <span className={cn(marginPreviewClass)}>
                    {marginValue >= 0 ? '+' : ''}${marginValue.toFixed(4)}{' '}
                    {marginPct != null && isFinite(marginPct)
                      ? `(${marginPct.toFixed(1)}%)`
                      : ''}
                  </span>
                ) : (
                  <span style={{ color: '#4a5568' }}>—</span>
                )}
              </div>
            </div>

            {/* Connection fee */}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <label style={labelStyle}>Connection Fee</label>
              <input
                style={inputStyle}
                type="number"
                step="0.001"
                min="0"
                value={form.connection_fee}
                onChange={(e) => set('connection_fee', e.target.value)}
                onFocus={handleFocus}
                onBlur={handleBlur}
              />
            </div>

            {/* Increment */}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <label style={labelStyle}>Increment (s)</label>
              <input
                style={inputStyle}
                type="number"
                step="1"
                min="1"
                value={form.increment}
                onChange={(e) => set('increment', e.target.value)}
                onFocus={handleFocus}
                onBlur={handleBlur}
              />
            </div>
          </div>

          <div
            style={{
              marginTop: 20,
              paddingTop: 20,
              borderTop: '1px solid rgba(42,47,69,0.6)',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <Button
              variant="primary"
              size="sm"
              loading={createMutation.isPending}
              onClick={handleCreate}
            >
              Create Rate
            </Button>
            <Button variant="ghost" size="sm" onClick={toggleOpen}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
