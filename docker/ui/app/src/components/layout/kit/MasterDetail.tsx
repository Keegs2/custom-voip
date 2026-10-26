/**
 * MasterDetail — a list and the open item, side by side, as two panes of
 * EQUAL height bounded to the first screen: the panes end `bottomGap` above
 * the viewport's bottom edge (never shorter than `minHeight`), and each
 * pane scrolls inside itself. Nothing on the page scrolls while one column
 * sits half empty.
 *
 *   <MasterDetail
 *     listLabel="Messages" detailLabel="Message"
 *     listClassName="dl-panel" detailClassName="dl-panel"
 *     list={<>
 *       <FolderTabs />                               ← stays put
 *       <ScrollArea><MessageList /></ScrollArea>     ← scrolls
 *     </>}
 *     detail={<>
 *       <ScrollArea><Message /></ScrollArea>
 *       <footer>…actions…</footer>                   ← pinned, always visible
 *     </>}
 *   />
 *
 * Each pane is a flex column: put the part that should scroll in a
 * <ScrollArea> (or `.lk-scroll`) and anything that should stay visible
 * (tabs, toolbars, an action footer) around it.
 *
 * Narrow (container < 720px): the panes stack — the list first, its
 * ScrollArea capped (`--lk-md-list-max`, default min(50vh, 440px)), then
 * the detail at its natural height.
 */
import { useRef, type CSSProperties, type ReactNode } from 'react';
import { useViewportFit } from './useViewportFit';

export interface MasterDetailProps {
  list: ReactNode;
  detail: ReactNode;
  /** Accessible names of the two regions. */
  listLabel: string;
  detailLabel: string;
  /** List column width at full width. Default minmax(280px, 360px). */
  listWidth?: string;
  /** Surface classes for each pane (e.g. "dl-panel"); the kit adds structure only. */
  listClassName?: string;
  detailClassName?: string;
  className?: string;
  /** Lowest the panes get (px). Default 460. */
  minHeight?: number;
  /** Space left under the panes on the first screen (px). Default 24. */
  bottomGap?: number;
}

export function MasterDetail({
  list,
  detail,
  listLabel,
  detailLabel,
  listWidth,
  listClassName,
  detailClassName,
  className,
  minHeight,
  bottomGap,
}: MasterDetailProps) {
  // ALL hooks unconditionally at the top (React #310).
  const gridRef = useRef<HTMLDivElement>(null);
  useViewportFit(gridRef);

  const style = {
    ...(listWidth ? { '--lk-md-list': listWidth } : {}),
    ...(minHeight !== undefined ? { '--lk-md-min': `${minHeight}px` } : {}),
    ...(bottomGap !== undefined ? { '--lk-md-bottom': `${bottomGap}px` } : {}),
  } as CSSProperties;

  return (
    <div className={`lk-md-host${className ? ` ${className}` : ''}`}>
      <div className="lk-md" ref={gridRef} style={style}>
        <section className={`lk-md-pane lk-md-list${listClassName ? ` ${listClassName}` : ''}`} aria-label={listLabel}>
          {list}
        </section>
        <section className={`lk-md-pane lk-md-detail${detailClassName ? ` ${detailClassName}` : ''}`} aria-label={detailLabel}>
          {detail}
        </section>
      </div>
    </div>
  );
}
