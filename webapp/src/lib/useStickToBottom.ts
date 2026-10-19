// Keeps a scrollable pane pinned to its bottom while content streams in,
// but only if the reader is already near the bottom. Scrolling up to re-read
// an earlier answer must not be yanked back down by every new token.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

const NEAR_BOTTOM_PX = 96;

export function useStickToBottom(
  ref: RefObject<HTMLElement | null>,
  deps: ReadonlyArray<unknown>,
): { atBottom: boolean; scrollToBottom: (smooth?: boolean) => void } {
  const [atBottom, setAtBottom] = useState(true);
  const stickRef = useRef(true);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = gap <= NEAR_BOTTOM_PX;
    stickRef.current = near;
    setAtBottom(near);
  }, [ref]);

  const scrollToBottom = useCallback(
    (smooth = true) => {
      const el = ref.current;
      if (!el) return;
      stickRef.current = true;
      setAtBottom(true);
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    },
    [ref],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener('scroll', measure, { passive: true });
    return () => el.removeEventListener('scroll', measure);
  }, [ref, measure]);

  // Follow new content only while pinned.
  useEffect(() => {
    if (stickRef.current) scrollToBottom(false);
  }, deps);

  return { atBottom, scrollToBottom };
}
