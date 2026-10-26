/**
 * Layout kit — balanced, compact, expandable pages. Rulebook:
 * docker/ui/CLAUDE.md §20 "Layout — balanced, compact, expandable".
 * Styles: src/styles/layout-kit.css (`lk-`, loaded once in main.tsx).
 * Structure only: surfaces (`dl-panel`, the dashboard `Card`, …) stay the
 * page's own; every colour is a theme token.
 */
export { Disclosure, type DisclosureProps, type DisclosureVariant } from './Disclosure';
export { ShowMoreButton, type ShowMoreButtonProps } from './ShowMoreButton';
export { useShowMore, type ShowMoreState } from './useShowMore';
export { BalancedGrid, type BalancedGridProps, type StackWidth } from './BalancedGrid';
export { MasterDetail, type MasterDetailProps } from './MasterDetail';
export { ScrollArea, type ScrollAreaProps } from './ScrollArea';
export { CompactHeader, type CompactHeaderProps, type HeaderStat } from './CompactHeader';
export { ClampText, type ClampTextProps } from './ClampText';
export { useOpenState, readOpen, writeOpen, type OpenStateOptions } from './openState';
export { useViewportFit } from './useViewportFit';
