import { useState } from 'react';
import { Button } from '../../components/ui/Button';

export function HomerTab() {
  const [iframeError, setIframeError] = useState(false);

  // Homer runs on port 9080 on the same host as the app
  const homerUrl = `http://${window.location.hostname}:9080`;

  return (
    <div className="space-y-4">
      {/* Header bar */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[1rem] font-bold text-[#e2e8f0]">Homer SIP Capture</h2>
          <p className="text-[0.78rem] text-[#718096] mt-0.5">
            Embedded Homer viewer — SIP packet capture and analysis
          </p>
        </div>
        <a
          href={homerUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Button variant="ghost" size="sm">
            Open in New Tab
          </Button>
        </a>
      </div>

      {/* Iframe or fallback */}
      {iframeError ? (
        <div className="flex flex-col items-center justify-center gap-4 py-20 border border-[#2a2f45] rounded-xl text-center">
          <p className="font-semibold text-[#e2e8f0]">Homer is not reachable</p>
          <p className="text-[0.82rem] text-[#718096] max-w-sm">
            The Homer SIP capture interface at{' '}
            <span className="font-mono text-[#93c5fd]">{homerUrl}</span> could not be
            loaded. Verify Homer is running and accessible from your browser.
          </p>
          <a
            href={homerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#3b82f6] text-[0.88rem] hover:underline"
          >
            Try opening directly
          </a>
        </div>
      ) : (
        <iframe
          src={homerUrl}
          title="Homer SIP Capture"
          onError={() => setIframeError(true)}
          style={{
            width: '100%',
            height: 'calc(100vh - 220px)',
            border: 'none',
            background: '#1a1d27',
            borderRadius: '12px',
          }}
        />
      )}
    </div>
  );
}
