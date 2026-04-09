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
      <label className="text-[0.72rem] font-semibold uppercase tracking-[0.6px] text-[#718096]">
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
  'w-full px-3 py-2 rounded-lg text-sm text-[#e2e8f0] bg-[#1e2130]',
  'border border-[#2a2f45] outline-none transition-[border-color,box-shadow] duration-150',
  'focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.18)]',
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
          placeholder="+12125551234"
          onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', nodeId: node.id, key: 'number', value: e.target.value })}
        />
      </LabeledField>
      <LabeledField label="Caller ID (optional)">
        <input
          type="tel"
          className={inputClass}
          value={node.config.callerId ?? ''}
          placeholder="+12125550000"
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

export function IvrConfigPanel({ node, dispatch }: IvrConfigPanelProps) {
  if (!node) {
    return (
      <aside
        className="flex flex-col bg-[#1a1d27] border-l border-[#2a2f45] overflow-y-auto"
        style={{ width: '300px', flexShrink: 0 }}
        aria-label="Node configuration panel"
      >
        <div className="flex items-center justify-center h-full p-6 text-center">
          <div>
            <div className="text-2xl mb-3 opacity-30" aria-hidden="true">⚙</div>
            <p className="text-[#4a5568] text-sm">
              Select a node on the canvas to configure it.
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
      className="flex flex-col bg-[#1a1d27] border-l border-[#2a2f45] overflow-y-auto"
      style={{ width: '300px', flexShrink: 0 }}
      aria-label="Node configuration panel"
    >
      {/* Panel header */}
      <div className="flex items-center gap-2 px-4 pt-4 pb-3 border-b border-[#2a2f45]">
        <div
          className="w-[3px] h-5 rounded-full flex-shrink-0"
          style={{ backgroundColor: accentColor }}
          aria-hidden="true"
        />
        <h2 className={cn('text-xs font-bold uppercase tracking-[0.8px]', textClass)}>
          {node.type} — Configuration
        </h2>
        <button
          type="button"
          className="ml-auto text-[#4a5568] hover:text-[#e2e8f0] transition-colors text-sm leading-none"
          aria-label="Deselect node"
          onClick={() => dispatch({ type: 'SELECT_NODE', nodeId: null })}
        >
          ✕
        </button>
      </div>

      {/* Form fields */}
      <div className="flex-1 px-4 pt-4 pb-2">
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
      <div className="px-4 pb-4 pt-2 border-t border-[#2a2f45]">
        <button
          type="button"
          className={cn(
            'w-full px-4 py-2 rounded-lg text-sm font-semibold',
            'bg-[#7f1d1d] text-[#fca5a5] border border-red-500/30',
            'hover:bg-[#991b1b] hover:shadow-[0_0_14px_rgba(239,68,68,0.18)]',
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
