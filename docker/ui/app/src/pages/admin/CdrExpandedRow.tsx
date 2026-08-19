/**
 * CdrExpandedRow — inline per-call detail under an expanded CDR table row.
 *
 * Styling: the shared DAYLIGHT CONSOLE system — the detail renders inside the
 * `dlx-xwrap`/`dlx-xpanel` expand idiom (dl-admin.css) with `dlx-info-grid`
 * label/value pairs and `dlx4-*` section heads. The shared STIR/SHAKEN
 * `AttestationChain` and the rate mutation are unchanged.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { rateCdr } from '../../api/cdrs';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../components/ui/Toast';
import { AttestationChain } from '../../components/stir/AttestationChain';
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
  /** Span the full info-grid width (UUID, user agent). */
  wide?: boolean;
}

function DetailItem({ label, value, mono, wide }: DetailItemProps) {
  return (
    <div style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <span className="dlx-ilabel">{label}</span>
      <span
        className={mono ? 'dlx-ivalue dlx4-mono' : 'dlx-ivalue'}
        style={mono ? { fontSize: '0.78rem' } : undefined}
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
  const { isAdmin } = useAuth();
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
      <td colSpan={colSpan} style={{ padding: 0 }}>
        <div className="dlx-xwrap">
          <div>
            <div className="dlx-xpanel">
              <div className="dlx-info-grid">
                <DetailItem label="UUID" value={cdr.uuid} mono wide />

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
                <DetailItem label="Traffic Grade" value={cdr.traffic_grade ?? '--'} />
                <DetailItem
                  label="Fraud Score"
                  value={cdr.fraud_score != null ? String(cdr.fraud_score) : '--'}
                />
              </div>

              {/* SIP Details */}
              {(cdr.sbc_id || cdr.sip_from_user || cdr.sip_to_user || cdr.sip_user_agent || cdr.network_addr) && (
                <div className="dlx4-xsection">
                  <p className="dlx4-subhead">SIP Details</p>
                  <div className="dlx-info-grid">
                    {cdr.sbc_id && <DetailItem label="SBC" value={cdr.sbc_id} mono />}
                    {cdr.network_addr && (
                      <DetailItem label="Network Addr" value={cdr.network_addr} mono />
                    )}
                    {cdr.sip_from_user && (
                      <DetailItem label="SIP From" value={cdr.sip_from_user} mono />
                    )}
                    {cdr.sip_to_user && (
                      <DetailItem label="SIP To" value={cdr.sip_to_user} mono />
                    )}
                    {cdr.sip_user_agent && (
                      <DetailItem label="User Agent" value={cdr.sip_user_agent} mono wide />
                    )}
                  </div>
                </div>
              )}

              {/* STIR/SHAKEN attestation chain */}
              <div className="dlx4-xsection">
                <p className="dlx4-subhead">STIR / SHAKEN</p>
                <AttestationChain callId={cdr.uuid} />
              </div>

              {/* Rating is a write — admin only. Support (platform read) would
                  get a 403 from the API, so the button is hidden entirely. */}
              {isAdmin && !cdr.rated_at && (
                <div className="dlx4-xsection">
                  <button
                    type="button"
                    className="dl-btn dlx-btn-ok"
                    disabled={isRating}
                    onClick={(e) => {
                      e.stopPropagation();
                      rateMutation.mutate();
                    }}
                  >
                    {isRating ? 'Rating…' : 'Rate CDR'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
}
