/**
 * SavingsTab — the transparent-savings differentiator. Pick a period (+ optional
 * customer), then see $ saved vs the most-expensive-carrier baseline, a
 * baseline-vs-actual chart, a per-prefix breakdown, and a one-click billing-feed
 * CSV export for the same window.
 *
 * Owns the draft/committed window state; all hooks sit at the top (React #310),
 * and the savings query is `enabled`-guarded until the user generates a report.
 */

import { useState } from 'react';
import { TrendingDown, Download, DollarSign, BarChart3 } from 'lucide-react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { Button } from '../../../../components/ui/Button';
import { FormField } from '../../../../components/ui/FormField';
import { GLASS } from '../../../../components/glass/glass';
import { fmtMoney, fmtRate } from '../../../../utils/format';
import { useSavings, useBillingExport } from '../hooks';
import { defaultReportWindow } from '../types';
import {
  sectionTitle,
  sectionSubtitle,
  primaryBtn,
  summaryTile,
  summaryValue,
  summaryLabel,
  tableWrap,
  table,
  th,
  td,
  prefixCell,
  noteBox,
  dash,
} from '../styles';
import { SavingsChart } from './SavingsChart';
import { LoadingRow, StateCard } from './states';

interface CustomerOption {
  id: number;
  name: string;
}

interface Committed {
  startIso: string;
  endIso: string;
  customerId: number | undefined;
}

export function SavingsTab({ customers }: { customers: CustomerOption[] }) {
  const initial = defaultReportWindow();
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [customerId, setCustomerId] = useState('');
  const [committed, setCommitted] = useState<Committed | null>(null);
  const [hover, setHover] = useState(false);

  const { data, isFetching, isError } = useSavings(
    committed?.startIso ?? '',
    committed?.endIso ?? '',
    committed?.customerId,
    committed !== null,
  );
  const { download, isExporting } = useBillingExport();

  const generate = () => {
    if (!start || !end) return;
    setCommitted({
      startIso: new Date(start).toISOString(),
      endIso: new Date(end).toISOString(),
      customerId: customerId ? Number(customerId) : undefined,
    });
  };

  const positive = (data?.savings ?? 0) >= 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <GlassPanel padding="20px 24px">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <TrendingDown size={17} style={{ color: GLASS.accent }} />
          <h2 style={sectionTitle}>Savings Report</h2>
        </div>
        <p style={{ ...sectionSubtitle, marginBottom: 16 }}>
          Transparent $ saved vs the most-expensive-carrier baseline, with a downloadable billing feed.
        </p>

        <form
          style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'end' }}
          onSubmit={(e) => {
            e.preventDefault();
            generate();
          }}
        >
          <FormField label="From" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          <FormField label="To" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          <FormField as="select" label="Customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">All customers</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </FormField>
          <button type="submit" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={primaryBtn(hover)}>
            <BarChart3 size={14} />
            Generate
          </button>
          <Button
            variant="ghost"
            icon={<Download size={14} />}
            onClick={() => committed && download(committed.startIso, committed.endIso, committed.customerId)}
            loading={isExporting}
            disabled={!committed}
          >
            Export billing CSV
          </Button>
        </form>
      </GlassPanel>

      {committed === null ? (
        <StateCard icon={<TrendingDown size={26} />} title="Generate a savings report" body="Pick a period and generate to see transparent savings vs baseline carrier cost." />
      ) : isFetching ? (
        <LoadingRow label="Computing savings…" />
      ) : isError ? (
        <StateCard accent={GLASS.danger} icon={<DollarSign size={26} />} title="Couldn't compute savings" body="The request failed. Adjust the window and try again." />
      ) : data ? (
        <>
          {/* Summary tiles */}
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <div style={summaryTile(positive ? GLASS.success : GLASS.danger)}>
              <div style={{ ...summaryValue, color: positive ? GLASS.success : GLASS.danger }}>{fmtMoney(data.savings, 2)}</div>
              <div style={summaryLabel}>Total saved</div>
            </div>
            <div style={summaryTile(GLASS.accent)}>
              <div style={{ ...summaryValue, color: GLASS.accent }}>{data.savings_pct.toFixed(1)}%</div>
              <div style={summaryLabel}>vs baseline</div>
            </div>
            <div style={summaryTile(GLASS.textMuted)}>
              <div style={{ ...summaryValue, color: GLASS.text }}>{fmtMoney(data.actual_cost, 2)}</div>
              <div style={summaryLabel}>Actual cost</div>
            </div>
            <div style={summaryTile(GLASS.textMuted)}>
              <div style={{ ...summaryValue, color: GLASS.textMuted }}>{fmtMoney(data.baseline_cost, 2)}</div>
              <div style={summaryLabel}>Baseline cost</div>
            </div>
            <div style={summaryTile(GLASS.textMuted)}>
              <div style={{ ...summaryValue, color: GLASS.text }}>{data.total_calls.toLocaleString()}</div>
              <div style={summaryLabel}>Calls</div>
            </div>
          </div>

          <SavingsChart prefixes={data.prefixes} />

          {/* Breakdown table */}
          <GlassPanel padding={0}>
            <div style={tableWrap}>
              <table style={table}>
                <thead>
                  <tr>
                    <th style={th()}>Prefix</th>
                    <th style={th(true)}>Calls</th>
                    <th style={th(true)}>Billable min</th>
                    <th style={th(true)}>Baseline rate</th>
                    <th style={th(true)}>Baseline cost</th>
                    <th style={th(true)}>Actual cost</th>
                    <th style={th(true)}>Saved</th>
                  </tr>
                </thead>
                <tbody>
                  {data.prefixes.length === 0 ? (
                    <tr>
                      <td style={td({ muted: true })} colSpan={7}>No rated outbound activity in this window.</td>
                    </tr>
                  ) : (
                    data.prefixes.map((p) => (
                      <tr key={p.prefix}>
                        <td style={td()}><span style={prefixCell}>{p.prefix}</span></td>
                        <td style={td({ right: true, muted: true })}>{p.calls.toLocaleString()}</td>
                        <td style={td({ right: true, muted: true })}>{p.billable_min.toLocaleString()}</td>
                        <td style={td({ right: true, muted: true })}>{p.baseline_rate != null ? fmtRate(p.baseline_rate) : <span style={dash}>—</span>}</td>
                        <td style={td({ right: true, muted: true })}>{fmtMoney(p.baseline_cost, 4)}</td>
                        <td style={td({ right: true })}>{fmtMoney(p.actual_cost, 4)}</td>
                        <td style={td({ right: true })}>
                          <span style={{ color: p.savings >= 0 ? GLASS.success : GLASS.danger, fontWeight: 700 }}>{fmtMoney(p.savings, 4)}</span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </GlassPanel>

          <div style={noteBox}>{data.note}</div>
        </>
      ) : null}
    </div>
  );
}
