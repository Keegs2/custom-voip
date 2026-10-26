/**
 * API Reference — the typed shape of the documentation content.
 *
 * Every section of /docs/api is DATA (sections/*.ts) rendered by one set of
 * components (ApiReference.tsx), so each endpoint is documented the same
 * way: method + path, who may call it, parameters, the response fields a
 * customer actually receives, status codes and a collapsed example.
 *
 * TRUTH CONTRACT: every entry mirrors the FastAPI backend
 * (docker/api/src/routers/*) as a TENANT (`user` / `readonly`) sees it —
 * tenant-scoped routes only, tenant-redacted fields only. Never add an
 * admin/staff-only route, a staff-only field, an internal component,
 * vendor, host or address here. See docker/ui/CLAUDE.md §7 "ApiDocsPage".
 *
 * Text fields are plain strings; a `backtick span` renders as inline code
 * (RichText in ApiReference.tsx). No other markup.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Customer roles. `readonly` may read; changes need `user`. */
export type TenantRole = 'user' | 'readonly';

export const READ_ROLES: readonly TenantRole[] = ['user', 'readonly'];
export const WRITE_ROLES: readonly TenantRole[] = ['user'];

export type ParamLocation = 'path' | 'query' | 'body';

export interface ParamDoc {
  readonly name: string;
  readonly in: ParamLocation;
  /** JSON / query type as a reader writes it: `string`, `integer`, `boolean`, `string (date)`… */
  readonly type: string;
  readonly required?: boolean;
  readonly description: string;
}

export interface FieldDoc {
  /** Dotted for nested objects: `counts.numbers.total`, `points[].calls`. */
  readonly name: string;
  readonly type: string;
  readonly description: string;
}

export interface StatusDoc {
  readonly code: number;
  readonly when: string;
}

export interface ExampleDoc {
  readonly request: string;
  readonly response: string;
  /** Label of the response block (default "response"). */
  readonly responseLabel?: string;
}

export interface EndpointDoc {
  readonly kind: 'endpoint';
  /** Anchor id, unique across the whole reference (`#rcf-update`). */
  readonly id: string;
  readonly method: HttpMethod;
  /** Relative to the base URL (`https://<your portal host>/api/v1`). */
  readonly path: string;
  /** Short task name — the contents list and the open card. */
  readonly title: string;
  /** One line on the collapsed row. */
  readonly summary: string;
  /** Paragraphs shown when the card is open. */
  readonly description?: readonly string[];
  readonly roles: readonly TenantRole[];
  readonly params?: readonly ParamDoc[];
  /** One line above the field table: what the body is (an array, an object…). */
  readonly returns?: string;
  readonly fields?: readonly FieldDoc[];
  readonly statuses: readonly StatusDoc[];
  readonly example?: ExampleDoc;
  /** Callouts at the end of the card. */
  readonly notes?: readonly string[];
}

/** Prose building blocks for Getting started topics. */
export type TopicBlock =
  | { readonly type: 'p'; readonly text: string }
  | { readonly type: 'list'; readonly items: readonly string[] }
  | { readonly type: 'code'; readonly label: string; readonly code: string }
  | {
      readonly type: 'table';
      readonly head: readonly [string, string];
      readonly rows: readonly (readonly [string, string])[];
      /** Show this many rows, then "Show all N …" (§20.3). */
      readonly limit?: number;
      readonly noun?: string;
    }
  | { readonly type: 'callout'; readonly tone?: 'info' | 'warn'; readonly text: string };

export interface TopicDoc {
  readonly kind: 'topic';
  readonly id: string;
  readonly title: string;
  readonly blocks: readonly TopicBlock[];
}

export type EntryDoc = EndpointDoc | TopicDoc;

export interface GroupDoc {
  readonly id: string;
  readonly title: string;
  /** One line under the group heading. */
  readonly intro?: string;
  readonly entries: readonly EntryDoc[];
}

export interface SectionDoc {
  readonly label: string;
  /** One line under the pane title. */
  readonly intro: string;
  readonly tag?: 'Early access';
  readonly groups: readonly GroupDoc[];
}
