import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { rateCdr } from '../../api/cdrs';
import { Button } from '../../components/ui/Button';
import { useToast } from '../../components/ui/Toast';
import type { Cdr } from '../../types/cdr';

function fmtDateFull(iso: string | null | undefined): string {
  if (!iso) return '--';
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

interface DetailItemProps {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}

function DetailItem({ label, value, mono }: DetailItemProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[0.65rem] font-bold uppercase tracking-[0.7px] text-[#718096]">
        {label}
      </span>
      <span
        className={
          'text-[0.82rem] text-[#e2e8f0] break-all' + (mono ? ' font-mono' : '')
        }
      >
        {value}
      </span>
    </div>
  );
}

interface CdrExpandedRowProps {
  cdr: Cdr;
  colSpan: number;
  /** Called after a successful rate action so the parent can update local state. */
  onRated: (uuid: string) => void;
}

export function CdrExpandedRow({ cdr, colSpan, onRated }: CdrExpandedRowProps) {
  const { toastOk, toastErr } = useToast();
  const queryClient = useQueryClient();
  const [isRating, setIsRating] = useState(false);

  const rateMutation = useMutation({
    mutationFn: () => rateCdr(cdr.uuid),
    onMutate: () => setIsRating(true),
    onSuccess: () => {
      toastOk('CDR rated successfully');
      onRated(cdr.uuid);
      void queryClient.invalidateQueries({ queryKey: ['cdrs'] });
    },
    onError: (err: Error) => {
      toastErr(`Rating failed: ${err.message}`);
    },
    onSettled: () => setIsRating(false),
  });

  return (
    <tr>
      <td
        colSpan={colSpan}
        style={{
          background: 'rgba(15,17,23,0.85)',
          borderBottom: '1px solid rgba(42,47,69,0.4)',
          padding: '16px 24px',
        }}
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-3">
          {/* UUID spans full width */}
          <div className="col-span-2 sm:col-span-3 lg:col-span-4">
            <DetailItem label="UUID" value={cdr.uuid} mono />
          </div>

          <DetailItem label="Start Time" value={fmtDateFull(cdr.start_time)} />
          <DetailItem label="Answer Time" value={fmtDateFull(cdr.answer_time)} />
          <DetailItem label="End Time" value={fmtDateFull(cdr.end_time)} />
          <DetailItem
            label="Duration"
            value={cdr.duration_seconds != null ? `${cdr.duration_seconds}s` : '--'}
          />
          <DetailItem
            label="Billable"
            value={cdr.billable_seconds != null ? `${cdr.billable_seconds}s` : '--'}
          />
          <DetailItem
            label="Rate / Min"
            value={
              cdr.rate_per_min != null ? `$${cdr.rate_per_min.toFixed(4)}/min` : '--'
            }
          />
          <DetailItem
            label="SIP Code"
            value={cdr.sip_code != null ? String(cdr.sip_code) : '--'}
          />
          <DetailItem
            label="Traffic Grade"
            value={cdr.traffic_grade ?? '--'}
          />
          <DetailItem
            label="Fraud Score"
            value={cdr.fraud_score != null ? String(cdr.fraud_score) : '--'}
          />
        </div>

        {!cdr.rated_at && (
          <div className="mt-4 pt-3 border-t border-[#2a2f45]/50">
            <Button
              variant="success"
              size="sm"
              loading={isRating}
              onClick={() => rateMutation.mutate()}
            >
              Rate CDR
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}
