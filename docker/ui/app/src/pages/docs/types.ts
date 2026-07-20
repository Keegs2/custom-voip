/**
 * Local types for the documentation pages (RCF User Guide + API Reference).
 *
 * These are feature-local only — nothing here duplicates a global type from
 * `src/types/`. The docs pages are static content surfaces (no server state),
 * so this is intentionally small.
 */

/** HTTP verbs rendered by the <Endpoint> row, each with its own colour. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/** One row in a <ParamTable>. */
export interface Param {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

/** Retry classification used by the API "error handling" table. */
export type RetryKind = 'no' | 'reauth' | 'backoff';
