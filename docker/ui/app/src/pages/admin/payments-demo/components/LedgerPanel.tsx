/**
 * LedgerPanel — the append-only transaction history off the demo-state read.
 * Every credit/debit posts a real ledger entry; the balance is the running
 * sum. Rows carry the rail tag family (card=azure, USDC=teal, x402=green,
 * agent tab=cyan, platform=slate) and signed amounts.
 */

import type { LedgerEntry } from '../types';
import { ENTRY_LABEL, fmtDollars, fmtRef, fmtSigned, fmtWhen, railClass, railLabel } from '../format';

export function LedgerPanel({ entries }: { entries: LedgerEntry[] }) {
  return (
    <section className="dl-panel">
      <div className="dl-panel-head">
        <span className="dl-panel-title">Ledger</span>
        <span className="dl-count">{entries.length}</span>
        <p className="dl-panel-sub">
          Append-only source of truth — every scenario posts real entries here; the balance is the
          running sum that authorizes calls.
        </p>
      </div>

      {entries.length === 0 ? (
        <div className="dl-panel-body">
          <div className="dl-empty">
            No entries yet — run a scenario and watch credits and debits stream in.
          </div>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th className="dl-th">When</th>
                <th className="dl-th">Type</th>
                <th className="dl-th">Rail</th>
                <th className="dl-th">Reference</th>
                <th className="dl-th" style={{ textAlign: 'right' }}>Amount</th>
                <th className="dl-th" style={{ textAlign: 'right' }}>Balance after</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="dl-row">
                  <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)', fontSize: '0.74rem' }}>
                    {fmtWhen(e.created_at)}
                  </td>
                  <td className="dlx-td">{ENTRY_LABEL[e.entry_type] ?? e.entry_type}</td>
                  <td className="dlx-td">
                    <span className={railClass(e.source)}>{railLabel(e.source)}</span>
                  </td>
                  <td className="dlx-td">
                    {e.external_ref ? (
                      <span className="dlx9-ref" style={{ marginTop: 0 }}>{fmtRef(e.external_ref)}</span>
                    ) : (
                      <span style={{ color: 'var(--rcf-ink-dim)' }}>—</span>
                    )}
                  </td>
                  <td
                    className={`dlx-td dlx9-amt ${e.amount >= 0 ? 'dlx9-amt-credit' : 'dlx9-amt-debit'}`}
                    style={{ textAlign: 'right' }}
                  >
                    {fmtSigned(e.amount)}
                  </td>
                  <td className="dlx-td dlx9-amt" style={{ textAlign: 'right' }}>
                    {fmtDollars(e.balance_after)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
