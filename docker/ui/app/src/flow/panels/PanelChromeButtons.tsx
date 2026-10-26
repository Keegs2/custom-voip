/**
 * PanelChromeButtons — the right panel's own controls, in the head of
 * whatever panel occupies the column: widen ⇄ narrow, and (checklist only)
 * hide it into the rail. Renders nothing outside the desktop builder.
 */
import { FoldHorizontal, PanelRightClose, UnfoldHorizontal } from 'lucide-react';
import { usePanelChrome } from './panelChrome';

export function PanelChromeButtons() {
  const chrome = usePanelChrome();
  if (!chrome) return null;
  return (
    <span className="ivr-chrome">
      <button
        type="button"
        className="vm-iconbtn ivr-chrome-btn"
        aria-pressed={chrome.wide}
        aria-label={chrome.wide ? 'Make the panel narrower' : 'Make the panel wider'}
        title={chrome.wide ? 'Narrower panel' : 'Wider panel'}
        onClick={chrome.toggleWide}
      >
        {chrome.wide ? <FoldHorizontal size={15} aria-hidden="true" /> : <UnfoldHorizontal size={15} aria-hidden="true" />}
      </button>
      {chrome.hide && (
        <button
          type="button"
          className="vm-iconbtn ivr-chrome-btn"
          aria-expanded="true"
          aria-controls={chrome.panelId}
          aria-label="Hide the checklist"
          title="Hide the checklist — more room for the canvas"
          onClick={chrome.hide}
        >
          <PanelRightClose size={15} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
