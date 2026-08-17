/**
 * ScenarioCard — one big, room-legible trigger the presenter clicks to fire a
 * demo scenario. Carries an icon, title, one-line "what you'll see" caption,
 * a busy spinner while running, and the last-result summary pinned to the
 * card bottom so the outcome stays on stage after the click.
 *
 * Presentational: the click, busy state, and result come from the parent.
 */

import type { ReactNode } from 'react';
import { Spinner } from '../../../../components/ui/Spinner';
import type { ScenarioResult } from '../hooks';

export type ScenarioTone = 'azure' | 'green' | 'teal' | 'cyan' | 'amber' | 'red' | 'slate';

interface ScenarioCardProps {
  title: string;
  caption: string;
  icon: ReactNode;
  tone: ScenarioTone;
  running: boolean;
  disabled: boolean;
  result?: ScenarioResult;
  onClick: () => void;
}

export function ScenarioCard({
  title,
  caption,
  icon,
  tone,
  running,
  disabled,
  result,
  onClick,
}: ScenarioCardProps) {
  return (
    <button
      type="button"
      className={`dlx9-scen${running ? ' dlx9-scen-running' : ''}`}
      onClick={onClick}
      disabled={disabled || running}
    >
      <div className="dlx9-scen-top">
        <span className={`dlx9-scen-icon dlx9-tone-${tone}`}>{icon}</span>
        {running ? (
          <Spinner size="sm" />
        ) : result ? (
          <span className={result.ok ? 'dl-pill dl-pill-on' : 'dl-pill dl-pill-off'}>
            {result.ok ? 'Ran' : 'Failed'}
          </span>
        ) : null}
      </div>
      <div>
        <div className="dlx9-scen-title">{title}</div>
        <p className="dlx9-scen-caption">{caption}</p>
      </div>
      {result && (
        <div className={`dlx9-scen-result${result.ok ? '' : ' dlx9-scen-result-err'}`}>
          {result.text}
        </div>
      )}
    </button>
  );
}
