import { useEffect, useState, useCallback } from 'react';
import { getDirectory } from '../../api/extensions';
import { useSoftphone } from '../../contexts/SoftphoneContext';
import { PresenceIndicator } from './PresenceIndicator';
import type { Extension } from '../../types/softphone';
import { useAuth } from '../../contexts/AuthContext';

const IconSearch = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
    <path d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function ContactList() {
  const { makeCall, connectionState } = useSoftphone();
  const { user } = useAuth();
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [query, setQuery] = useState('');

  const loadDirectory = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await getDirectory(user?.customer_id ?? undefined);
      setExtensions(data);
    } catch {
      setExtensions([]);
    } finally {
      setIsLoading(false);
    }
  }, [user?.customer_id]);

  useEffect(() => {
    void loadDirectory();
  }, [loadDirectory]);

  const filtered = extensions.filter((ext) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      ext.extension.includes(q) ||
      ext.display_name.toLowerCase().includes(q) ||
      (ext.user_name ?? '').toLowerCase().includes(q)
    );
  });

  const canDial = connectionState === 'registered';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      {/* Search */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <span
          style={{
            position: 'absolute',
            left: 10,
            color: '#475569',
            pointerEvents: 'none',
            display: 'flex',
          }}
        >
          <IconSearch />
        </span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search contacts..."
          aria-label="Search contacts"
          style={{
            width: '100%',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8,
            color: '#f1f5f9',
            fontSize: '0.8rem',
            padding: '7px 10px 7px 30px',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
      </div>

      {/* Extension list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {isLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}>
            <div style={{ width: 18, height: 18, border: '2px solid rgba(255,255,255,0.1)', borderTopColor: '#3b82f6', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#334155', fontSize: '0.8rem', padding: 20 }}>
            {query ? 'No contacts match your search' : 'No extensions in directory'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {filtered.map((ext) => (
              <div
                key={ext.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '7px 6px',
                  borderRadius: 8,
                  transition: 'background 0.12s',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                {/* Avatar with presence dot */}
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      background: 'linear-gradient(135deg, rgba(99,102,241,0.25) 0%, rgba(59,130,246,0.20) 100%)',
                      border: '1px solid rgba(99,102,241,0.25)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      color: '#818cf8',
                    }}
                  >
                    {ext.display_name.charAt(0).toUpperCase()}
                  </div>
                  <div style={{ position: 'absolute', bottom: 0, right: 0 }}>
                    <PresenceIndicator status={ext.presence_status ?? 'offline'} size={9} />
                  </div>
                </div>

                {/* Name + extension */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ext.display_name}
                  </div>
                  <div style={{ fontSize: '0.68rem', color: '#475569', fontFamily: 'monospace' }}>
                    Ext. {ext.extension}
                  </div>
                </div>

                {/* Call button */}
                {canDial && (
                  <button
                    type="button"
                    onClick={() => void makeCall(ext.extension)}
                    aria-label={`Call ${ext.display_name}`}
                    style={{
                      flexShrink: 0,
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'rgba(34,197,94,0.10)',
                      border: '1px solid rgba(34,197,94,0.25)',
                      color: '#22c55e',
                      cursor: 'pointer',
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(34,197,94,0.20)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(34,197,94,0.10)'; }}
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 12, height: 12 }}>
                      <path fillRule="evenodd" d="M1.5 4.5a3 3 0 0 1 3-3h1.372c.86 0 1.61.586 1.819 1.42l1.105 4.423a1.875 1.875 0 0 1-.694 1.955l-1.293.97c-.135.101-.164.249-.126.352a11.285 11.285 0 0 0 6.697 6.697c.103.038.25.009.352-.126l.97-1.293a1.875 1.875 0 0 1 1.955-.694l4.423 1.105c.834.209 1.42.959 1.42 1.82V19.5a3 3 0 0 1-3 3h-2.25C8.552 22.5 1.5 15.448 1.5 6.75V4.5Z" clipRule="evenodd" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
