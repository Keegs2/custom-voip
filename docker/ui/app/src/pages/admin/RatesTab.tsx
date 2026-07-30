import { TableWrap, Table, Thead, Th, Td } from '../../components/ui/Table';
import { Badge } from '../../components/ui/Badge';
import { cn } from '../../utils/cn';

/* ════════════════════════════════════════════════════════════════════════
 *  EXAMPLE / PLACEHOLDER RATING DATA
 *
 *  Everything in this block is ILLUSTRATIVE. Live rates will be sourced from
 *  the LCR (Least-Cost Routing) engine — for now these typed constants stand
 *  in so the layout is real and the swap is trivial:
 *
 *    - Replace EXAMPLE_CARRIERS  → GET /rates/carriers (or the LCR engine's
 *      carrier roster).
 *    - Replace EXAMPLE_LD_RATES  → the engine's interstate / long-distance
 *      rate matrix (one $/min per carrier per destination).
 *    - Replace EXAMPLE_TF_RATES  → the engine's toll-free inbound rate matrix.
 *
 *  The row/column shapes below are exactly what a real API response should
 *  normalise to, so a future `useQuery(...)` can drop straight into the same
 *  <LcrRateTable> render path with no structural change.
 * ════════════════════════════════════════════════════════════════════════ */

/** A wholesale carrier the LCR engine can route to. `id` keys the per-row rate maps. */
interface ExampleCarrier {
  id: string;
  name: string;
}

/** One rating row: a destination + a $/min quote from each carrier (keyed by carrier id). */
interface ExampleRateRow {
  /** Human-readable destination / rating class, e.g. "United States — Interstate". */
  destination: string;
  /** Dial prefix or rating key shown next to the destination, e.g. "1", "1NPA", "44". */
  prefix: string;
  /** carrierId → rate per minute (USD). A missing key renders as "not offered". */
  rates: Record<string, number>;
}

/** Example wholesale carriers — real US wholesale names, used purely as illustration. */
const EXAMPLE_CARRIERS: readonly ExampleCarrier[] = [
  { id: 'bandwidth',   name: 'Bandwidth' },
  { id: 'telnyx',      name: 'Telnyx' },
  { id: 'inteliquent', name: 'Inteliquent' },
  { id: 'peerless',    name: 'Peerless' },
] as const;

/** Example interstate / long-distance rate matrix (outbound termination, $/min). */
const EXAMPLE_LD_RATES: readonly ExampleRateRow[] = [
  {
    destination: 'United States — Interstate',
    prefix: '1',
    rates: { bandwidth: 0.0042, telnyx: 0.0039, inteliquent: 0.0045, peerless: 0.0051 },
  },
  {
    destination: 'United States — Intrastate',
    prefix: '1NPA',
    rates: { bandwidth: 0.0068, telnyx: 0.0072, inteliquent: 0.0061, peerless: 0.0079 },
  },
  {
    destination: 'United States — Alaska',
    prefix: '1907',
    rates: { bandwidth: 0.0121, telnyx: 0.0134, inteliquent: 0.0118, peerless: 0.0129 },
  },
  {
    destination: 'United States — Hawaii',
    prefix: '1808',
    rates: { bandwidth: 0.0058, telnyx: 0.0054, inteliquent: 0.0063, peerless: 0.0061 },
  },
  {
    destination: 'Canada',
    prefix: '1',
    rates: { bandwidth: 0.0049, telnyx: 0.0046, inteliquent: 0.0052, peerless: 0.0057 },
  },
  {
    destination: 'United Kingdom — Fixed',
    prefix: '44',
    rates: { bandwidth: 0.0072, telnyx: 0.0069, inteliquent: 0.0081, peerless: 0.0076 },
  },
  {
    destination: 'United Kingdom — Mobile',
    prefix: '447',
    rates: { bandwidth: 0.0189, telnyx: 0.0176, inteliquent: 0.0201, peerless: 0.0184 },
  },
  {
    destination: 'Mexico — Fixed',
    prefix: '52',
    rates: { bandwidth: 0.0094, telnyx: 0.0088, inteliquent: 0.0102, peerless: 0.0097 },
  },
  {
    destination: 'Mexico — Mobile',
    prefix: '521',
    rates: { bandwidth: 0.0156, telnyx: 0.0149, inteliquent: 0.0163, peerless: 0.0171 },
  },
  {
    destination: 'Germany — Fixed',
    prefix: '49',
    rates: { bandwidth: 0.0067, telnyx: 0.0071, inteliquent: 0.0064, peerless: 0.0073 },
  },
  {
    destination: 'India — Fixed',
    prefix: '91',
    rates: { bandwidth: 0.0112, telnyx: 0.0108, inteliquent: 0.0119, peerless: 0.0104 },
  },
  {
    destination: 'Australia — Fixed',
    prefix: '61',
    rates: { bandwidth: 0.0083, telnyx: 0.0079, inteliquent: 0.0088, peerless: 0.0091 },
  },
] as const;

/**
 * Example toll-free INBOUND rate matrix ($/min).
 *
 * Toll-free is billed to the number's owner for INBOUND minutes and is rated
 * by origination type (interstate / intrastate / intra-LATA), plus jurisdictional
 * and payphone surcharges — so it is a fundamentally different rate deck from the
 * outbound long-distance table above. Values here run a little higher than LD,
 * matching real toll-free economics.
 */
const EXAMPLE_TF_RATES: readonly ExampleRateRow[] = [
  {
    destination: 'Interstate',
    prefix: 'TF-IXC',
    rates: { bandwidth: 0.0092, telnyx: 0.0088, inteliquent: 0.0097, peerless: 0.0101 },
  },
  {
    destination: 'Intrastate',
    prefix: 'TF-INTRA',
    rates: { bandwidth: 0.0138, telnyx: 0.0145, inteliquent: 0.0129, peerless: 0.0151 },
  },
  {
    destination: 'Intra-LATA',
    prefix: 'TF-LATA',
    rates: { bandwidth: 0.0116, telnyx: 0.0121, inteliquent: 0.0109, peerless: 0.0124 },
  },
  {
    destination: 'Alaska',
    prefix: 'TF-907',
    rates: { bandwidth: 0.0224, telnyx: 0.0239, inteliquent: 0.0218, peerless: 0.0231 },
  },
  {
    destination: 'Payphone surcharge',
    prefix: 'TF-PAY',
    // Per-call surcharge shown here as a $/call figure for illustration.
    rates: { bandwidth: 0.0300, telnyx: 0.0300, inteliquent: 0.0295, peerless: 0.0310 },
  },
] as const;

/* ════════════════════════════════════════════════════════════════════════
 *  Helpers
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Returns the id of the cheapest carrier for a row (the LCR winner), or `null`
 * if the row quotes no carriers. Ties resolve to the first-listed carrier.
 */
function cheapestCarrierId(
  row: ExampleRateRow,
  carriers: readonly ExampleCarrier[],
): string | null {
  let winnerId: string | null = null;
  let lowest = Number.POSITIVE_INFINITY;
  for (const carrier of carriers) {
    const rate = row.rates[carrier.id];
    if (rate == null) continue;
    if (rate < lowest) {
      lowest = rate;
      winnerId = carrier.id;
    }
  }
  return winnerId;
}

/** Formats a $/min value with 4 decimals, e.g. `$0.0042`. */
function fmtRate4(val: number | null | undefined): string {
  if (val == null) return '—';
  return `$${val.toFixed(4)}`;
}

/* ════════════════════════════════════════════════════════════════════════
 *  Reusable LCR rate table
 * ════════════════════════════════════════════════════════════════════════ */

interface LcrRateTableProps {
  carriers: readonly ExampleCarrier[];
  rows: readonly ExampleRateRow[];
  /** Header for the first (description) column, e.g. "Destination" or "Origination". */
  destinationLabel: string;
}

/**
 * Renders a rate matrix as destination rows × carrier columns. The cheapest
 * carrier per row is highlighted with the blue brand accent and an "LCR" badge,
 * making the least-cost route scannable at a glance.
 */
function LcrRateTable({ carriers, rows, destinationLabel }: LcrRateTableProps) {
  return (
    <TableWrap>
      <Table>
        <Thead>
          <tr>
            <Th>{destinationLabel}</Th>
            <Th>Prefix</Th>
            {carriers.map((carrier) => (
              <Th key={carrier.id} className="!text-right">
                {carrier.name}
              </Th>
            ))}
          </tr>
        </Thead>
        <tbody>
          {rows.map((row) => {
            const winnerId = cheapestCarrierId(row, carriers);
            return (
              <tr key={`${row.destination}::${row.prefix}`} className="glass-row-hover">
                <Td>
                  <span className="font-medium text-[#e2e8f0]">{row.destination}</span>
                </Td>
                <Td>
                  <span className="font-mono tabular-nums text-[0.8rem] text-[#94a3b8]">
                    {row.prefix}
                  </span>
                </Td>
                {carriers.map((carrier) => {
                  const rate = row.rates[carrier.id];
                  const isWinner = carrier.id === winnerId && rate != null;
                  return (
                    <Td key={carrier.id} className="!text-right">
                      {rate == null ? (
                        <span className="text-[#475569] text-[0.82rem]">—</span>
                      ) : (
                        <span
                          className={cn(
                            'inline-flex items-center justify-end gap-2 font-mono tabular-nums text-[0.82rem] whitespace-nowrap',
                            isWinner ? 'font-semibold text-blue-300' : 'text-[#cbd5e0]',
                          )}
                        >
                          {isWinner && (
                            <Badge
                              variant="rcf"
                              className="!min-w-0 !px-1.5 !py-0.5 !text-[0.55rem] !tracking-[0.08em]"
                            >
                              LCR
                            </Badge>
                          )}
                          {fmtRate4(rate)}
                        </span>
                      )}
                    </Td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </Table>
    </TableWrap>
  );
}

/* ════════════════════════════════════════════════════════════════════════
 *  Section header
 * ════════════════════════════════════════════════════════════════════════ */

interface SectionHeaderProps {
  eyebrow: string;
  title: string;
  description: string;
}

function SectionHeader({ eyebrow, title, description }: SectionHeaderProps) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          fontSize: '0.6rem',
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: '#3b82f6',
          opacity: 0.85,
          marginBottom: 6,
        }}
      >
        {eyebrow}
      </div>
      <h2
        style={{
          fontSize: '1.05rem',
          fontWeight: 700,
          color: '#e2e8f0',
          letterSpacing: '-0.015em',
          margin: '0 0 4px',
        }}
      >
        {title}
      </h2>
      <p style={{ fontSize: '0.82rem', color: '#718096', lineHeight: 1.6, margin: 0, maxWidth: 640 }}>
        {description}
      </p>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
 *  Rates view — LCR comparison + toll-free (read-only, example data)
 * ════════════════════════════════════════════════════════════════════════ */

export function RatesTab() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      {/* ── Page intro ── */}
      <div>
        <h1
          style={{
            fontSize: '1.35rem',
            fontWeight: 800,
            color: '#e2e8f0',
            letterSpacing: '-0.02em',
            margin: '0 0 6px',
          }}
        >
          Rate Decks &amp; Least-Cost Routing
        </h1>
        <p style={{ fontSize: '0.88rem', color: '#718096', lineHeight: 1.6, margin: 0, maxWidth: 680 }}>
          Side-by-side wholesale termination rates across carriers, with the least-cost route
          highlighted per destination. Toll-free inbound is rated separately below.
        </p>
      </div>

      {/* ── Example-data banner (muted, glass, blue-accented) ── */}
      <div
        className="glass-surface"
        role="note"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          borderRadius: 12,
          padding: '13px 18px',
          borderLeft: '3px solid rgba(59,130,246,0.55)',
        }}
      >
        <span
          aria-hidden
          style={{
            flexShrink: 0,
            width: 22,
            height: 22,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(59,130,246,0.14)',
            color: '#93c5fd',
            fontSize: '0.72rem',
            fontWeight: 800,
            fontFamily: 'Georgia, serif',
            fontStyle: 'italic',
          }}
        >
          i
        </span>
        <p style={{ margin: 0, fontSize: '0.82rem', color: '#94a3b8', lineHeight: 1.55 }}>
          <strong style={{ color: '#cbd5e0', fontWeight: 700 }}>Example data.</strong>{' '}
          These rates are illustrative placeholders. Live pricing will be sourced from the
          LCR engine — carriers, destinations, and per-minute rates below are representative
          only.
        </p>
      </div>

      {/* ── Interstate / long-distance LCR comparison ── */}
      <section>
        <SectionHeader
          eyebrow="Outbound Termination"
          title="Interstate &amp; Long-Distance Rates"
          description="Per-minute termination cost by destination across wholesale carriers. The cheapest
            carrier for each destination is the LCR winner, highlighted in blue."
        />
        <LcrRateTable
          carriers={EXAMPLE_CARRIERS}
          rows={EXAMPLE_LD_RATES}
          destinationLabel="Destination"
        />
      </section>

      {/* ── Toll-free inbound (separate rate deck) ── */}
      <section>
        <SectionHeader
          eyebrow="Toll-Free Inbound"
          title="Toll-Free Rates"
          description="Inbound toll-free minutes are billed to the number's owner and rated by origination
            type, with jurisdictional and payphone surcharges. This is a separate rate deck from
            outbound long-distance — cheapest carrier per class is highlighted."
        />
        <LcrRateTable
          carriers={EXAMPLE_CARRIERS}
          rows={EXAMPLE_TF_RATES}
          destinationLabel="Origination"
        />
      </section>
    </div>
  );
}
