import { useEffect, useState } from 'react';

/**
 * Track the on-screen keyboard height via Visual Viewport API.
 * Exposes a CSS variable `--keyboard-height` on <html> that mobile chat can
 * use to keep the composer above the keyboard.
 */
export function useVisualViewport(): number {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return;

    const vv = window.visualViewport;

    const update = () => {
      const viewportHeight = vv.height;
      const layoutHeight = window.innerHeight;
      const offsetTop = vv.offsetTop;
      const kb = Math.max(0, layoutHeight - viewportHeight - offsetTop);
      setKeyboardHeight(kb);
      document.documentElement.style.setProperty('--keyboard-height', `${kb}px`);
    };

    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();

    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      document.documentElement.style.removeProperty('--keyboard-height');
    };
  }, []);

  return keyboardHeight;
}
