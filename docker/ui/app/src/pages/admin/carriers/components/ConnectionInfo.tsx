/**
 * ConnectionInfo — the read-only frosted-glass block listing a carrier's SIP
 * connection details (proxy, transport, auth, codecs, registration, optional
 * credentials / capacity limits). Presentation only.
 */

import { GLASS } from '../../../../components/glass/glass';
import type { Carrier } from '../../../../types/carrier';
import { connBlock, connRow, connKey, connValue } from '../styles';

function authLabel(authType: string): string {
  if (authType === 'credentials') return 'Credentials';
  if (authType === 'none') return 'None';
  return 'IP-based';
}

export function ConnectionInfo({ carrier }: { carrier: Carrier }) {
  const codecs = Array.isArray(carrier.codec_prefs)
    ? carrier.codec_prefs.join(', ')
    : String(carrier.codec_prefs ?? 'PCMU,PCMA');

  const rows: Array<[string, string]> = [
    ['SIP Proxy', `${carrier.sip_proxy}:${carrier.port}`],
    ['Transport', (carrier.transport ?? 'UDP').toUpperCase()],
    ['Auth', authLabel(carrier.auth_type)],
    ['Codecs', codecs],
    ['Registration', carrier.register ? 'Yes' : 'No'],
  ];

  if (carrier.auth_type === 'credentials' && carrier.username) {
    rows.push(['Username', carrier.username]);
    rows.push(['Password', '••••••••']);
  }
  if (carrier.max_channels != null) rows.push(['Max Channels', String(carrier.max_channels)]);
  if (carrier.cps_limit != null) rows.push(['CPS Limit', String(carrier.cps_limit)]);

  return (
    <div style={connBlock()}>
      {rows.map(([key, val]) => (
        <div key={key} style={connRow}>
          <span style={connKey}>{key}</span>
          <span style={connValue(GLASS.accent)}>{val}</span>
        </div>
      ))}
    </div>
  );
}
