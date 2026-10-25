/**
 * IvrContext — who the /ivr workspace is for and what they may do. Set once
 * by pages/IvrPage.tsx for the current persona and read by every IVR view,
 * so no component looks at `user` / `effectiveCustomer` itself:
 *
 *   viewer    scope              canEdit
 *   ───────── ────────────────── ────────────────────────────────────────
 *   tenant    self:<own id>      role 'user' (a 'readonly' user views only)
 *   preview   c:<preview id>     yes (staff, "View as Customer")
 *   admin     c:<?customer=>     yes (staff console)
 */
import { createContext, useContext } from 'react';
import type { IvrScope } from './ivrData';

export type IvrViewer = 'tenant' | 'preview' | 'admin';

export interface IvrWorkspace {
  scope: IvrScope;
  viewer: IvrViewer;
  /** Staff (admin console or admin preview). */
  staff: boolean;
  /** May change flows, numbers and messages. False = view only. */
  canEdit: boolean;
  customerName: string;
  /** `/ivr…` path → link, keeping the admin console's `?customer=`. */
  href: (path: string) => string;
}

export const IvrWorkspaceContext = createContext<IvrWorkspace | null>(null);

export function useIvrWorkspace(): IvrWorkspace {
  const ws = useContext(IvrWorkspaceContext);
  if (!ws) throw new Error('useIvrWorkspace outside IvrWorkspaceContext');
  return ws;
}
