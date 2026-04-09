/**
 * IVR Builder — XML Preview Modal
 *
 * Shows the generated TwiML XML with syntax highlighting.
 * Includes a copy-to-clipboard button.
 */

import { useState, useCallback } from 'react';
import { Modal } from '../../components/ui/Modal';
import { highlightXml } from './ivrUtils';

interface IvrXmlModalProps {
  open: boolean;
  xml: string;
  onClose: () => void;
}

export function IvrXmlModal({ open, xml, onClose }: IvrXmlModalProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(xml);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API not available — user can select text manually
    }
  }, [xml]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Generated TwiML XML"
      maxWidth="max-w-2xl"
      footer={
        <>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-[#1e2130] border border-[#2a2f45] text-[#e2e8f0] hover:border-[#3d4460] transition-colors"
          >
            {copied ? '✓ Copied!' : 'Copy to clipboard'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-[#3b82f6] text-white hover:bg-[#2563eb] transition-colors"
          >
            Close
          </button>
        </>
      }
    >
      {/* XML block with syntax highlighting */}
      <pre
        className="text-xs leading-relaxed font-mono overflow-x-auto rounded-lg p-4 bg-[#0d0f15] border border-[#2a2f45]"
        style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        aria-label="Generated XML content"
        // Safe: highlightXml only emits span tags with inline style attributes;
        // all user content is HTML-entity-escaped before adding spans.
        dangerouslySetInnerHTML={{ __html: highlightXml(xml) }}
      />
    </Modal>
  );
}
