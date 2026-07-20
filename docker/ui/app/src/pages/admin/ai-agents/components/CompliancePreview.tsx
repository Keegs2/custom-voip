/**
 * CompliancePreview — the live, in-form boundary banner. It reflects the CURRENT
 * (possibly unsaved) provider selection using the client-side estimate, so it is
 * explicitly labelled "estimated"; the authoritative signal is verified from the
 * runtime-config after saving (surfaced in the Runtime drawer + edit banner).
 */

import { ShieldCheck, Cloud } from 'lucide-react';
import { complianceBanner, complianceIcon, complianceTitle, complianceBody } from '../styles';
import type { ComplianceEstimate } from '../types';

export function CompliancePreview({ estimate }: { estimate: ComplianceEstimate }) {
  const inVpc = estimate.allSelfHosted;
  return (
    <div style={complianceBanner(inVpc)}>
      <div style={complianceIcon(inVpc)}>{inVpc ? <ShieldCheck size={18} /> : <Cloud size={18} />}</div>
      <div>
        <div style={complianceTitle(inVpc)}>
          {inVpc ? 'In-boundary — no data leaves your VPC (estimated)' : 'Cloud provider selected — data leaves the boundary (estimated)'}
        </div>
        <div style={complianceBody}>
          {inVpc
            ? 'Every layer resolves to a self-hosted provider on an internal address. The exact boundary status is verified from the resolved runtime config after you save.'
            : `These layers egress to a cloud provider: ${estimate.cloudLayers.join(', ')}. Point them at an internal Whisper / vLLM / Piper endpoint to keep call audio and transcripts in-VPC.`}
        </div>
      </div>
    </div>
  );
}
