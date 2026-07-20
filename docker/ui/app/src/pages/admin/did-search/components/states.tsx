/**
 * Shared table-state cells + a glass spinner for the DID feature. Loading and
 * empty states reuse the same centered, faint-text padding so every tab reads
 * consistently.
 */

import { spinner, statePad } from '../styles';

/** A small glass spinner (accent ring with a spinning highlight). */
export function Spinner({ size }: { size?: number }) {
  return <span style={spinner(undefined, size)} />;
}

/** A full-width table-body row showing the loading spinner. */
export function LoadingRow({ colSpan }: { colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} style={statePad}>
        <Spinner size={20} />
      </td>
    </tr>
  );
}

/** A full-width table-body row showing an empty-state message. */
export function EmptyRow({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <tr>
      <td colSpan={colSpan} style={statePad}>
        {message}
      </td>
    </tr>
  );
}
