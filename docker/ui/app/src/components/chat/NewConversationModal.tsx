import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../api/client';
import { createConversation } from '../../api/chat';
import type { Conversation, DirectoryUser } from '../../types/chat';
import { useAuth } from '../../contexts/AuthContext';

interface NewConversationModalProps {
  onClose: () => void;
  onCreated: (conversation: Conversation) => void;
}

const IconX = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
    <path d="M6 18 18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconCheck = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} style={{ width: 12, height: 12 }}>
    <path d="m4.5 12.75 6 6 9-13.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

type ConvType = 'direct' | 'group';

export function NewConversationModal({ onClose, onCreated }: NewConversationModalProps) {
  const { user } = useAuth();

  const [convType, setConvType] = useState<ConvType>('direct');
  const [groupName, setGroupName] = useState('');
  const [search, setSearch] = useState('');
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  const [isLoadingDir, setIsLoadingDir] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

  /* ─── Load directory ─────────────────────────────────────── */

  useEffect(() => {
    void apiRequest<DirectoryUser[]>('GET', '/extensions/directory')
      .then((users) => {
        // Exclude the current user from the list
        setDirectory(users.filter((u) => u.user_id !== user?.id));
        setIsLoadingDir(false);
      })
      .catch(() => {
        setIsLoadingDir(false);
      });
    // Focus search on open
    setTimeout(() => searchRef.current?.focus(), 80);
  }, [user?.id]);

  /* ─── Filter users ───────────────────────────────────────── */

  const filtered = search.trim()
    ? directory.filter((u) => {
        const q = search.toLowerCase();
        return (
          u.name.toLowerCase().includes(q) ||
          u.email.toLowerCase().includes(q) ||
          u.extension_number?.includes(q) ||
          u.department?.toLowerCase().includes(q)
        );
      })
    : directory;

  /* ─── Selection ──────────────────────────────────────────── */

  const toggleUser = useCallback((userId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        // For direct messages, only one participant
        if (convType === 'direct') {
          next.clear();
        }
        next.add(userId);
      }
      return next;
    });
  }, [convType]);

  // When switching to direct, clear multi-selections
  const handleTypeSwitch = useCallback((t: ConvType) => {
    setConvType(t);
    if (t === 'direct' && selectedIds.size > 1) {
      setSelectedIds(new Set());
    }
  }, [selectedIds.size]);

  /* ─── Create ─────────────────────────────────────────────── */

  const canCreate =
    selectedIds.size > 0 &&
    (convType === 'direct' || groupName.trim().length > 0);

  const handleCreate = useCallback(async () => {
    if (!canCreate || isCreating) return;
    setError(null);
    setIsCreating(true);
    try {
      const conv = await createConversation(
        convType,
        [...selectedIds],
        convType === 'group' ? groupName.trim() : undefined,
      );
      onCreated(conv);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create conversation');
    } finally {
      setIsCreating(false);
    }
  }, [canCreate, isCreating, convType, selectedIds, groupName, onCreated]);

  /* ─── Keyboard: close on Escape ─────────────────────────── */

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  /* ─── Render ─────────────────────────────────────────────── */

  const selectedUsers = directory.filter((u) => selectedIds.has(u.user_id));

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.60)',
          backdropFilter: 'blur(4px)',
          zIndex: 300,
        }}
      />

      {/* Modal panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New conversation"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 301,
          width: 480,
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: 'calc(100vh - 64px)',
          display: 'flex',
          flexDirection: 'column',
          background: 'linear-gradient(180deg, #141720 0%, #0f1117 100%)',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 16,
          boxShadow: '0 24px 64px rgba(0,0,0,0.60), 0 0 0 1px rgba(255,255,255,0.04)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '18px 20px 14px',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
            flexShrink: 0,
          }}
        >
          <div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: '#f1f5f9', letterSpacing: '-0.02em' }}>
              New Conversation
            </div>
            <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: 2 }}>
              Start a direct message or group chat
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: '#64748b',
              cursor: 'pointer',
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = '#f1f5f9'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = '#64748b'; }}
          >
            <IconX />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Type toggle */}
          <div
            style={{
              display: 'flex',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: 10,
              padding: 3,
            }}
          >
            {(['direct', 'group'] as ConvType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => handleTypeSwitch(t)}
                style={{
                  flex: 1,
                  padding: '7px 0',
                  borderRadius: 7,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  transition: 'background 0.15s, color 0.15s',
                  background: convType === t
                    ? 'linear-gradient(135deg, rgba(59,130,246,0.22) 0%, rgba(129,140,248,0.14) 100%)'
                    : 'transparent',
                  color: convType === t ? '#f1f5f9' : '#64748b',
                  boxShadow: convType === t ? '0 0 0 1px rgba(59,130,246,0.25)' : 'none',
                }}
              >
                {t === 'direct' ? 'Direct Message' : 'Group Chat'}
              </button>
            ))}
          </div>

          {/* Group name input (group only) */}
          {convType === 'group' && (
            <div>
              <label
                htmlFor="group-name"
                style={{ fontSize: '0.72rem', fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em' }}
              >
                Group Name
              </label>
              <input
                id="group-name"
                type="text"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="e.g. Engineering Team"
                style={{
                  width: '100%',
                  padding: '9px 12px',
                  borderRadius: 9,
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.09)',
                  color: '#f1f5f9',
                  fontSize: '0.875rem',
                  outline: 'none',
                  fontFamily: 'inherit',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          )}

          {/* Selected chips */}
          {selectedUsers.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {selectedUsers.map((u) => (
                <button
                  key={u.user_id}
                  type="button"
                  onClick={() => toggleUser(u.user_id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '4px 8px 4px 6px',
                    borderRadius: 20,
                    background: 'rgba(59,130,246,0.14)',
                    border: '1px solid rgba(59,130,246,0.28)',
                    color: '#93c5fd',
                    fontSize: '0.75rem',
                    fontWeight: 500,
                    cursor: 'pointer',
                    transition: 'background 0.12s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(59,130,246,0.24)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(59,130,246,0.14)'; }}
                >
                  <span
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: '50%',
                      background: 'rgba(59,130,246,0.30)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '0.6rem',
                      fontWeight: 700,
                      color: '#93c5fd',
                      flexShrink: 0,
                    }}
                  >
                    {u.name.charAt(0).toUpperCase()}
                  </span>
                  {u.name}
                  <span style={{ opacity: 0.6, marginLeft: 2 }}>
                    <IconX />
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* User search */}
          <div>
            <label
              htmlFor="user-search"
              style={{ fontSize: '0.72rem', fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em' }}
            >
              {convType === 'direct' ? 'Select Person' : 'Add Members'}
            </label>
            <input
              id="user-search"
              ref={searchRef}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, email, or extension..."
              style={{
                width: '100%',
                padding: '9px 12px',
                borderRadius: 9,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.09)',
                color: '#f1f5f9',
                fontSize: '0.875rem',
                outline: 'none',
                fontFamily: 'inherit',
                boxSizing: 'border-box',
                marginBottom: 8,
              }}
            />

            {/* Directory list */}
            <div
              style={{
                maxHeight: 220,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                scrollbarWidth: 'thin',
                scrollbarColor: 'rgba(255,255,255,0.06) transparent',
              }}
            >
              {isLoadingDir && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
                  <div style={{ width: 20, height: 20, border: '2px solid rgba(255,255,255,0.08)', borderTopColor: '#3b82f6', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                </div>
              )}

              {!isLoadingDir && filtered.length === 0 && (
                <div style={{ fontSize: '0.8rem', color: '#334155', padding: '12px 4px', textAlign: 'center' }}>
                  No users found
                </div>
              )}

              {filtered.map((u) => {
                const isSelected = selectedIds.has(u.user_id);
                return (
                  <button
                    key={u.user_id}
                    type="button"
                    onClick={() => toggleUser(u.user_id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 10px',
                      borderRadius: 9,
                      border: '1px solid transparent',
                      background: isSelected
                        ? 'rgba(59,130,246,0.10)'
                        : 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                      width: '100%',
                      transition: 'background 0.12s',
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    {/* Avatar */}
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: '50%',
                        background: 'rgba(99,102,241,0.15)',
                        border: '1px solid rgba(99,102,241,0.25)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '0.8rem',
                        fontWeight: 700,
                        color: '#818cf8',
                        flexShrink: 0,
                        userSelect: 'none',
                      }}
                    >
                      {u.name.charAt(0).toUpperCase()}
                    </div>

                    {/* Info */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.85rem', fontWeight: 500, color: '#f1f5f9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {u.name}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {u.email}
                        {u.extension_number && ` · ext. ${u.extension_number}`}
                        {u.department && ` · ${u.department}`}
                      </div>
                    </div>

                    {/* Checkmark */}
                    {isSelected && (
                      <div
                        style={{
                          width: 20,
                          height: 20,
                          borderRadius: '50%',
                          background: '#3b82f6',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          color: '#fff',
                        }}
                      >
                        <IconCheck />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Error */}
          {error && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 9,
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.20)',
                color: '#f87171',
                fontSize: '0.8rem',
              }}
            >
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            padding: '14px 20px 18px',
            borderTop: '1px solid rgba(255,255,255,0.07)',
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '8px 18px',
              borderRadius: 9,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.09)',
              color: '#64748b',
              fontSize: '0.85rem',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = '#94a3b8'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = '#64748b'; }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={!canCreate || isCreating}
            style={{
              padding: '8px 20px',
              borderRadius: 9,
              background: canCreate && !isCreating
                ? 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)'
                : 'rgba(255,255,255,0.06)',
              border: 'none',
              color: canCreate && !isCreating ? '#fff' : '#334155',
              fontSize: '0.85rem',
              fontWeight: 600,
              cursor: canCreate && !isCreating ? 'pointer' : 'not-allowed',
              transition: 'background 0.15s, opacity 0.15s',
              opacity: canCreate && !isCreating ? 1 : 0.6,
              boxShadow: canCreate && !isCreating ? '0 2px 10px rgba(59,130,246,0.30)' : 'none',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {isCreating ? (
              <>
                <div style={{ width: 13, height: 13, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                Creating...
              </>
            ) : (
              convType === 'direct' ? 'Open Chat' : 'Create Group'
            )}
          </button>
        </div>
      </div>
    </>
  );
}
