/**
 * RoutePreview — the transparency tool: enter a destination (+ optional customer
 * policy) and see the exact cheapest-first carrier ordering the call path would
 * use, plus the `X-LCO-Route` header FreeSWITCH stamps. This is the same decision
 * the origination path makes, surfaced for verification.
 *
 * Owns the draft/committed query state; all hooks sit at the top (React #310).
 */

import { useState } from 'react';
import { Route, Search, Award } from 'lucide-react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { fmtRate } from '../../../../utils/format';
import type { Carrier } from '../../../../types/carrier';
import { useLcoRoute } from '../hooks';
import {
  sectionTitle,
  sectionSubtitle,
  primaryBtn,
  searchWrap,
  searchInput,
  selectStyle,
  routeHop,
  rankBadge,
  codeBlock,
  groupLabel,
  MONO,
} from '../styles';
import { LoadingRow, StateCard } from './states';

interface CustomerOption {
  id: number;
  name: string;
}

interface RoutePreviewProps {
  customers: CustomerOption[];
  carriers: Carrier[];
}

export function RoutePreview({ customers, carriers }: RoutePreviewProps) {
  const [destinationDraft, setDestinationDraft] = useState('');
  const [customerDraft, setCustomerDraft] = useState('');
  const [committed, setCommitted] = useState<{ destination: string; customerId: number | undefined } | null>(null);
  const [focused, setFocused] = useState(false);
  const [hover, setHover] = useState(false);

  const { data, isFetching, isError } = useLcoRoute(
    committed?.destination ?? '',
    committed?.customerId,
    committed !== null,
  );

  const carrierName = (id: number): string => {
    const c = carriers.find((x) => x.id === id);
    return c ? c.display_name || c.gateway_name : `Carrier #${id}`;
  };

  const submit = () => {
    if (!destinationDraft.trim()) return;
    setCommitted({ destination: destinationDraft.trim(), customerId: customerDraft ? Number(customerDraft) : undefined });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <GlassPanel padding="20px 24px">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <Route size={17} style={{ color: GLASS.accent }} />
          <h2 style={sectionTitle}>Route Preview</h2>
        </div>
        <p style={{ ...sectionSubtitle, marginBottom: 16 }}>
          See the cheapest-first carrier ordering for a destination — the exact decision the call path makes.
        </p>

        <form
          style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div style={searchWrap(focused)}>
            <Search size={15} color={focused ? GLASS.accent : GLASS.textFaint} style={{ flexShrink: 0 }} />
            <input
              type="text"
              value={destinationDraft}
              onChange={(e) => setDestinationDraft(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="Destination — +15551234567 or digits"
              style={searchInput}
            />
          </div>
          <select value={customerDraft} onChange={(e) => setCustomerDraft(e.target.value)} style={selectStyle(Boolean(customerDraft))} aria-label="Apply customer policy">
            <option value="">No customer policy</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <button type="submit" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={primaryBtn(hover)}>
            <Route size={14} />
            Preview route
          </button>
        </form>
      </GlassPanel>

      {isFetching && <LoadingRow label="Computing least-cost route…" />}

      {isError && (
        <StateCard accent={GLASS.danger} icon={<Route size={26} />} title="Route preview failed" body="Could not compute a route for that destination." />
      )}

      {data && !isFetching && (
        <GlassPanel padding="20px 24px">
          <div style={groupLabel()}>
            Cheapest-first path for {data.destination}
            {data.customer_id != null ? ` · customer #${data.customer_id} policy applied` : ''}
          </div>

          {data.routes.length === 0 ? (
            <div style={{ fontSize: '0.85rem', color: GLASS.textMuted, padding: '8px 0' }}>
              No eligible carrier route — no rate deck matches this destination (or policy denies every carrier).
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {data.routes.map((hop, i) => (
                <div key={`${hop.carrier_id}-${i}`} style={routeHop(i)}>
                  <div style={rankBadge(i)}>{i + 1}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: '0.9rem', fontWeight: 700, color: GLASS.text }}>{carrierName(hop.carrier_id)}</span>
                      {i === 0 && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.6rem', fontWeight: 800, color: GLASS.success, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          <Award size={11} /> Cheapest
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: GLASS.textMuted, marginTop: 3 }}>
                      {hop.x_carrier_value ? `X-Carrier ${hop.x_carrier_value}` : 'X-Carrier —'}
                      {hop.pop_ip ? ` · ${hop.pop_ip}` : ''}
                      {hop.prefix ? ` · matched prefix ${hop.prefix}` : ''}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontFamily: MONO, fontSize: '0.9rem', fontWeight: 700, color: GLASS.success }}>
                      {hop.cost_per_min != null ? fmtRate(hop.cost_per_min) : '—'}
                    </div>
                    <div style={{ fontSize: '0.64rem', color: GLASS.textFaint, marginTop: 2 }}>priority {hop.priority ?? '—'}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {data.x_lco_route && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: '0.66rem', fontWeight: 700, color: GLASS.textFaint, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                X-LCO-Route header
              </div>
              <pre style={codeBlock()}>{data.x_lco_route}</pre>
            </div>
          )}
        </GlassPanel>
      )}
    </div>
  );
}
