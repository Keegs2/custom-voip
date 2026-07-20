/**
 * RatesAddForm — the collapsible "add a rate prefix" form on a frosted-glass
 * panel. Validation + live margin preview are local; the create mutation lives
 * in the feature hooks.
 */

import { useState } from 'react';
import { Button } from '../../../../../components/ui/Button';
import { useToast } from '../../../../../components/ui/Toast';
import { GlassPanel } from '../../../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../../../components/glass/glass';
import { cn } from '../../../../../utils/cn';
import { labelStyle, glassInput, inputFocus, inputBlur } from '../../styles';
import { useRateCreate } from '../hooks';
import { type AddFormState, DEFAULT_ADD_FORM } from '../types';

const onFocus = inputFocus();

export function RatesAddForm() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const { toastErr } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [form, setForm] = useState<AddFormState>(DEFAULT_ADD_FORM);

  const createMutation = useRateCreate(() => {
    setForm(DEFAULT_ADD_FORM);
    setIsOpen(false);
  });

  function set<K extends keyof AddFormState>(key: K, value: string) {
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
    marginValue == null ? 'text-[#94a3b8]' : marginValue < 0 ? 'text-red-400' : 'text-green-400';

  function handleCreate() {
    const prefix = form.prefix.trim();
    if (!prefix) { toastErr('Prefix is required'); return; }
    if (isNaN(sell)) { toastErr('Sell rate is required'); return; }
    if (isNaN(cost)) { toastErr('Cost rate is required'); return; }
    if (sell < 0) { toastErr('Sell rate must be non-negative'); return; }
    if (cost < 0) { toastErr('Cost rate must be non-negative'); return; }
    createMutation.mutate({
      prefix,
      description: form.description.trim() || null,
      rate_per_min: sell,
      cost_per_min: cost,
      connection_fee: parseFloat(form.connection_fee) || 0,
      increment: parseInt(form.increment, 10) || 6,
    });
  }

  function toggleOpen() {
    setIsOpen((o) => {
      if (o) setForm(DEFAULT_ADD_FORM);
      return !o;
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <GlassPanel padding="16px 22px">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontSize: '0.875rem', color: GLASS.textMuted, flex: 1 }}>
            Add a new rate prefix to the billing table.
          </span>
          <Button variant="primary" size="sm" onClick={toggleOpen} style={{ flexShrink: 0 }}>
            {isOpen ? '— Cancel' : '+ Add Rate'}
          </Button>
        </div>
      </GlassPanel>

      {isOpen && (
        <GlassPanel padding="24px 26px 22px">
          <div
            style={{
              fontSize: '0.62rem',
              fontWeight: 700,
              color: GLASS.accent,
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              marginBottom: 18,
            }}
          >
            New Rate
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <label style={labelStyle}>
                Prefix <span style={{ color: '#f87171', marginLeft: 2 }}>*</span>
              </label>
              <input style={glassInput()} placeholder="e.g. 1800" value={form.prefix} onChange={(e) => set('prefix', e.target.value)} onFocus={onFocus} onBlur={inputBlur} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column' }} className="lg:col-span-2">
              <label style={labelStyle}>Description</label>
              <input style={glassInput()} placeholder="e.g. US Toll-Free" value={form.description} onChange={(e) => set('description', e.target.value)} onFocus={onFocus} onBlur={inputBlur} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <label style={labelStyle}>
                Sell Rate / Min <span style={{ color: '#f87171', marginLeft: 2 }}>*</span>
              </label>
              <input style={glassInput()} type="number" step="0.0001" min="0" placeholder="0.0100" value={form.rate_per_min} onChange={(e) => set('rate_per_min', e.target.value)} onFocus={onFocus} onBlur={inputBlur} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <label style={labelStyle}>
                Cost Rate / Min <span style={{ color: '#f87171', marginLeft: 2 }}>*</span>
              </label>
              <input style={glassInput()} type="number" step="0.0001" min="0" placeholder="0.0060" value={form.cost_per_min} onChange={(e) => set('cost_per_min', e.target.value)} onFocus={onFocus} onBlur={inputBlur} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
              <label style={labelStyle}>Margin Preview</label>
              <div
                style={{
                  padding: '9px 12px',
                  fontSize: '0.88rem',
                  fontWeight: 600,
                  minHeight: 38,
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 10,
                }}
              >
                {marginValue != null ? (
                  <span className={cn(marginPreviewClass)}>
                    {marginValue >= 0 ? '+' : ''}${marginValue.toFixed(4)}{' '}
                    {marginPct != null && isFinite(marginPct) ? `(${marginPct.toFixed(1)}%)` : ''}
                  </span>
                ) : (
                  <span style={{ color: GLASS.textFaint }}>—</span>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <label style={labelStyle}>Connection Fee</label>
              <input style={glassInput()} type="number" step="0.001" min="0" value={form.connection_fee} onChange={(e) => set('connection_fee', e.target.value)} onFocus={onFocus} onBlur={inputBlur} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <label style={labelStyle}>Increment (s)</label>
              <input style={glassInput()} type="number" step="1" min="1" value={form.increment} onChange={(e) => set('increment', e.target.value)} onFocus={onFocus} onBlur={inputBlur} />
            </div>
          </div>

          <div
            style={{
              marginTop: 20,
              paddingTop: 20,
              borderTop: `1px solid ${hexToRgba(GLASS.accent, 0.12)}`,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <Button variant="primary" size="sm" loading={createMutation.isPending} onClick={handleCreate}>
              Create Rate
            </Button>
            <Button variant="ghost" size="sm" onClick={toggleOpen}>Cancel</Button>
          </div>
        </GlassPanel>
      )}
    </div>
  );
}
