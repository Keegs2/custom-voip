/**
 * Shared presentational field primitives for the Account page: a labelled group
 * wrapper, a read-only display value, and a glass text input. All are dumb —
 * state/callbacks come from the parent. (This file exports components only, so
 * react-refresh stays happy.)
 *
 * React #310: the input's focus hook sits at the very top of its component.
 */

import { useState, type ReactNode } from 'react';
import { fieldGroup, fieldLabel, readOnlyValue, textInput } from '../styles';

export function LabeledField({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div style={fieldGroup}>
      <label htmlFor={htmlFor} style={fieldLabel}>
        {label}
      </label>
      {children}
    </div>
  );
}

export function ReadOnlyValue({ value }: { value: string }) {
  return <div style={readOnlyValue}>{value}</div>;
}

interface GlassTextInputProps {
  id: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  disabled?: boolean;
}

export function GlassTextInput({ id, type = 'text', value, onChange, placeholder, autoComplete, disabled }: GlassTextInputProps) {
  // ALL hooks first (React #310) — focus is purely visual.
  const [focused, setFocused] = useState(false);

  return (
    <input
      id={id}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      placeholder={placeholder}
      autoComplete={autoComplete}
      disabled={disabled}
      style={textInput(focused, Boolean(disabled))}
    />
  );
}
