import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * FX MOTION KIT — one-shot in-view detection.
 *
 * Flips to true the first time the observed element enters the viewport,
 * then disconnects — it never flips back. Starts as (and stays) true when
 * IntersectionObserver is unavailable or the user prefers reduced motion,
 * so content is never hidden. Pair with the .fx-reveal / .fx-visible CSS
 * classes (index.css, "FX MOTION KIT" block) or use directly.
 */

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function useInView<T extends HTMLElement>(
  rootMargin = '0px 0px -8% 0px',
): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  // Instant-visible fallback is decided once, at mount.
  const [inView, setInView] = useState<boolean>(
    () => typeof IntersectionObserver === 'undefined' || prefersReducedMotion(),
  );

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          observer.disconnect(); // one-shot
        }
      },
      { rootMargin, threshold: 0.05 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [rootMargin]);

  return [ref, inView];
}
