/**
 * ProductCards — the per-product provisioning tables shown in the 360 view:
 * RCF numbers, API DIDs, and SIP trunks. Each is a glass section card with a
 * semantic product accent and a frosted data table.
 */

import { GLASS } from '../../../../components/glass/glass';
import { fmt } from '../../../../utils/format';
import type { ApiDidProduct, RcfProduct, TrunkProduct } from '../types';
import { MONO, tableTd, tableTh, tableHeadRow, statusPill } from '../styles';
import { SectionCard } from './SectionCard';
import { IconCode, IconNetwork, IconPhoneForwarded } from './icons';

const RCF_ACCENT = GLASS.success;
const API_ACCENT = '#a855f7';
const TRUNK_ACCENT = GLASS.warning;

function enabledPill(enabled: boolean, accent: string) {
  return <span style={statusPill(enabled ? accent : GLASS.textMuted)}>{enabled ? 'Active' : 'Disabled'}</span>;
}

const dash = <span style={{ color: GLASS.textFaint, fontStyle: 'italic' }}>—</span>;

// ── RCF Numbers ──────────────────────────────────────────────────────────────

export function RcfCard({ rcf }: { rcf: RcfProduct[] }) {
  return (
    <SectionCard accent={RCF_ACCENT} title={`RCF Numbers (${rcf.length})`} icon={<IconPhoneForwarded />}>
      <div style={{ overflowX: 'auto', borderRadius: 12, border: '1px solid rgba(255,255,255,0.06)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={tableHeadRow}>
              {['DID', 'Name', 'Forward To', 'Timeout', 'Failover', 'Caller ID', 'Status'].map((c) => <th key={c} style={tableTh}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {rcf.map((r) => (
              <tr key={r.id}>
                <td style={{ ...tableTd, fontFamily: MONO, color: '#cbd5e0', whiteSpace: 'nowrap' }}>{fmt(r.did)}</td>
                <td style={{ ...tableTd, color: GLASS.textMuted }}>{r.name ?? dash}</td>
                <td style={{ ...tableTd, fontFamily: MONO, whiteSpace: 'nowrap' }}>{fmt(r.forward_to)}</td>
                <td style={{ ...tableTd, color: GLASS.textMuted, whiteSpace: 'nowrap' }}>{r.ring_timeout}s</td>
                <td style={{ ...tableTd, fontFamily: MONO, color: GLASS.textMuted, whiteSpace: 'nowrap' }}>
                  {r.failover_to ? fmt(r.failover_to) : <span style={{ color: GLASS.textFaint, fontStyle: 'italic' }}>None</span>}
                </td>
                <td style={{ ...tableTd, textAlign: 'center' }}>
                  <span style={{ fontSize: '0.72rem', color: r.pass_caller_id ? GLASS.success : GLASS.textMuted }}>
                    {r.pass_caller_id ? 'Pass' : 'Strip'}
                  </span>
                </td>
                <td style={{ ...tableTd, textAlign: 'center' }}>{enabledPill(r.enabled, RCF_ACCENT)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ── API DIDs ─────────────────────────────────────────────────────────────────

export function ApiDidCard({ api_dids }: { api_dids: ApiDidProduct[] }) {
  return (
    <SectionCard accent={API_ACCENT} title={`API DIDs (${api_dids.length})`} icon={<IconCode />}>
      <div style={{ overflowX: 'auto', borderRadius: 12, border: '1px solid rgba(255,255,255,0.06)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={tableHeadRow}>
              {['DID', 'Voice URL', 'Status'].map((c) => <th key={c} style={tableTh}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {api_dids.map((d) => (
              <tr key={d.did}>
                <td style={{ ...tableTd, fontFamily: MONO, color: '#cbd5e0', whiteSpace: 'nowrap' }}>{fmt(d.did)}</td>
                <td style={{ ...tableTd, maxWidth: 320 }}>
                  <span
                    style={{ fontSize: '0.75rem', fontFamily: MONO, color: GLASS.textMuted, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={d.voice_url}
                  >
                    {d.voice_url}
                  </span>
                </td>
                <td style={{ ...tableTd, textAlign: 'center' }}>{enabledPill(d.enabled, API_ACCENT)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ── SIP Trunks ───────────────────────────────────────────────────────────────

export function TrunksCard({ trunks }: { trunks: TrunkProduct[] }) {
  return (
    <SectionCard accent={TRUNK_ACCENT} title={`SIP Trunks (${trunks.length})`} icon={<IconNetwork />}>
      <div style={{ overflowX: 'auto', borderRadius: 12, border: '1px solid rgba(255,255,255,0.06)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={tableHeadRow}>
              {['Trunk Name', 'Max Channels', 'DIDs', 'Auth IPs', 'Status'].map((c) => <th key={c} style={tableTh}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {trunks.map((t) => (
              <tr key={t.id}>
                <td style={{ ...tableTd, fontWeight: 600 }}>{t.trunk_name}</td>
                <td style={{ ...tableTd, color: GLASS.textMuted, fontVariantNumeric: 'tabular-nums' }}>{t.max_channels}</td>
                <td style={{ ...tableTd, color: GLASS.textMuted, fontVariantNumeric: 'tabular-nums' }}>{t.did_count}</td>
                <td style={{ ...tableTd, color: GLASS.textMuted, fontVariantNumeric: 'tabular-nums' }}>{t.ip_count}</td>
                <td style={{ ...tableTd, textAlign: 'center' }}>{enabledPill(t.enabled, TRUNK_ACCENT)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
