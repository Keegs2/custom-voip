/**
 * Triggers a browser download of a Blob under the given filename — the same
 * anchor-click idiom as utils/csv.ts, generalized for binary payloads (PCAP
 * export reads the filename from the server's Content-Disposition header).
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
