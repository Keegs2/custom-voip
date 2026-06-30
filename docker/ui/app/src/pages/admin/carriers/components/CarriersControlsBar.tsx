/**
 * CarriersControlsBar — the section header strip inside a glass panel: title +
 * subtitle on the left, a count chip, and the "Test All" / "Add Carrier"
 * actions on the right. Stateless apart from button hover (purely visual).
 */

import { useState } from 'react';
import { GlassPanel, GlassChip } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { sectionTitle, sectionSubtitle, primaryBtn, ghostBtn, spinnerRing } from '../styles';
import { IconPlus, IconPulse } from './icons';

interface CarriersControlsBarProps {
  count: number | null;
  testingAll: boolean;
  onTestAll: () => void;
  onAdd: () => void;
}

export function CarriersControlsBar({ count, testingAll, onTestAll, onAdd }: CarriersControlsBarProps) {
  const [testHover, setTestHover] = useState(false);
  const [addHover, setAddHover] = useState(false);

  return (
    <GlassPanel padding="20px 24px">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2 style={sectionTitle}>Carrier Gateways</h2>
            {count !== null && (
              <GlassChip label={`${count} gateway${count === 1 ? '' : 's'}`} color={GLASS.accent} />
            )}
          </div>
          <p style={sectionSubtitle}>Configure SIP trunk connections to upstream carriers</p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            onClick={onTestAll}
            disabled={testingAll}
            onMouseEnter={() => setTestHover(true)}
            onMouseLeave={() => setTestHover(false)}
            style={ghostBtn(testHover, testingAll)}
          >
            {testingAll ? <span style={spinnerRing()} /> : <IconPulse />}
            Test All
          </button>
          <button
            type="button"
            onClick={onAdd}
            onMouseEnter={() => setAddHover(true)}
            onMouseLeave={() => setAddHover(false)}
            style={primaryBtn(addHover)}
          >
            <IconPlus />
            Add Carrier
          </button>
        </div>
      </div>
    </GlassPanel>
  );
}
