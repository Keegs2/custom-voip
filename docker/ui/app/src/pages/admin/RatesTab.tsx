/**
 * RatesTab — rate decks + least-cost-routing comparison (/admin/platform/rates).
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css, plus the
 * admin `dlx-*` layer in styles/dl-admin.css and the platform-scoped `dlx2-*`
 * layer in styles/dl-platform.css). Renders INSIDE the PlatformManagementPage
 * shell, which owns the paper canvas (`dl-scope`) — this page contributes
 * only the intro, the example-data note, and the rate-deck table panels.
 */
import '../../styles/dl-admin.css';
import '../../styles/dl-platform.css';

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

const MONO_FONT = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

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
 * carrier per row is highlighted with the azure accent and an "LCR" tag,
 * making the least-cost route scannable at a glance.
 */
function LcrRateTable({ carriers, rows, destinationLabel }: LcrRateTableProps) {
  return (
    <section className="dl-panel">
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
          <thead>
            <tr>
              <th className="dl-th">{destinationLabel}</th>
              <th className="dl-th">Prefix</th>
              {carriers.map((carrier) => (
                <th key={carrier.id} className="dl-th" style={{ textAlign: 'right' }}>
                  {carrier.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const winnerId = cheapestCarrierId(row, carriers);
              return (
                <tr key={`${row.destination}::${row.prefix}`} className="dl-row">
                  <td className="dlx-td" style={{ color: 'var(--rcf-ink)', fontWeight: 600 }}>
                    {row.destination}
                  </td>
                  <td
                    className="dlx-td"
                    style={{
                      fontFamily: MONO_FONT,
                      fontSize: '0.76rem',
                      color: 'var(--rcf-ink-dim)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {row.prefix}
                  </td>
                  {carriers.map((carrier) => {
                    const rate = row.rates[carrier.id];
                    const isWinner = carrier.id === winnerId && rate != null;
                    return (
                      <td key={carrier.id} className="dlx-td" style={{ textAlign: 'right' }}>
                        {rate == null ? (
                          <span style={{ color: 'var(--rcf-ink-dim)' }}>—</span>
                        ) : (
                          <span
                            className={isWinner ? 'dlx2-lcr-win' : undefined}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'flex-end',
                              gap: 8,
                              fontFamily: MONO_FONT,
                              fontSize: '0.78rem',
                              fontVariantNumeric: 'tabular-nums',
                              whiteSpace: 'nowrap',
                              ...(isWinner ? {} : { color: 'var(--rcf-ink-soft)' }),
                            }}
                          >
                            {isWinner && <span className="dl-tag">LCR</span>}
                            {fmtRate4(rate)}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
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
    <div className="dlx2-secintro">
      <span className="dl-tag">{eyebrow}</span>
      <h2 className="dlx2-secintro-title">{title}</h2>
      <p className="dlx2-secintro-sub">{description}</p>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
 *  Rates view — LCR comparison + toll-free (read-only, example data)
 * ════════════════════════════════════════════════════════════════════════ */

export function RatesTab() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      {/* ── Page intro ── */}
      <div>
        <h2
          style={{
            fontFamily: '"Archivo", "IBM Plex Sans", sans-serif',
            fontSize: '1.1rem',
            fontWeight: 700,
            letterSpacing: '-0.018em',
            color: 'var(--rcf-ink)',
            margin: '0 0 5px',
          }}
        >
          Rate Decks &amp; Least-Cost Routing
        </h2>
        <p style={{ fontSize: '0.84rem', color: 'var(--rcf-ink-soft)', lineHeight: 1.55, margin: 0, maxWidth: '72ch' }}>
          Side-by-side wholesale termination rates across carriers, with the least-cost route
          highlighted per destination. Toll-free inbound is rated separately below.
        </p>
      </div>

      {/* ── Example-data note ── */}
      <div className="dl-note" role="note">
        <span>
          <strong style={{ color: 'var(--rcf-ink)', fontWeight: 700 }}>Example data.</strong>{' '}
          These rates are illustrative placeholders. Live pricing will be sourced from the
          LCR engine — carriers, destinations, and per-minute rates below are representative
          only.
        </span>
      </div>

      {/* ── Interstate / long-distance LCR comparison ── */}
      <section>
        <SectionHeader
          eyebrow="Outbound Termination"
          title="Interstate & Long-Distance Rates"
          description="Per-minute termination cost by destination across wholesale carriers. The cheapest
            carrier for each destination is the LCR winner, highlighted in azure."
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
