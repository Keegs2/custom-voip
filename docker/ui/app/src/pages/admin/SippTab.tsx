/**
 * SippTab — THIN composition page for the Testing (SIPp) admin area. The run
 * lifecycle lives in the useSippRunner feature hook; surfaces are built from the
 * glass kit. SbcDistribution / SippPresetGrid / SippCustomForm / SippHistory are
 * owned/glassified by other areas and composed here as-is.
 *
 * React #310: all hooks sit at the top of useSippRunner, before any return.
 */

import { useSippRunner } from './billing/sipp/hooks';
import { SectionPanel } from './billing/components/SectionPanel';
import { SippResults } from './billing/sipp/components/SippResults';
import { SippPresetGrid } from './SippPresetGrid';
import { SippCustomForm } from './SippCustomForm';
import { SippHistory } from './SippHistory';
import { SbcDistribution } from './SbcDistribution';

export function SippTab() {
  const { isRunning, latestResult, history, runningTimeout, runPreset, runCustom } = useSippRunner();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      {/* Live SBC distribution — operator watches this while running failover tests */}
      <SbcDistribution />

      {/* Preset grid */}
      <SectionPanel
        eyebrow="Load Testing"
        title="SIPp Load Test Presets"
        description="Select a preset to run a pre-configured SIP load test against the platform."
      >
        <SippPresetGrid isRunning={isRunning} onRun={runPreset} />
      </SectionPanel>

      {/* Custom test */}
      <SippCustomForm isRunning={isRunning} onRun={runCustom} />

      {/* Results */}
      <SippResults response={latestResult} isRunning={isRunning} runningTimeout={runningTimeout} />

      {/* History */}
      {history.length > 0 && !isRunning && <SippHistory history={history} />}
    </div>
  );
}
