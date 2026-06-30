/**
 * RcfCard — one RCF line rendered as a frosted, lift-on-hover glass card (blue
 * accent). Used by the Numbers tab's card view for small customer accounts.
 *
 * All server state (forward_to edit, enable toggle, caller-id pass-through, max
 * channels, label) is delegated to the shared hooks in `rcf/hooks`, so this file
 * is presentation only. React #310: every hook sits at the top of its component.
 */

import { useState } from 'react';
import type { RcfEntry } from '../types/rcf';
import { Spinner } from '../components/ui/Spinner';
import { useAuth } from '../contexts/AuthContext';
import { fmt } from '../utils/format';
import { GlassCard, GlassChip } from '../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../components/glass/glass';
import {
  useForwardToEditor,
  useEnableToggle,
  useCallerIdToggle,
  useMaxChannelsEditor,
  useNameEditor,
} from './rcf/hooks';
import { MONO, toggleTrack, toggleKnob } from './rcf/styles';

const BLUE = GLASS.accent;

interface RcfCardProps {
  entry: RcfEntry;
  /** Controlled edit value from parent's pendingEdits state. */
  pendingValue: string;
  onPendingChange: (did: string, value: string) => void;
}

// ── BlueToggle ───────────────────────────────────────────────────────────────

function BlueToggle({ checked, disabled, pending, onChange, title }: { checked: boolean; disabled: boolean; pending: boolean; onChange: () => void; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled || pending}
      onClick={onChange}
      title={title}
      style={{ ...toggleTrack(checked, pending), cursor: disabled || pending ? 'not-allowed' : 'pointer' }}
    >
      <span style={toggleKnob(checked)} />
    </button>
  );
}

// ── ForwardToDisplay ─────────────────────────────────────────────────────────

function ForwardToDisplay({ entry, pendingValue, canEdit, onPendingChange }: { entry: RcfEntry; pendingValue: string; canEdit: boolean; onPendingChange: (did: string, value: string) => void }) {
  const ed = useForwardToEditor(entry, canEdit, pendingValue, onPendingChange);

  if (ed.editing && canEdit) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input
          type="tel"
          value={pendingValue}
          autoFocus
          placeholder="+1XXXXXXXXXX"
          disabled={ed.isPending}
          onChange={(e) => onPendingChange(entry.did, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); ed.save(); }
            if (e.key === 'Escape') ed.cancel();
          }}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            fontSize: '1.3rem',
            fontWeight: 700,
            fontFamily: MONO,
            letterSpacing: '0.02em',
            padding: '10px 14px',
            borderRadius: 10,
            border: `1px solid ${ed.isDirty ? hexToRgba(BLUE, 0.6) : hexToRgba(BLUE, 0.3)}`,
            background: 'rgba(8,10,15,0.55)',
            color: BLUE,
            outline: 'none',
            boxShadow: ed.isDirty ? `0 0 0 3px ${hexToRgba(BLUE, 0.14)}` : `0 0 0 2px ${hexToRgba(BLUE, 0.08)}`,
            opacity: ed.isPending ? 0.55 : 1,
            transition: 'border-color 0.15s, box-shadow 0.15s',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            disabled={!ed.isDirty || ed.isPending}
            onMouseDown={(e) => { e.preventDefault(); ed.save(); }}
            style={{
              flex: 1,
              padding: '8px 0',
              borderRadius: 8,
              border: 'none',
              background: ed.isDirty && !ed.isPending ? 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)' : hexToRgba(BLUE, 0.15),
              color: ed.isDirty && !ed.isPending ? '#fff' : hexToRgba(BLUE, 0.4),
              fontSize: '0.78rem',
              fontWeight: 700,
              cursor: ed.isDirty && !ed.isPending ? 'pointer' : 'not-allowed',
              fontFamily: 'inherit',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              boxShadow: ed.isDirty && !ed.isPending ? '0 2px 10px rgba(59,130,246,0.35)' : 'none',
              transition: 'background 0.15s, color 0.15s',
              letterSpacing: '-0.01em',
            }}
          >
            {ed.isPending ? <Spinner size="xs" /> : 'Save'}
          </button>
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); ed.cancel(); }}
            style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.04)', color: GLASS.textMuted, fontSize: '0.78rem', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', transition: 'color 0.15s' }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', cursor: canEdit ? 'pointer' : 'default', minWidth: 0 }}
      onMouseEnter={() => { if (canEdit) ed.setHovered(true); }}
      onMouseLeave={() => ed.setHovered(false)}
      onClick={ed.beginEdit}
      title={canEdit ? 'Click to change forwarding destination' : undefined}
    >
      <span
        style={{
          fontSize: '1.45rem',
          fontWeight: 800,
          fontFamily: MONO,
          letterSpacing: '0.02em',
          color: ed.savedFlash ? '#bfdbfe' : BLUE,
          textShadow: ed.savedFlash ? `0 0 16px ${hexToRgba(BLUE, 0.45)}` : `0 0 12px ${hexToRgba(BLUE, 0.22)}`,
          transition: 'color 0.25s, text-shadow 0.25s',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {fmt(entry.forward_to)}
      </span>
      {canEdit && (
        <span style={{ position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)', opacity: ed.hovered ? 1 : 0, transition: 'opacity 0.18s', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 7, background: ed.hovered ? hexToRgba(BLUE, 0.12) : 'transparent', border: ed.hovered ? `1px solid ${hexToRgba(BLUE, 0.24)}` : '1px solid transparent' }}>
          <svg viewBox="0 0 16 16" fill="none" stroke={BLUE} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ width: 12, height: 12 }}>
            <path d="M11.5 2.5a1.414 1.414 0 0 1 2 2L5 13H2v-3L11.5 2.5z" />
          </svg>
        </span>
      )}
    </div>
  );
}

// ── StatPill ─────────────────────────────────────────────────────────────────

function StatPill({ icon, label, value, hint, onClick, active, clickable }: { icon: React.ReactNode; label: string; value: string; hint?: string; onClick?: () => void; active?: boolean; clickable?: boolean }) {
  const [hovered, setHovered] = useState(false);
  const isInteractive = clickable && !!onClick;

  return (
    <button
      type="button"
      onClick={isInteractive ? onClick : undefined}
      disabled={!isInteractive}
      onMouseEnter={() => { if (isInteractive) setHovered(true); }}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 3,
        padding: '8px 10px',
        borderRadius: 10,
        border: active ? `1px solid ${hexToRgba(BLUE, 0.28)}` : `1px solid ${hovered && isInteractive ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.06)'}`,
        background: active ? hexToRgba(BLUE, 0.08) : hovered && isInteractive ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)',
        cursor: isInteractive ? 'pointer' : 'default',
        fontFamily: 'inherit',
        transition: 'border-color 0.15s, background 0.15s',
        flex: '1 1 0',
        minWidth: 0,
        outline: 'none',
      }}
    >
      <span style={{ color: active ? BLUE : GLASS.textFaint, display: 'flex', alignItems: 'center' }}>{icon}</span>
      <span style={{ fontSize: '0.62rem', fontWeight: 700, color: active ? BLUE : GLASS.text, whiteSpace: 'nowrap', letterSpacing: '0.01em', lineHeight: 1.2 }}>{value}</span>
      <span style={{ fontSize: '0.55rem', fontWeight: 600, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.08em', whiteSpace: 'nowrap' }}>{label}</span>
      {hint && <span style={{ fontSize: '0.5rem', color: active ? hexToRgba(BLUE, 0.5) : 'rgba(148,163,184,0.4)', fontStyle: 'italic', marginTop: 1, whiteSpace: 'nowrap' }}>{hint}</span>}
    </button>
  );
}

// ── CallerIdPill ─────────────────────────────────────────────────────────────

function CallerIdPill({ entry, canEdit }: { entry: RcfEntry; canEdit: boolean }) {
  const { passthrough, isPending, toggle } = useCallerIdToggle(entry);
  return (
    <StatPill
      icon={
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" style={{ width: 13, height: 13 }}>
          <path d="M2 3a1.5 1.5 0 0 1 1.5-1.5h1.75a.5.5 0 0 1 .47.33l1 3a.5.5 0 0 1-.25.61L5 6.2a7.5 7.5 0 0 0 2.8 2.8l1.37-1.5a.5.5 0 0 1 .61-.25l3 1a.5.5 0 0 1 .32.47V10.5A1.5 1.5 0 0 1 11.5 12H11C5.477 12 1 7.523 1 2V2" />
        </svg>
      }
      label="Caller ID"
      value={passthrough ? 'Pass-thru' : 'Show DID'}
      hint={canEdit ? 'click to toggle' : undefined}
      active={passthrough}
      clickable={canEdit && !isPending}
      onClick={() => { if (canEdit && !isPending) toggle(); }}
    />
  );
}

// ── MaxChannelsPill ──────────────────────────────────────────────────────────

function MaxChannelsPill({ entry, canEdit }: { entry: RcfEntry; canEdit: boolean }) {
  const ed = useMaxChannelsEditor(entry);

  if (ed.editing && canEdit) {
    return (
      <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '6px 8px', borderRadius: 10, border: `1px solid ${hexToRgba(BLUE, 0.35)}`, background: hexToRgba(BLUE, 0.06) }}>
        <input
          type="number"
          min={0}
          max={100}
          autoFocus
          value={ed.value}
          onChange={(e) => ed.setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); ed.commit(); }
            if (e.key === 'Escape') ed.cancel();
          }}
          onBlur={ed.cancel}
          style={{ width: 50, textAlign: 'center', fontSize: '0.72rem', fontWeight: 700, color: BLUE, background: 'rgba(15,17,23,0.85)', border: `1px solid ${hexToRgba(BLUE, 0.35)}`, borderRadius: 5, padding: '3px 4px', outline: 'none', fontFamily: 'inherit' }}
        />
        <span style={{ fontSize: '0.5rem', color: hexToRgba(BLUE, 0.5), fontStyle: 'italic' }}>0 = no limit</span>
      </div>
    );
  }

  return (
    <StatPill
      icon={
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" style={{ width: 13, height: 13 }}>
          <path d="M1 4h12M1 7h12M1 10h12" />
        </svg>
      }
      label="Max Calls"
      value={entry.max_channels === 0 ? 'No Limit' : String(entry.max_channels)}
      hint={canEdit ? 'click to edit' : undefined}
      active={entry.max_channels > 0}
      clickable={canEdit && !ed.isPending}
      onClick={() => { if (canEdit) ed.begin(); }}
    />
  );
}

// ── RcfNameField ─────────────────────────────────────────────────────────────

function RcfNameField({ entry, canEdit }: { entry: RcfEntry; canEdit: boolean }) {
  const ed = useNameEditor(entry);

  if (!canEdit) {
    if (!entry.name) return null;
    return (
      <span style={{ fontSize: '0.70rem', fontWeight: 600, color: '#64748b', letterSpacing: '0.03em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>{entry.name}</span>
    );
  }

  if (ed.editing) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <input
          type="text"
          value={ed.value}
          autoFocus
          placeholder="Add label..."
          onChange={(e) => ed.setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); ed.save(); }
            if (e.key === 'Escape') ed.cancel();
          }}
          onBlur={ed.cancel}
          disabled={ed.isPending}
          style={{ flex: 1, fontSize: '0.70rem', fontWeight: 600, color: GLASS.textMuted, background: 'rgba(15,17,23,0.85)', border: `1px solid ${hexToRgba(BLUE, 0.40)}`, borderRadius: 5, outline: 'none', padding: '3px 7px', fontFamily: 'inherit', opacity: ed.isPending ? 0.5 : 1, letterSpacing: '0.03em' }}
        />
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); ed.save(); }}
          disabled={ed.isPending}
          style={{ fontSize: '0.60rem', fontWeight: 700, padding: '3px 9px', borderRadius: 4, border: 'none', background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)', color: '#fff', cursor: ed.isPending ? 'not-allowed' : 'pointer', lineHeight: 1, opacity: ed.isPending ? 0.6 : 1, flexShrink: 0 }}
        >
          {ed.isPending ? '…' : 'OK'}
        </button>
      </div>
    );
  }

  const hasName = !!ed.value.trim();
  return (
    <span
      onClick={ed.begin}
      title="Click to edit this label"
      style={{ fontSize: '0.70rem', fontWeight: 600, color: hasName ? '#64748b' : '#334155', fontStyle: hasName ? 'normal' : 'italic', letterSpacing: '0.03em', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-flex', alignItems: 'center', gap: 5, paddingBottom: 1, borderBottom: `1px dashed ${hexToRgba(BLUE, 0.18)}`, transition: 'color 0.15s, border-color 0.15s' }}
    >
      {hasName ? ed.value.trim() : 'Name this line — click to edit'}
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" style={{ width: 10, height: 10, color: hexToRgba(BLUE, 0.4), flexShrink: 0 }}>
        <path d="M8.5 1.5l2 2L4 10H2v-2L8.5 1.5z" />
      </svg>
    </span>
  );
}

// ── RcfCard ──────────────────────────────────────────────────────────────────

export function RcfCard({ entry, pendingValue, onPendingChange }: RcfCardProps) {
  // ALL hooks unconditionally at the top (React #310)
  const { user } = useAuth();
  const { enabled, isPending: enablePending, toggle: toggleEnabled } = useEnableToggle(entry);
  const canEdit = user?.role !== 'readonly';

  // Enabled lines glow in the app accent; disabled lines fade to faint.
  const accent = enabled ? BLUE : GLASS.textFaint;

  return (
    <GlassCard accent={accent}>
      <div style={{ padding: '20px 22px 18px', display: 'flex', flexDirection: 'column' }}>
        {/* Row 1: status + customer chip + enable toggle */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <GlassChip label={enablePending ? '…' : enabled ? 'Active' : 'Disabled'} color={enabled ? BLUE : GLASS.danger} dot />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {entry.customer_name && user?.role === 'admin' && <GlassChip label={entry.customer_name} color={GLASS.cyan} />}
            <BlueToggle
              checked={enabled}
              disabled={!canEdit}
              pending={enablePending}
              onChange={() => { if (canEdit && !enablePending) toggleEnabled(); }}
              title={canEdit ? (enabled ? 'Click to disable' : 'Click to enable') : undefined}
            />
          </div>
        </div>

        {/* Row 2: optional label + source DID */}
        <div style={{ marginBottom: 14, textAlign: 'center' }}>
          <div style={{ marginBottom: 4, display: 'flex', justifyContent: 'center' }}>
            <RcfNameField entry={entry} canEdit={canEdit} />
          </div>
          <div style={{ fontSize: '1.45rem', fontWeight: 800, fontFamily: MONO, letterSpacing: '0.01em', color: GLASS.text, lineHeight: 1.15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textShadow: '0 1px 12px rgba(0,0,0,0.5)' }}>
            {fmt(entry.did)}
          </div>
        </div>

        {/* Row 3: forwards-to divider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <div style={{ flex: 1, height: 1, background: `linear-gradient(90deg, transparent, ${hexToRgba(BLUE, 0.22)})` }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 20, background: hexToRgba(BLUE, 0.06), border: `1px solid ${hexToRgba(BLUE, 0.14)}`, flexShrink: 0 }}>
            <svg viewBox="0 0 18 10" fill="none" style={{ width: 18, height: 10 }}>
              <line x1="1" y1="5" x2="14" y2="5" stroke={BLUE} strokeWidth={1.5} strokeLinecap="round" />
              <path d="M11 2l3 3-3 3" stroke={BLUE} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
            <span style={{ fontSize: '0.55rem', fontWeight: 700, color: hexToRgba(BLUE, 0.7), textTransform: 'uppercase', letterSpacing: '0.12em', whiteSpace: 'nowrap' }}>Forwards to</span>
          </div>
          <div style={{ flex: 1, height: 1, background: `linear-gradient(90deg, ${hexToRgba(BLUE, 0.22)}, transparent)` }} />
        </div>

        {/* Row 4: forwarding destination */}
        <div style={{ marginBottom: 20, textAlign: 'center' }}>
          <ForwardToDisplay entry={entry} pendingValue={pendingValue} canEdit={canEdit} onPendingChange={onPendingChange} />
        </div>

        {/* Row 5: settings stat pills */}
        <div style={{ display: 'flex', gap: 6, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          <CallerIdPill entry={entry} canEdit={canEdit} />
          <StatPill
            icon={
              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" style={{ width: 13, height: 13 }}>
                <circle cx="7" cy="7" r="5.5" />
                <path d="M7 4v3l1.8 1.8" />
              </svg>
            }
            label="Timeout"
            value={entry.ring_timeout != null ? `${entry.ring_timeout}s` : '30s'}
          />
          {/* Max channels — read-only on the customer RCF page; editable only on the admin account page */}
          <MaxChannelsPill entry={entry} canEdit={false} />
        </div>
      </div>
    </GlassCard>
  );
}
