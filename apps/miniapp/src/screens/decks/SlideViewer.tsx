import { useEffect, useRef, useState } from "react";
import type { LaidOutSlide } from "@talaba/shared";
import { useT } from "../../lib/i18n";
import { SlidePreview } from "./SlidePreview";

function usePortrait() {
  const q = "(orientation: portrait)";
  const [portrait, setPortrait] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setPortrait(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return portrait;
}

/**
 * Full-screen slide view (also a rehearsal mode). On a portrait phone the
 * 16:9 slide is turned sideways so it uses the whole screen height and the
 * slide text is readable without zooming.
 */
export function SlideViewer({ slides, start, onClose }: { slides: LaidOutSlide[]; start: number; onClose: () => void }) {
  const t = useT();
  const [i, setI] = useState(Math.max(0, Math.min(start, slides.length - 1)));
  const portrait = usePortrait();
  const ref = useRef<HTMLDivElement>(null);
  const touch = useRef<number | null>(null);
  const go = (d: number) => setI((x) => Math.max(0, Math.min(slides.length - 1, x + d)));
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === "PageDown") go(1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [onClose]); // eslint-disable-line react-hooks/exhaustive-deps
  const slide = slides[i];
  if (!slide) return null;
  return (
    <div
      className="deck-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={t("deck.slideN", { n: i + 1 })}
      tabIndex={-1}
      ref={ref}
      onTouchStart={(e) => (touch.current = portrait ? e.touches[0]!.clientY : e.touches[0]!.clientX)}
      onTouchEnd={(e) => {
        if (touch.current == null) return;
        const end = portrait ? e.changedTouches[0]!.clientY : e.changedTouches[0]!.clientX;
        const d = end - touch.current;
        touch.current = null;
        if (Math.abs(d) > 50) go(d < 0 ? 1 : -1);
      }}
    >
      <div className={`deck-viewer-frame${portrait ? " is-rotated" : ""}`}>
        <div className="deck-viewer-stage">
          <SlidePreview slide={slide} />
        </div>
      </div>
      <div className="deck-viewer-bar">
        <button className="icon-btn" onClick={() => go(-1)} disabled={i === 0} aria-label={t("deck.prevSlide")}>‹</button>
        <span className="deck-viewer-count" aria-live="polite">{i + 1} / {slides.length}</span>
        <button className="icon-btn" onClick={() => go(1)} disabled={i === slides.length - 1} aria-label={t("deck.nextSlide")}>›</button>
        <button className="icon-btn" onClick={onClose} aria-label={t("common.close")}>✕</button>
      </div>
    </div>
  );
}
