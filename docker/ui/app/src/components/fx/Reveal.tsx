import { type CSSProperties, type ReactNode } from 'react';
import { useInView } from './useInView';

/**
 * FX MOTION KIT — one-shot, scroll-driven reveal wrapper.
 *
 * Generic and page-agnostic: any page can wrap a below-the-fold section in
 * <Reveal> to get a staggered fade/rise when it first scrolls into view.
 * CSS lives in index.css under the "FX MOTION KIT" block (.fx-reveal /
 * .fx-visible). Motion is opacity + a small translateY only — zero layout
 * shift — and is fully disabled under prefers-reduced-motion (elements are
 * instantly visible). The in-view detection lives in ./useInView.
 */

interface RevealProps {
  children: ReactNode;
  /** Stagger delay in ms, applied once the element enters the viewport. */
  delay?: number;
  className?: string;
  style?: CSSProperties;
}

/** One-shot scroll-reveal wrapper. Renders a plain div — no layout impact. */
export function Reveal({ children, delay = 0, className, style }: RevealProps) {
  const [ref, inView] = useInView<HTMLDivElement>();

  const mergedStyle: CSSProperties | undefined = delay
    ? ({ ...style, '--fx-delay': `${delay}ms` } as CSSProperties)
    : style;

  return (
    <div
      ref={ref}
      className={`fx-reveal${inView ? ' fx-visible' : ''}${className ? ` ${className}` : ''}`}
      style={mergedStyle}
    >
      {children}
    </div>
  );
}
