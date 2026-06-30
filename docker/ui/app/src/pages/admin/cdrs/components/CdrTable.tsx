/**
 * CDR records table — glassified. Each row is clickable to expand a detail row.
 * Reuses the shared Table primitives inside a frosted GlassPanel.
 */

import { useState, useCallback } from 'react';
import { Badge } from '../../../../components/ui/Badge';
import { Table, Thead, Th, Td } from '../../../../components/ui/Table';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { cn } from '../../../../utils/cn';
import { fmt } from '../../../../utils/format';
import { CdrExpandedRow } from './CdrExpandedRow';
import { StateCard } from './states';
import { IconEmpty } from './icons';
import type { Cdr, ProductType } from '../../../../types/cdr';

const COLUMN_COUNT = 14;

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function fmtMoney4(val: number | null | undefined): string {
  if (val == null) return '--';
  return `$${val.toFixed(4)}`;
}

function fmtDurationSec(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function sbcBadge(sbcId: string | null | undefined) {
  if (!sbcId) return <span className="text-[0.78rem] text-[#475569]">--</span>;
  const variant = /2$/.test(sbcId) ? 'sbc2' : 'sbc1';
  const label = sbcId.replace(/^east-/, '');
  return <Badge variant={variant}>{label}</Badge>;
}

interface CdrTableProps {
  cdrs: Cdr[];
  customerNames?: Record<number, string>;
}

export function CdrTable({ cdrs, customerNames }: CdrTableProps) {
  const [expandedUuid, setExpandedUuid] = useState<string | null>(null);
  const [localRated, setLocalRated] = useState<Set<string>>(new Set());

  const toggleExpand = useCallback((uuid: string) => {
    setExpandedUuid((prev) => (prev === uuid ? null : uuid));
  }, []);

  const handleRated = useCallback((uuid: string) => {
    setLocalRated((prev) => new Set([...prev, uuid]));
  }, []);

  if (cdrs.length === 0) {
    return (
      <StateCard
        icon={<IconEmpty />}
        title="No records found"
        body="Adjust your filters and search again."
      />
    );
  }

  return (
    <GlassPanel padding={0}>
      <div style={{ overflowX: 'auto', borderRadius: 20 }}>
        <Table>
          <Thead>
            <tr>
              <Th>Time</Th>
              <Th>Dir</Th>
              <Th>From</Th>
              <Th>To</Th>
              <Th>Customer</Th>
              <Th>Product</Th>
              <Th>Duration</Th>
              <Th>Billed</Th>
              <Th>Cost</Th>
              <Th>Margin</Th>
              <Th>Hangup</Th>
              <Th>Carrier</Th>
              <Th>SBC</Th>
              <Th>Status</Th>
            </tr>
          </Thead>
          <tbody>
            {cdrs.map((cdr) => {
              const isExpanded = expandedUuid === cdr.uuid;
              const isRated = cdr.rated_at != null || localRated.has(cdr.uuid);
              const margin = cdr.margin ?? 0;
              const marginClass = margin >= 0 ? 'text-green-400' : 'text-red-400';
              const hangupOk = cdr.hangup_cause === 'NORMAL_CLEARING';

              return [
                <tr
                  key={cdr.uuid}
                  onClick={() => toggleExpand(cdr.uuid)}
                  style={{
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                    background: isExpanded ? 'rgba(59,130,246,0.10)' : 'transparent',
                  }}
                  onMouseEnter={(e) => {
                    if (!isExpanded) (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.03)';
                  }}
                  onMouseLeave={(e) => {
                    if (!isExpanded) (e.currentTarget as HTMLTableRowElement).style.background = 'transparent';
                  }}
                >
                  <Td>
                    <span className="font-mono text-[0.78rem] text-[#94a3b8] whitespace-nowrap">{fmtTime(cdr.start_time)}</span>
                  </Td>
                  <Td><Badge variant={cdr.direction}>{cdr.direction}</Badge></Td>
                  <Td>
                    <span className="text-[0.82rem] text-[#e2e8f0] whitespace-nowrap">{fmt(cdr.caller_id) || cdr.caller_id || '--'}</span>
                  </Td>
                  <Td>
                    <span className="text-[0.82rem] text-[#e2e8f0] whitespace-nowrap">{fmt(cdr.destination) || cdr.destination || '--'}</span>
                  </Td>
                  <Td>
                    <span className="text-[0.82rem] text-[#94a3b8]">{customerNames?.[cdr.customer_id] ?? `#${cdr.customer_id}`}</span>
                  </Td>
                  <Td><Badge variant={cdr.product_type as ProductType}>{cdr.product_type.toUpperCase()}</Badge></Td>
                  <Td>
                    <span className="tabular-nums text-[0.82rem] text-[#e2e8f0] whitespace-nowrap">{fmtDurationSec(cdr.duration_seconds)}</span>
                  </Td>
                  <Td>
                    <span className="tabular-nums text-[0.82rem] text-green-400">{fmtMoney4(cdr.total_cost)}</span>
                  </Td>
                  <Td>
                    <span className="tabular-nums text-[0.82rem] text-[#94a3b8]">
                      {cdr.carrier_cost != null && cdr.carrier_cost > 0 ? fmtMoney4(cdr.carrier_cost) : '--'}
                    </span>
                  </Td>
                  <Td>
                    <span className={cn('tabular-nums text-[0.82rem]', marginClass)}>{cdr.margin != null ? fmtMoney4(cdr.margin) : '--'}</span>
                  </Td>
                  <Td>
                    <span className={cn('text-[0.78rem] whitespace-nowrap', hangupOk ? 'text-green-400' : 'text-red-400')}>{cdr.hangup_cause || '--'}</span>
                  </Td>
                  <Td>
                    <span className="text-[0.78rem] text-[#94a3b8]">{cdr.carrier_used || '--'}</span>
                  </Td>
                  <Td>{sbcBadge(cdr.sbc_id)}</Td>
                  <Td>{isRated ? <Badge variant="pass">Rated</Badge> : <Badge variant="warn">Unrated</Badge>}</Td>
                </tr>,

                isExpanded && (
                  <CdrExpandedRow key={`${cdr.uuid}-expand`} cdr={cdr} colSpan={COLUMN_COUNT} onRated={handleRated} />
                ),
              ];
            })}
          </tbody>
        </Table>
      </div>
    </GlassPanel>
  );
}
