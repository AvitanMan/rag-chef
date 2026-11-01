"use client";

import { useEffect, useRef, type ReactNode } from "react";

let scrollLocks = 0;
let previousOverflow = { root: "", body: "" };
function lockPageScroll() {
  if (scrollLocks++ === 0) {
    previousOverflow = { root: document.documentElement.style.overflow, body: document.body.style.overflow };
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
  }
  return () => {
    if (--scrollLocks === 0) {
      document.documentElement.style.overflow = previousOverflow.root;
      document.body.style.overflow = previousOverflow.body;
    }
  };
}

/** Native modality keeps the rest of the page inert, including for screen readers. */
export function Modal({ children, close, className, label, labelledBy }: {
  children: ReactNode;
  close: () => void;
  className: string;
  label?: string;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const unlock = lockPageScroll();
    dialog.showModal();
    return () => {
      dialog.close();
      unlock();
      queueMicrotask(() => {
        if (document.querySelector("dialog:modal")) return;
        const active = document.activeElement;
        // A newly opened screen may have already focused its heading or form.
        // Do not pull focus back to the drawer's old trigger in that case.
        if (active instanceof HTMLElement && active !== document.body && active !== trigger && active.isConnected && !dialog.contains(active)) return;
        const fallback = [...document.querySelectorAll<HTMLElement>(".nav-button.active")].find((element) => element.getClientRects().length > 0);
        const target = trigger?.isConnected && trigger.getClientRects().length > 0 ? trigger : fallback;
        target?.focus();
      });
    };
  }, []);
  return <dialog ref={ref} className={`accessible-modal ${className}`} aria-modal="true" aria-label={label} aria-labelledby={labelledBy}
    onCancel={(event) => { event.preventDefault(); close(); }}
    onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}
    onKeyDown={(event) => {
      if (event.key !== "Tab") return;
      const elements = [...event.currentTarget.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], summary, [tabindex]')]
        .filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") && element.getClientRects().length > 0);
      const first = elements[0], last = elements.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>{children}</dialog>;
}
