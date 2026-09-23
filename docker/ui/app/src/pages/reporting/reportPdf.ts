/**
 * Lazy entry point for the PDF summary. ReportingPage loads this with
 * `await import('./reportPdf')`, which pulls react-pdf into its own chunk.
 */
import { createElement, type ReactElement } from 'react';
import { pdf, type DocumentProps } from '@react-pdf/renderer';
import { ReportDocument, type ReportPdfInput } from './ReportPdfDocument';

export type { ReportPdfInput };

/** Build the PDF as a Blob (the caller saves it with saveBlob). */
export async function renderReportPdf(input: ReportPdfInput): Promise<Blob> {
  // ReportDocument's root IS a <Document>, which is what pdf() requires; the
  // cast only bridges the wrapper component's own props type.
  const element = createElement(ReportDocument, { input }) as unknown as ReactElement<DocumentProps>;
  return pdf(element).toBlob();
}
