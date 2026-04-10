/**
 * IVR Builder — Configuration Panel
 *
 * Right sidebar shown when a node is selected. Renders verb-specific form fields
 * and a "Delete Node" button at the bottom.
 */

import { cn } from '../../utils/cn';
import { verbColor, verbTextClass, type BuilderNode } from './ivrUtils';
import type { IvrAction } from './useIvrFlow';

interface IvrConfigPanelProps {
  node: BuilderNode | null;
  dispatch: React.Dispatch<IvrAction>;
}

// ---------------------------------------------------------------------------
// Shared form field components
// ---------------------------------------------------------------------------

interface LabeledFieldProps {
  label: string;
  children: React.ReactNode;
  hint?: string;
}

function LabeledField({ label, children, hint }: LabeledFieldProps) {
  return (
    <div className="flex flex-col gap-1.5 mb-4">
      <label className="text-[0.68rem] font-bold uppercase tracking-[0.8px] text-[#718096]">
        {label}
      </label>
      {children}
      {hint && (
        <p className="text-[0.68rem] text-[#4a5568] leading-relaxed">{hint}</p>
      )}
    </div>
  );
}

const inputClass = cn(
  'w-full px-3 py-2 rounded-lg text-sm text-[#e2e8f0] bg-[#0d0f15]',
  'border border-[rgba(42,47,69,0.6)] outline-none transition-[border-color,box-shadow] duration-150',
  'focus:border-[#06b6d4] focus:shadow-[0_0_0_3px_rgba(6,182,212,0.12)]',
  'placeholder:text-[#3d4460]',
);

// ---------------------------------------------------------------------------
// Verb-specific form renders
// ---------------------------------------------------------------------------

function SayFields({ node, dispatch }: { node: BuilderNode; dispatch: React.Dispatch<IvrAction> }) {
  return (
    <>
      <LabeledField label="Text to speak">
        <textarea
          className={cn(inputClass, 'resize-y min-h-[90px]')}
          value={node.config.text ?? ''}
          placeholder="Enter the text to be spoken..."
          rows={4}
          onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', nodeId: node.id, key: 'text', value: e.target.value })}
        />
      </LabeledField>
      <LabeledField label="Voice">
        <select
          className={inputClass}
          value={node.config.voice ?? 'woman'}
          onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', nodeId: node.id, key: 'voice', value: e.target.value })}
        >
          <option value="woman">Woman</option>
          <option value="man">Man</option>
        </select>
      </LabeledField>
    </>
  );
}

function PlayFields({ node, dispatch }: { node: BuilderNode; dispatch: React.Dispatch<IvrAction> }) {
  return (
    <LabeledField label="Audio URL">
      <input
        type="url"
        className={inputClass}
        value={node.config.url ?? ''}
        placeholder="https://example.com/audio.mp3"
        onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', nodeId: node.id, key: 'url', value: e.target.value })}
      />
    </LabeledField>
  );
}

function GatherFields({ node, dispatch }: { node: BuilderNode; dispatch: React.Dispatch<IvrAction> }) {
  return (
    <>
      <LabeledField label="Max Digits">
        <input
          type="number"
          className={inputClass}
          min={1}
          max={20}
          value={node.config.numDigits ?? '1'}
          onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', nodeId: node.id, key: 'numDigits', value: e.target.value })}
        />
      </LabeledField>
      <LabeledField label="Timeout (seconds)">
        <input
          type="number"
          className={inputClass}
          min={1}
          max={60}
          value={node.config.timeout ?? '5'}
          onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', nodeId: node.id, key: 'timeout', value: e.target.value })}
        />
      </LabeledField>
      <p className="text-[0.72rem] text-[#4a5568] leading-relaxed -mt-2 mb-4">
        Use the branch tabs beneath the node to define what happens for each digit.
        Drop Say/Play verbs into the prompt area to play audio while waiting.
      </p>
    </>
  );
}

function DialFields({ node, dispatch }: { node: BuilderNode; dispatch: React.Dispatch<IvrAction> }) {
  return (
    <>
      <LabeledField label="Phone Number">
        <input
          type="tel"
          className={inputClass}
          value={node.config.number ?? ''}
          placeholder="+1XXXXXXXXXX"
          onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', nodeId: node.id, key: 'number', value: e.target.value })}
        />
      </LabeledField>
      <LabeledField label="Caller ID (optional)">
        <input
          type="tel"
          className={inputClass}
          value={node.config.callerId ?? ''}
          placeholder="+1XXXXXXXXXX"
          onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', nodeId: node.id, key: 'callerId', value: e.target.value })}
        />
      </LabeledField>
      <LabeledField label="Timeout (seconds)">
        <input
          type="number"
          className={inputClass}
          min={5}
          max={120}
          value={node.config.timeout ?? '30'}
          onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', nodeId: node.id, key: 'timeout', value: e.target.value })}
        />
      </LabeledField>
    </>
  );
}

function PauseFields({ node, dispatch }: { node: BuilderNode; dispatch: React.Dispatch<IvrAction> }) {
  return (
    <LabeledField label="Duration (seconds)">
      <input
        type="number"
        className={inputClass}
        min={1}
        max={120}
        value={node.config.duration ?? '1'}
        onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', nodeId: node.id, key: 'duration', value: e.target.value })}
      />
    </LabeledField>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

const asidePanelStyle = {
  width: '300px',
  flexShrink: 0,
  background: 'linear-gradient(180deg, #13151d 0%, #0f1117 100%)',
  borderLeft: '1px solid rgba(42,47,69,0.6)',
} as const;

export function IvrConfigPanel({ node, dispatch }: IvrConfigPanelProps) {
  if (!node) {
    return (
      <aside
        className="flex flex-col overflow-y-auto"
        style={asidePanelStyle}
        aria-label="Node configuration panel"
      >
        <div className="flex items-center justify-center h-full p-6 text-center">
          <div>
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center mx-auto mb-4"
              style={{
                background: 'rgba(42,47,69,0.35)',
                border: '1px solid rgba(42,47,69,0.5)',
              }}
              aria-hidden="true"
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ width: 20, height: 20, color: '#4a5568' }}>
                <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <p className="text-[#4a5568] text-sm font-medium">No node selected</p>
            <p className="text-[#3d4460] text-xs mt-1 leading-relaxed">
              Click a node on the canvas to configure it.
            </p>
          </div>
        </div>
      </aside>
    );
  }

  const accentColor = verbColor(node.type);
  const textClass = verbTextClass(node.type);

  return (
    <aside
      className="flex flex-col overflow-y-auto"
      style={asidePanelStyle}
      aria-label="Node configuration panel"
    >
      {/* Panel header */}
      <div
        className="flex items-center gap-2.5 px-5 pt-5 pb-4"
        style={{ borderBottom: '1px solid rgba(42,47,69,0.5)' }}
      >
        <div
          className="w-[3px] h-5 rounded-full flex-shrink-0"
          style={{ backgroundColor: accentColor, boxShadow: `0 0 6px ${accentColor}60` }}
          aria-hidden="true"
        />
        <h2 className={cn('text-[0.7rem] font-bold uppercase tracking-[1px]', textClass)}>
          {node.type} — Config
        </h2>
        <button
          type="button"
          className="ml-auto w-6 h-6 flex items-center justify-center rounded-md text-[#4a5568] hover:text-[#e2e8f0] hover:bg-[rgba(42,47,69,0.4)] transition-all duration-150 text-sm leading-none"
          aria-label="Deselect node"
          onClick={() => dispatch({ type: 'SELECT_NODE', nodeId: null })}
        >
          ✕
        </button>
      </div>

      {/* Form fields */}
      <div className="flex-1 px-5 pt-5 pb-2">
        {node.type === 'say'    && <SayFields    node={node} dispatch={dispatch} />}
        {node.type === 'play'   && <PlayFields   node={node} dispatch={dispatch} />}
        {node.type === 'gather' && <GatherFields node={node} dispatch={dispatch} />}
        {node.type === 'dial'   && <DialFields   node={node} dispatch={dispatch} />}
        {node.type === 'hangup' && (
          <p className="text-[#718096] text-sm leading-relaxed">
            This verb ends the call immediately. No configuration required.
          </p>
        )}
        {node.type === 'pause' && <PauseFields node={node} dispatch={dispatch} />}
      </div>

      {/* Delete button */}
      <div
        className="px-5 pb-5 pt-3"
        style={{ borderTop: '1px solid rgba(42,47,69,0.5)' }}
      >
        <button
          type="button"
          className={cn(
            'w-full px-4 py-2.5 rounded-lg text-sm font-semibold',
            'bg-[rgba(127,29,29,0.5)] text-[#fca5a5] border border-red-500/25',
            'hover:bg-[rgba(153,27,27,0.7)] hover:shadow-[0_0_14px_rgba(239,68,68,0.15)]',
            'transition-all duration-150',
          )}
          onClick={() => dispatch({ type: 'REMOVE_NODE', nodeId: node.id })}
        >
          Delete Node
        </button>
      </div>
    </aside>
  );
}
