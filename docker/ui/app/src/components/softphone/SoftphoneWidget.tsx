import { useState } from 'react';
import { useSoftphone } from '../../contexts/SoftphoneContext';
import { PresenceIndicator } from './PresenceIndicator';
import { DialPad } from './DialPad';
import { ActiveCallView } from './ActiveCall';
import { CallHistory } from './CallHistory';
import { ContactList } from './ContactList';
import { DeviceSelector } from './DeviceSelector';
import { IncomingCallBanner } from './IncomingCallBanner';
import type { PresenceStatus } from '../../types/softphone';

type WidgetTab = 'dialpad' | 'call' | 'history' | 'contacts' | 'settings';

const PRESENCE_OPTIONS: { value: PresenceStatus; label: string; color: string }[] = [
  { value: 'available', label: 'Available',      color: '#22c55e' },
  { value: 'away',      label: 'Away',           color: '#f59e0b' },
  { value: 'busy',      label: 'Busy',           color: '#ef4444' },
  { value: 'dnd',       label: 'Do Not Disturb', color: '#ef4444' },
  { value: 'offline',   label: 'Appear Offline', color: '#64748b' },
];

const CONNECTION_LABEL: Record<string, { label: string; color: string }> = {
  disconnected: { label: 'Disconnected',  color: '#64748b' },
  connecting:   { label: 'Connecting...', color: '#f59e0b' },
  connected:    { label: 'Authenticating...', color: '#f59e0b' },
  registered:   { label: 'Registered',    color: '#22c55e' },
  error:        { label: 'Error',          color: '#ef4444' },
};

const IconPhone = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 18, height: 18 }}>
    <path fillRule="evenodd" d="M1.5 4.5a3 3 0 0 1 3-3h1.372c.86 0 1.61.586 1.819 1.42l1.105 4.423a1.875 1.875 0 0 1-.694 1.955l-1.293.97c-.135.101-.164.249-.126.352a11.285 11.285 0 0 0 6.697 6.697c.103.038.25.009.352-.126l.97-1.293a1.875 1.875 0 0 1 1.955-.694l4.423 1.105c.834.209 1.42.959 1.42 1.82V19.5a3 3 0 0 1-3 3h-2.25C8.552 22.5 1.5 15.448 1.5 6.75V4.5Z" clipRule="evenodd" />
  </svg>
);

const IconClose = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
    <path d="M6 18 18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconDialpad = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 16, height: 16 }}>
    <path d="M3.75 6A2.25 2.25 0 0 1 6 3.75h.008a2.25 2.25 0 0 1 2.243 2.25v.008A2.25 2.25 0 0 1 6.008 8.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h.008a2.25 2.25 0 0 1 2.243 2.25v.008A2.25 2.25 0 0 1 6.008 18H6a2.25 2.25 0 0 1-2.25-2.25v-.008ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25h.008A2.25 2.25 0 0 1 18 6v.008a2.25 2.25 0 0 1-2.242 2.242H15.75A2.25 2.25 0 0 1 13.5 6.008V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25h.008a2.25 2.25 0 0 1 2.242 2.25v.008a2.25 2.25 0 0 1-2.242 2.242H15.75a2.25 2.25 0 0 1-2.25-2.242v-.008Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconHistory = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 16, height: 16 }}>
    <path d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconContacts = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 16, height: 16 }}>
    <path d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconSettings = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 16, height: 16 }}>
    <path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function SoftphoneWidget() {
  const {
    connectionState,
    activeCall,
    presence,
    isExpanded,
    credentials,
    setExpanded,
    setPresence,
  } = useSoftphone();

  const [activeTab, setActiveTab] = useState<WidgetTab>('dialpad');
  const [showPresenceMenu, setShowPresenceMenu] = useState(false);

  // If no credentials, don't render the widget at all
  if (!credentials && connectionState === 'disconnected') {
    return null;
  }

  const hasActiveCall = activeCall !== null && activeCall.state !== 'ended';
  const connInfo = CONNECTION_LABEL[connectionState] ?? CONNECTION_LABEL['disconnected'];

  // Auto-switch to call tab when a call becomes active
  const effectiveTab = hasActiveCall && activeTab === 'dialpad' ? 'call' : activeTab;

  const tabs: { id: WidgetTab; icon: React.ReactNode; label: string; badge?: number }[] = [
    { id: 'dialpad',  icon: <IconDialpad />,  label: 'Pad' },
    { id: 'call',     icon: <IconPhone />,     label: 'Call' },
    { id: 'history',  icon: <IconHistory />,  label: 'History' },
    { id: 'contacts', icon: <IconContacts />, label: 'Contacts' },
    { id: 'settings', icon: <IconSettings />, label: 'Settings' },
  ];

  return (
    <>
      {/* Incoming call banner renders via portal at top of screen */}
      <IncomingCallBanner />

      {/* CSS keyframe animations injected once */}
      <style>{`
        @keyframes slideDown {
          from { transform: translateY(-100%); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        @keyframes phonePulse {
          0%   { box-shadow: 0 0 0 0 rgba(99,102,241,0.7); }
          70%  { box-shadow: 0 0 0 14px rgba(99,102,241,0); }
          100% { box-shadow: 0 0 0 0 rgba(99,102,241,0); }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>

      {/* Widget container — fixed bottom-right */}
      <div
        style={{
          position: 'fixed',
          bottom: 24,
          right: 24,
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 10,
        }}
      >
        {/* Expanded panel */}
        {isExpanded && (
          <div
            style={{
              width: 320,
              maxHeight: 520,
              display: 'flex',
              flexDirection: 'column',
              background: 'linear-gradient(180deg, #131825 0%, #0f1420 100%)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 20,
              boxShadow: '0 24px 64px rgba(0,0,0,0.70), 0 0 0 1px rgba(255,255,255,0.04)',
              overflow: 'hidden',
              animation: 'slideDown 0.2s ease-out',
            }}
          >
            {/* Header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '14px 16px 10px',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                flexShrink: 0,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {/* Presence dot — clickable */}
                <div style={{ position: 'relative' }}>
                  <button
                    type="button"
                    onClick={() => setShowPresenceMenu((v) => !v)}
                    aria-label="Set presence status"
                    aria-haspopup="listbox"
                    aria-expanded={showPresenceMenu}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <PresenceIndicator status={presence} size={10} />
                  </button>

                  {/* Presence dropdown */}
                  {showPresenceMenu && (
                    <div
                      style={{
                        position: 'absolute',
                        top: 20,
                        left: 0,
                        background: '#1e2435',
                        border: '1px solid rgba(255,255,255,0.10)',
                        borderRadius: 10,
                        boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
                        zIndex: 10,
                        minWidth: 160,
                        overflow: 'hidden',
                      }}
                      role="listbox"
                      aria-label="Presence status options"
                    >
                      {PRESENCE_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          role="option"
                          aria-selected={presence === opt.value}
                          onClick={() => {
                            void setPresence(opt.value);
                            setShowPresenceMenu(false);
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            width: '100%',
                            padding: '8px 12px',
                            background: presence === opt.value ? 'rgba(255,255,255,0.06)' : 'transparent',
                            border: 'none',
                            color: '#e2e8f0',
                            fontSize: '0.8rem',
                            cursor: 'pointer',
                            textAlign: 'left',
                            transition: 'background 0.12s',
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = presence === opt.value ? 'rgba(255,255,255,0.06)' : 'transparent'; }}
                        >
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: opt.color, flexShrink: 0 }} />
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#94a3b8', letterSpacing: '-0.01em' }}>
                  Softphone
                </span>
                <span
                  style={{
                    fontSize: '0.6rem',
                    fontWeight: 600,
                    color: connInfo.color,
                    background: `${connInfo.color}18`,
                    border: `1px solid ${connInfo.color}30`,
                    borderRadius: 10,
                    padding: '2px 6px',
                    letterSpacing: '0.04em',
                  }}
                >
                  {connInfo.label}
                </span>
              </div>

              <button
                type="button"
                onClick={() => setExpanded(false)}
                aria-label="Minimize softphone"
                style={{
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 6,
                  color: '#475569',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 24,
                  height: 24,
                  padding: 0,
                  transition: 'color 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = '#94a3b8'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = '#475569'; }}
              >
                <IconClose />
              </button>
            </div>

            {/* Tab bar */}
            <div
              style={{
                display: 'flex',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                flexShrink: 0,
              }}
            >
              {tabs.map((tab) => {
                // Hide call tab when not in call; auto-show when in call
                if (tab.id === 'call' && !hasActiveCall) return null;
                const isActive = effectiveTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    aria-label={tab.label}
                    aria-selected={isActive}
                    style={{
                      flex: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 3,
                      padding: '8px 4px',
                      background: 'transparent',
                      border: 'none',
                      borderBottom: isActive ? '2px solid #3b82f6' : '2px solid transparent',
                      color: isActive ? '#60a5fa' : '#475569',
                      cursor: 'pointer',
                      fontSize: '0.58rem',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      transition: 'color 0.15s, border-color 0.15s',
                      position: 'relative',
                    }}
                    onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.color = '#64748b'; }}
                    onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.color = '#475569'; }}
                  >
                    {tab.icon}
                    {tab.label}
                    {tab.badge !== undefined && tab.badge > 0 && (
                      <span
                        style={{
                          position: 'absolute',
                          top: 5,
                          right: '50%',
                          transform: 'translateX(8px)',
                          minWidth: 14,
                          height: 14,
                          borderRadius: 7,
                          background: '#ef4444',
                          color: '#fff',
                          fontSize: '0.55rem',
                          fontWeight: 700,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '0 3px',
                        }}
                      >
                        {tab.badge > 99 ? '99+' : tab.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Tab content */}
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '12px 14px',
                minHeight: 0,
              }}
            >
              {effectiveTab === 'dialpad'  && <DialPad />}
              {effectiveTab === 'call'     && <ActiveCallView />}
              {effectiveTab === 'history'  && <CallHistory />}
              {effectiveTab === 'contacts' && <ContactList />}
              {effectiveTab === 'settings' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  <DeviceSelector />
                </div>
              )}
            </div>
          </div>
        )}

        {/* FAB / pill toggle button */}
        <button
          type="button"
          onClick={() => setExpanded(!isExpanded)}
          aria-label={isExpanded ? 'Minimize softphone' : 'Open softphone'}
          aria-expanded={isExpanded}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: isExpanded ? '10px 14px' : '12px 18px',
            borderRadius: 28,
            background: hasActiveCall
              ? 'linear-gradient(135deg, #16a34a 0%, #22c55e 100%)'
              : 'linear-gradient(135deg, #1d2235 0%, #252d42 100%)',
            border: '1px solid rgba(255,255,255,0.10)',
            color: hasActiveCall ? '#fff' : '#94a3b8',
            cursor: 'pointer',
            boxShadow: hasActiveCall
              ? '0 4px 20px rgba(34,197,94,0.45)'
              : '0 4px 20px rgba(0,0,0,0.45)',
            transition: 'box-shadow 0.2s',
            userSelect: 'none',
          }}
        >
          <IconPhone />
          {!isExpanded && (
            <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>
              {hasActiveCall ? 'Active Call' : 'Softphone'}
            </span>
          )}
          {/* Connection status dot */}
          <div
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: connInfo.color,
              flexShrink: 0,
              boxShadow: `0 0 4px ${connInfo.color}`,
            }}
          />
        </button>
      </div>
    </>
  );
}
