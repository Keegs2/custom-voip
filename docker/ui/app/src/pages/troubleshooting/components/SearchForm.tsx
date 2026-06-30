/**
 * SearchForm — the From / To / Call-ID + date-range search controls inside a
 * frosted glass panel. Fully controlled: all values + handlers come from the
 * page. Only per-field focus (visual) and the Clear-button hover are local.
 */

import { useState, type KeyboardEvent } from 'react';
import { GlassPanel } from '../../../components/glass/GlassCard';
import { Spinner } from '../../../components/ui/Spinner';
import {
  MONO,
  formGrid3,
  formGrid2,
  labelStyle,
  inputStyle,
  validationError as validationErrorStyle,
  formActions,
  primaryBtn,
  ghostBtn,
} from '../styles';
import { IconSearch, IconAlert } from './icons';

interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
  type?: 'text' | 'datetime-local';
  mono?: boolean;
}

function Field({ id, label, value, onChange, onKeyDown, placeholder, type = 'text', mono = false }: FieldProps) {
  // Focus state is purely visual — kept local so the page never re-renders on it.
  const [focused, setFocused] = useState(false);
  return (
    <div>
      <label htmlFor={id} style={labelStyle}>
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          ...inputStyle(focused),
          ...(mono ? { fontFamily: MONO, fontSize: '0.8rem' } : {}),
          ...(type === 'datetime-local' ? { colorScheme: 'dark' } : {}),
        }}
      />
    </div>
  );
}

interface SearchFormProps {
  fromUser: string;
  toUser: string;
  callId: string;
  startTime: string;
  endTime: string;
  validationError: string | null;
  isLoading: boolean;
  onFromUser: (v: string) => void;
  onToUser: (v: string) => void;
  onCallId: (v: string) => void;
  onStartTime: (v: string) => void;
  onEndTime: (v: string) => void;
  onSearch: () => void;
  onClear: () => void;
}

export function SearchForm({
  fromUser,
  toUser,
  callId,
  startTime,
  endTime,
  validationError,
  isLoading,
  onFromUser,
  onToUser,
  onCallId,
  onStartTime,
  onEndTime,
  onSearch,
  onClear,
}: SearchFormProps) {
  const [clearHovered, setClearHovered] = useState(false);

  // Submit on Enter from any text field.
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') onSearch();
  };

  return (
    <GlassPanel padding="22px 24px">
      {/* Row 1: From, To, Call-ID */}
      <div style={formGrid3}>
        <Field id="sip-from" label="From" value={fromUser} onChange={onFromUser} onKeyDown={handleKeyDown} placeholder="Caller number or SIP user" />
        <Field id="sip-to" label="To" value={toUser} onChange={onToUser} onKeyDown={handleKeyDown} placeholder="Destination number" />
        <Field id="sip-callid" label="Call-ID" value={callId} onChange={onCallId} onKeyDown={handleKeyDown} placeholder="SIP Call-ID" mono />
      </div>

      {/* Row 2: Date range */}
      <div style={formGrid2}>
        <Field id="sip-start" label="Date Range — From" value={startTime} onChange={onStartTime} type="datetime-local" />
        <Field id="sip-end" label="Date Range — To" value={endTime} onChange={onEndTime} type="datetime-local" />
      </div>

      {validationError && (
        <p style={validationErrorStyle}>
          <IconAlert size={14} />
          {validationError}
        </p>
      )}

      <div style={formActions}>
        <button type="button" onClick={onSearch} disabled={isLoading} style={primaryBtn(isLoading)}>
          {isLoading ? <Spinner /> : <IconSearch />}
          {isLoading ? 'Searching…' : 'Search'}
        </button>

        <button
          type="button"
          onClick={onClear}
          disabled={isLoading}
          onMouseEnter={() => setClearHovered(true)}
          onMouseLeave={() => setClearHovered(false)}
          style={ghostBtn(isLoading, clearHovered)}
        >
          Clear
        </button>
      </div>
    </GlassPanel>
  );
}
