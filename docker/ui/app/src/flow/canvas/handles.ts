/**
 * Handle vocabulary shared by the canvas nodes, the store, and the compiler.
 *
 * Every non-terminal node leaves by a single sequential handle (`NEXT_HANDLE`).
 * A `menu` (Gather) node instead exposes one source handle per enabled digit
 * plus a `timeout` and a `noMatch` handle — these become the compiled
 * `branches` map (see `compile/ivr.ts` + `routers/ivr.py:_node_to_xml`).
 */
import type { NodeType } from '../model/types';

/** Default sequential outgoing handle id (and the target/input handle id). */
export const NEXT_HANDLE = 'next';
export const IN_HANDLE = 'in';

/** Menu option digits, in keypad order, that may each own a source handle. */
export const MENU_DIGIT_KEYS = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#',
] as const;

export const MENU_TIMEOUT = 'timeout';
export const MENU_NOMATCH = 'noMatch';

/** Nodes that end the call leg — no outgoing/source handle. */
const TERMINAL_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(['hangup', 'reject']);

export function isTerminalType(type: NodeType | undefined): boolean {
  return type !== undefined && TERMINAL_TYPES.has(type);
}

/**
 * Map a menu source-handle id to its compiled `branches` key.
 *
 * Digit handles keep their digit ('1'→'1'); `timeout`→'timeout' and
 * `noMatch`→'default' so they line up with the runtime fallback in
 * `ivr.py:ivr_webhook` (`branches.get("default") or branches.get("timeout")`).
 */
export function handleToBranchKey(handle: string): string {
  if (handle === MENU_TIMEOUT) return 'timeout';
  if (handle === MENU_NOMATCH) return 'default';
  return handle;
}

export function isDigitHandle(handle: string | null | undefined): boolean {
  return handle != null && (MENU_DIGIT_KEYS as readonly string[]).includes(handle);
}
