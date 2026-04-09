import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createRate } from '../../api/rates';
import { Button } from '../../components/ui/Button';
import { useToast } from '../../components/ui/Toast';
import { cn } from '../../utils/cn';

const controlBase = [
  'text-[0.88rem] px-3 py-[8px] rounded-lg w-full',
  'border border-[#2a2f45] bg-[#1e2130] text-[#e2e8f0]',
  'outline-none transition-[border-color,box-shadow] duration-150',
  'focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.28)]',
  'placeholder:text-[#718096]',
].join(' ');

const labelClass = 'text-[0.65rem] font-bold text-[#4a5568] uppercase tracking-[0.8px]';

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
    onSuccess: (_, ) => {
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
    <div className="mb-5">
      <Button variant="primary" size="sm" onClick={toggleOpen}>
        {isOpen ? '— Cancel' : '+ Add Rate'}
      </Button>

      {isOpen && (
        <div className="mt-4 bg-[#1a1d27] border border-[#2a2f45] rounded-xl p-5">
          <h3 className="text-[0.88rem] font-bold text-[#e2e8f0] mb-4">New Rate</h3>

          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Prefix */}
            <div className="flex flex-col gap-[5px]">
              <label className={labelClass}>
                Prefix <span className="text-red-400 ml-0.5">*</span>
              </label>
              <input
                className={controlBase}
                placeholder="e.g. 1800"
                value={form.prefix}
                onChange={(e) => set('prefix', e.target.value)}
              />
            </div>

            {/* Description */}
            <div className="flex flex-col gap-[5px] lg:col-span-2">
              <label className={labelClass}>Description</label>
              <input
                className={controlBase}
                placeholder="e.g. US Toll-Free"
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
              />
            </div>

            {/* Sell rate */}
            <div className="flex flex-col gap-[5px]">
              <label className={labelClass}>
                Sell Rate / Min <span className="text-red-400 ml-0.5">*</span>
              </label>
              <input
                className={controlBase}
                type="number"
                step="0.0001"
                min="0"
                placeholder="0.0100"
                value={form.rate_per_min}
                onChange={(e) => set('rate_per_min', e.target.value)}
              />
            </div>

            {/* Cost rate */}
            <div className="flex flex-col gap-[5px]">
              <label className={labelClass}>
                Cost Rate / Min <span className="text-red-400 ml-0.5">*</span>
              </label>
              <input
                className={controlBase}
                type="number"
                step="0.0001"
                min="0"
                placeholder="0.0060"
                value={form.cost_per_min}
                onChange={(e) => set('cost_per_min', e.target.value)}
              />
            </div>

            {/* Margin preview */}
            <div className="flex flex-col gap-[5px] justify-end">
              <label className={labelClass}>Margin Preview</label>
              <div className="py-[9px] px-3 text-[0.88rem] font-semibold min-h-[38px]">
                {marginValue != null ? (
                  <span className={cn(marginPreviewClass)}>
                    {marginValue >= 0 ? '+' : ''}${marginValue.toFixed(4)}{' '}
                    {marginPct != null && isFinite(marginPct)
                      ? `(${marginPct.toFixed(1)}%)`
                      : ''}
                  </span>
                ) : (
                  <span className="text-[#718096]">—</span>
                )}
              </div>
            </div>

            {/* Connection fee */}
            <div className="flex flex-col gap-[5px]">
              <label className={labelClass}>Connection Fee</label>
              <input
                className={controlBase}
                type="number"
                step="0.001"
                min="0"
                value={form.connection_fee}
                onChange={(e) => set('connection_fee', e.target.value)}
              />
            </div>

            {/* Increment */}
            <div className="flex flex-col gap-[5px]">
              <label className={labelClass}>Increment (s)</label>
              <input
                className={controlBase}
                type="number"
                step="1"
                min="1"
                value={form.increment}
                onChange={(e) => set('increment', e.target.value)}
              />
            </div>
          </div>

          <div className="mt-5 flex items-center gap-3">
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
