/**
 * RoomSidebar — the left rail: a "Start Meeting Now" CTA plus the aggregated
 * "Scheduled Meetings" list across every room. Selecting a schedule selects its
 * parent room. Purely presentational — all data + actions come via props.
 */

import { useState } from 'react';
import { Video, Calendar } from 'lucide-react';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import { GlassSheen } from '../../../components/glass/GlassCard';
import type { Conference } from '../../../types/conference';
import type { AggregatedSchedule } from '../types';
import { formatDate, formatTime, dialCodeFor } from '../helpers';
import {
  panelShell,
  startNowBtn,
  spinner,
  uppercaseLabel,
  listRow,
  iconTile,
} from '../styles';

interface RoomSidebarProps {
  isLoading: boolean;
  isStartingNow: boolean;
  allSchedules: AggregatedSchedule[];
  conferences: Conference[];
  selectedId: number | null;
  onStartNow: () => void;
  onSelectRoom: (id: number) => void;
}

export function RoomSidebar({
  isLoading,
  isStartingNow,
  allSchedules,
  conferences,
  selectedId,
  onStartNow,
  onSelectRoom,
}: RoomSidebarProps) {
  const [startHover, setStartHover] = useState(false);
  const busy = isLoading || isStartingNow;

  return (
    <div style={{ ...panelShell(), width: 320, flexShrink: 0 }}>
      <GlassSheen />
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
        {/* Start Meeting Now */}
        <div style={{ padding: '18px 16px 14px', flexShrink: 0 }}>
          <button
            type="button"
            onClick={onStartNow}
            disabled={busy}
            onMouseEnter={() => setStartHover(true)}
            onMouseLeave={() => setStartHover(false)}
            style={startNowBtn(startHover, busy)}
          >
            {isStartingNow ? (
              <>
                <div style={spinner(16, '#ffffff')} />
                Starting...
              </>
            ) : (
              <>
                <Video size={17} strokeWidth={2} />
                Start Meeting Now
              </>
            )}
          </button>
        </div>

        {/* Divider */}
        <div style={{ margin: '0 16px', height: 1, flexShrink: 0, background: 'rgba(255,255,255,0.07)' }} />

        {/* Scheduled Meetings */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: '14px 16px 8px', flexShrink: 0 }}>
            <span style={uppercaseLabel}>Scheduled Meetings</span>
          </div>

          {isLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 16px 16px' }}>
              <div style={spinner(18)} />
            </div>
          ) : allSchedules.length === 0 ? (
            <div style={{ padding: '8px 16px 16px', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
              <div style={{ fontSize: '0.8rem', color: GLASS.textFaint }}>No upcoming meetings</div>
              <button
                type="button"
                onClick={() => {
                  if (conferences.length > 0) onSelectRoom(conferences[0].id);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '7px 13px',
                  borderRadius: 9,
                  background: hexToRgba(GLASS.accent, 0.1),
                  border: `1px solid ${hexToRgba(GLASS.accent, 0.24)}`,
                  color: '#93c5fd',
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = hexToRgba(GLASS.accent, 0.18); }}
                onMouseLeave={(e) => { e.currentTarget.style.background = hexToRgba(GLASS.accent, 0.1); }}
              >
                <Calendar size={12} />
                Schedule a Meeting
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '0 10px 12px' }}>
              {allSchedules.map((s) => {
                const active = selectedId === s.conference.id;
                return (
                  <button
                    key={`${s.conference.id}-${s.id}`}
                    type="button"
                    onClick={() => onSelectRoom(s.conference.id)}
                    style={{
                      ...listRow(active),
                      alignItems: 'flex-start',
                      cursor: 'pointer',
                      textAlign: 'left',
                      width: '100%',
                      fontFamily: 'inherit',
                    }}
                  >
                    <div style={{ ...iconTile(30), marginTop: 1 }}>
                      <Calendar size={13} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: '0.8rem',
                          fontWeight: 600,
                          color: GLASS.text,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          lineHeight: 1.3,
                        }}
                      >
                        {s.title}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: GLASS.textMuted, marginTop: 2 }}>
                        {formatDate(s.start_time)} · {formatTime(s.start_time)}
                      </div>
                      <div style={{ fontSize: '0.68rem', color: GLASS.textFaint, marginTop: 1, fontFamily: 'ui-monospace, monospace' }}>
                        {dialCodeFor(s.conference.room_number)}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
