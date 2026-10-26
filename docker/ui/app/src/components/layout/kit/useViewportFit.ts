/**
 * useViewportFit — writes `--lk-md-top` (the element's distance from the
 * top of the DOCUMENT, in px) onto the element, so CSS can size it to end
 * at the bottom of the first screen:
 *
 *   height: calc(100dvh - var(--lk-md-top) - var(--lk-md-bottom));
 *
 * Measured after layout, again on window resize and whenever the page
 * above it changes size (a banner appears, the header wraps) — via one
 * ResizeObserver on <body>, batched to one measurement per frame. It
 * writes the custom property directly (no React state, no re-render).
 */
import { useLayoutEffect, type RefObject } from 'react';

export function useViewportFit(ref: RefObject<HTMLElement | null>, property = '--lk-md-top'): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    let frame = 0;
    let last = '';
    const measure = () => {
      frame = 0;
      // Layout position (offset chain), not getBoundingClientRect(): the
      // page-entry animations (.fx-load) translate the content while it
      // mounts, and a transform must not shorten the panes.
      let y = 0;
      for (let node: HTMLElement | null = el; node; node = node.offsetParent as HTMLElement | null) y += node.offsetTop;
      const top = `${Math.max(0, Math.round(y))}px`;
      if (top !== last) {
        last = top;
        el.style.setProperty(property, top);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('resize', schedule);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(document.body);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      observer?.disconnect();
    };
  }, [ref, property]);
}
