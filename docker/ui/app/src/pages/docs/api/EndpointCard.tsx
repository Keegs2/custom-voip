/**
 * EndpointCard — one endpoint as an expandable row (kit <Disclosure>, §20):
 * closed it is one line — method chip, path, one-line summary, and an
 * "Edit access" tag on routes read-only users can't call; open it shows the
 * description, who may call it, parameters, the response fields (first 8,
 * then "Show all N fields"), status codes, notes, and the request/response
 * example — itself collapsed by default and mounted on first open.
 *
 * Open state is owned by the page (so the contents list can open a card);
 * React #310: every hook sits at the top of its component.
 */
import { Disclosure, ShowMoreButton, useShowMore } from '../../../components/layout/kit';
import { Callout, CodeBlock } from '../shared';
import { RichText } from './RichText';
import type { EndpointDoc, FieldDoc, HttpMethod, ParamDoc, StatusDoc, TenantRole } from './types';

/** The docs' method chip; `compact` for the contents list. */
export function MethodChip({ method, compact = false }: { method: HttpMethod; compact?: boolean }) {
  return (
    <span className={`dlx-method dlx-method-${method.toLowerCase()}${compact ? ' dxa-method-sm' : ''}`}>{method}</span>
  );
}

const ROLE_WORDS: Record<TenantRole, string> = {
  user: 'user',
  readonly: 'readonly',
};

/** Request + response, side by side where there's room (`.dlx-reqres`). */
function Example({ request, response, responseLabel }: { request: string; response: string; responseLabel?: string }) {
  return (
    <div className="dlx-reqres dxa-reqres">
      <CodeBlock code={request} label="request" />
      <CodeBlock code={response} label={responseLabel ?? 'response'} />
    </div>
  );
}

const IN_WORDS: Record<ParamDoc['in'], string> = {
  path: 'path',
  query: 'query',
  body: 'body',
};

function ParamTable({ params }: { params: readonly ParamDoc[] }) {
  // ALL hooks unconditionally at the top (React #310).
  const more = useShowMore(params, rowLimit(params.length));
  return (
    <>
      <div className="dlx-table-wrap dxa-table-wrap">
        <table className="dlx-table dxa-table">
          <thead>
            <tr>
              <th className="dl-th" scope="col">
                Parameter
              </th>
              <th className="dl-th" scope="col">
                Description
              </th>
            </tr>
          </thead>
          <tbody id={more.listId}>
            {more.visible.map((p) => (
              <tr key={`${p.in}:${p.name}`}>
                <td className="dxa-td-name">
                  <code className="dlx-td-code">{p.name}</code>
                  <span className="dxa-td-meta">
                    {p.type} · {IN_WORDS[p.in]}
                    {p.required && <span className="dxa-req">required</span>}
                  </span>
                </td>
                <td>
                  <RichText text={p.description} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more.needed && (
        <div className="dxa-more">
          <ShowMoreButton {...more.buttonProps} noun="parameters" />
        </div>
      )}
    </>
  );
}

/**
 * Rows shown before "Show all N" (§20.3: about 8). A table only collapses
 * when that hides at least three rows — hiding one or two helps no one.
 */
function rowLimit(total: number): number {
  return total > 10 ? 8 : Number.POSITIVE_INFINITY;
}

function FieldTable({ fields }: { fields: readonly FieldDoc[] }) {
  // ALL hooks unconditionally at the top (React #310).
  const more = useShowMore(fields, rowLimit(fields.length));
  return (
    <>
      <div className="dlx-table-wrap dxa-table-wrap">
        <table className="dlx-table dxa-table">
          <thead>
            <tr>
              <th className="dl-th" scope="col">
                Field
              </th>
              <th className="dl-th" scope="col">
                Description
              </th>
            </tr>
          </thead>
          <tbody id={more.listId}>
            {more.visible.map((f) => (
              <tr key={f.name}>
                <td className="dxa-td-name">
                  <code className="dlx-td-code">{f.name}</code>
                  <span className="dxa-td-meta">{f.type}</span>
                </td>
                <td>
                  <RichText text={f.description} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more.needed && (
        <div className="dxa-more">
          <ShowMoreButton {...more.buttonProps} noun="fields" />
        </div>
      )}
    </>
  );
}

function StatusTable({ statuses }: { statuses: readonly StatusDoc[] }) {
  return (
    <div className="dlx-table-wrap dxa-table-wrap">
      <table className="dlx-table dxa-table dxa-table-status">
        <thead>
          <tr>
            <th className="dl-th" scope="col">
              Status
            </th>
            <th className="dl-th" scope="col">
              When
            </th>
          </tr>
        </thead>
        <tbody>
          {statuses.map((s) => (
            <tr key={`${s.code}:${s.when}`}>
              <td className="dxa-td-name">
                <code className={`dxa-status dxa-status-${Math.floor(s.code / 100)}xx`}>{s.code}</code>
              </td>
              <td>
                <RichText text={s.when} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface EndpointCardProps {
  ep: EndpointDoc;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EndpointCard({ ep, open, onOpenChange }: EndpointCardProps) {
  const writeOnly = !ep.roles.includes('readonly');
  return (
    <Disclosure
      id={`api-${ep.id}`}
      variant="row"
      headingLevel={4}
      className="dxa-ep"
      contentClassName="dxa-ep-body"
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span className="dxa-ep-title">
          <MethodChip method={ep.method} />
          <code className="dxa-ep-path">{ep.path}</code>
        </span>
      }
      badge={
        writeOnly ? (
          <span className="dlx8-tag-admin" title="Needs the user role — read-only users can’t call it">
            Edit access
          </span>
        ) : undefined
      }
      summary={<RichText text={ep.summary} />}
    >
      {ep.description?.map((para) => (
        <p key={para} className="dlx-p dxa-p">
          <RichText text={para} />
        </p>
      ))}

      <dl className="dxa-facts">
        <dt>Who can call it</dt>
        <dd>
          {ep.roles.map((r) => (
            <span key={r} className="dxa-role">
              {ROLE_WORDS[r]}
            </span>
          ))}
        </dd>
      </dl>

      {ep.params && ep.params.length > 0 && (
        <>
          <h5 className="dxa-h5">Parameters</h5>
          <ParamTable params={ep.params} />
        </>
      )}

      {(ep.returns || (ep.fields && ep.fields.length > 0)) && (
        <>
          <h5 className="dxa-h5">Response</h5>
          {ep.returns && (
            <p className="dxa-returns">
              <RichText text={ep.returns} />
            </p>
          )}
          {ep.fields && ep.fields.length > 0 && <FieldTable fields={ep.fields} />}
        </>
      )}

      <h5 className="dxa-h5">Status codes</h5>
      <StatusTable statuses={ep.statuses} />

      {ep.notes?.map((n) => (
        <Callout key={n}>
          <RichText text={n} />
        </Callout>
      ))}

      {ep.example && (
        <Disclosure variant="bare" headingLevel={5} title="Example request and response" lazy className="dxa-example">
          <Example
            request={ep.example.request}
            response={ep.example.response}
            responseLabel={ep.example.responseLabel}
          />
        </Disclosure>
      )}
    </Disclosure>
  );
}
