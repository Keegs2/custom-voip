/**
 * ConnectionInfo — the static "point your PBX here" panel shown in the expanded
 * trunk detail. No state, no data.
 */

import { GLASS } from '../../../../components/glass/glass';
import { SIP_SERVER } from '../types';
import { sectionLabel, connectionBox, connectionValue } from '../styles';

export function ConnectionInfo() {
  return (
    <div>
      <div style={sectionLabel()}>Connection Info</div>
      <div style={connectionBox()}>
        <div style={{ marginBottom: 6 }}>Point your customer&apos;s PBX to:</div>
        <div style={connectionValue()}>{SIP_SERVER}</div>
        <div style={{ marginTop: 6, fontSize: '0.75rem', color: GLASS.textFaint }}>SIP over UDP/TCP — Port 5060</div>
      </div>
    </div>
  );
}
