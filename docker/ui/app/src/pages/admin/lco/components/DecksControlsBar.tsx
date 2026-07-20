/**
 * DecksControlsBar — rate-deck toolbar: title, carrier filter + prefix search
 * (server-side), and the "Add rate" / "Import CSV" actions. Only the search focus
 * is local (visual); everything else is driven by props.
 */

import { useState } from 'react';
import { Search, Plus, Upload, Layers } from 'lucide-react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import type { Carrier } from '../../../../types/carrier';
import { sectionTitle, sectionSubtitle, primaryBtn, ghostBtn, searchWrap, searchInput, selectStyle } from '../styles';

interface DecksControlsBarProps {
  carrierId: string;
  onCarrierChange: (v: string) => void;
  search: string;
  onSearchChange: (v: string) => void;
  onSearchCommit: () => void;
  carriers: Carrier[];
  onAdd: () => void;
  onImport: () => void;
}

export function DecksControlsBar({
  carrierId,
  onCarrierChange,
  search,
  onSearchChange,
  onSearchCommit,
  carriers,
  onAdd,
  onImport,
}: DecksControlsBarProps) {
  const [focused, setFocused] = useState(false);
  const [addHover, setAddHover] = useState(false);
  const [importHover, setImportHover] = useState(false);

  return (
    <GlassPanel padding="20px 24px">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Layers size={17} style={{ color: GLASS.accent }} />
              <h2 style={sectionTitle}>Rate Decks</h2>
            </div>
            <p style={sectionSubtitle}>Per-carrier cost-per-minute by destination prefix — the inputs to every LCO decision.</p>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" onClick={onImport} onMouseEnter={() => setImportHover(true)} onMouseLeave={() => setImportHover(false)} style={ghostBtn(importHover)}>
              <Upload size={14} />
              Import CSV
            </button>
            <button type="button" onClick={onAdd} onMouseEnter={() => setAddHover(true)} onMouseLeave={() => setAddHover(false)} style={primaryBtn(addHover)}>
              <Plus size={14} />
              Add rate
            </button>
          </div>
        </div>

        <form
          style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}
          onSubmit={(e) => {
            e.preventDefault();
            onSearchCommit();
          }}
        >
          <div style={searchWrap(focused)}>
            <Search size={15} color={focused ? GLASS.accent : GLASS.textFaint} style={{ flexShrink: 0 }} />
            <input
              type="text"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="Prefix starts-with… e.g. 1617"
              style={searchInput}
            />
          </div>
          <select value={carrierId} onChange={(e) => onCarrierChange(e.target.value)} style={selectStyle(Boolean(carrierId))} aria-label="Carrier filter">
            <option value="">All carriers</option>
            {carriers.map((c) => (
              <option key={c.id} value={c.id}>{c.display_name || c.gateway_name}</option>
            ))}
          </select>
          <button type="submit" style={ghostBtn(false)}>
            <Search size={14} />
            Search
          </button>
        </form>
      </div>
    </GlassPanel>
  );
}
