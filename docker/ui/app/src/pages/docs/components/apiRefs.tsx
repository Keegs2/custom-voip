/**
 * API-reference building blocks: the HTTP <Endpoint> row, the <ParamTable>
 * parameter reference, and the <NoteCards> behaviour-note grid. All frosted
 * glass, blue-accented, presentational only.
 */

import type { HttpMethod, Param } from '../types';
import {
  endpointRow,
  methodPill,
  endpointPath,
  endpointDesc,
  tableFrame,
  table,
  theadRow,
  th,
  zebra,
  tdNoWrap,
  td,
  codeCell,
  codeCellType,
  requiredPill,
  noteGrid,
  noteCard,
  noteCardTitle,
  noteCardBody,
  DOCS,
} from '../styles';

/** One HTTP endpoint row: method pill + path + description. */
export function Endpoint({
  method,
  path,
  description,
}: {
  method: HttpMethod;
  path: string;
  description: string;
}) {
  return (
    <div style={endpointRow}>
      <span style={methodPill(method)}>{method}</span>
      <code style={endpointPath}>{path}</code>
      <span style={endpointDesc}>{description}</span>
    </div>
  );
}

/** Parameter reference table. */
export function ParamTable({ params }: { params: Param[] }) {
  return (
    <div style={tableFrame}>
      <table style={table}>
        <thead>
          <tr style={theadRow}>
            {['Parameter', 'Type', 'Required', 'Description'].map((h) => (
              <th key={h} style={th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {params.map((p, i) => (
            <tr key={p.name} style={zebra(i)}>
              <td style={tdNoWrap}>
                <code style={codeCell}>{p.name}</code>
              </td>
              <td style={tdNoWrap}>
                <code style={codeCellType}>{p.type}</code>
              </td>
              <td style={tdNoWrap}>
                <span style={requiredPill(p.required)}>{p.required ? 'required' : 'optional'}</span>
              </td>
              <td style={td}>{p.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Behaviour-note card grid. */
export function NoteCards({
  accent = DOCS.accent,
  items,
}: {
  accent?: string;
  items: { title: string; body: string }[];
}) {
  return (
    <div style={noteGrid}>
      {items.map(({ title, body }) => (
        <div key={title} style={noteCard(accent)}>
          <div style={noteCardTitle(accent)}>{title}</div>
          <div style={noteCardBody}>{body}</div>
        </div>
      ))}
    </div>
  );
}
