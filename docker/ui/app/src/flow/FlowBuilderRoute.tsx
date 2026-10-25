/**
 * FlowBuilderRoute — /ivr/flows/:flowId, the lazily loaded builder chunk
 * (React Flow + the builder; nothing here reaches the main bundle).
 * Loads the flow (and the account summary for its limits), then mounts
 * FlowBuilder keyed by the flow's id. Not-entitled / missing flows go back
 * to /ivr with an explanation.
 */
import { Link, Navigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { Spinner } from '../components/ui/Spinner';
import { useIvrWorkspace } from '../pages/ivr/IvrContext';
import { isIvrError, ivrErrorText, useFlow as useFlowQuery, useIvrSummary } from '../pages/ivr/ivrData';
import { FlowBuilder } from './FlowBuilder';
import '../styles/ivr-builder.css';

export function FlowBuilderRoute({ flowId }: { flowId: number }) {
  // ── Hooks first (React #310) ──
  const ws = useIvrWorkspace();
  const flow = useFlowQuery(ws.scope, flowId);
  const summary = useIvrSummary(ws.scope);

  if (isIvrError(flow.error, 403, 'ivr_not_enabled') || summary.data?.enabled === false) {
    return <Navigate to={ws.href('/ivr')} replace />;
  }
  if (flow.isLoading) {
    return (
      <div className="ivr-route-fallback" role="status">
        <Spinner /> Opening the flow…
      </div>
    );
  }
  if (flow.isError || !flow.data) {
    const missing = flow.error instanceof ApiError && flow.error.status === 404;
    return (
      <div className="dl-shell">
        <div className="dl-banner dl-banner-err ivr-gap" role="alert">
          {missing ? 'That flow doesn’t exist any more.' : ivrErrorText(flow.error, 'The flow couldn’t be opened.')}{' '}
          <Link className="vm-linkbtn" to={ws.href('/ivr')}>
            Back to IVR
          </Link>
        </div>
      </div>
    );
  }
  return <FlowBuilder key={flow.data.id} flow={flow.data} maxBlocks={summary.data?.limits.max_blocks} />;
}
