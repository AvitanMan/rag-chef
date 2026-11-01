"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ShoppingItem } from "../lib/quantities";
import { shoppingListText } from "../lib/shopping-export";

export function ShoppingExport({ items, week }: { items: ShoppingItem[]; week: string }) {
  const text = shoppingListText(items, week);
  const [result, setResult] = useState<{ text: string; status: "copied" | "manual" } | null>(null);
  const fallback = useRef<HTMLTextAreaElement>(null);
  const status = result?.text === text ? result.status : null;
  useEffect(() => {
    if (status === "manual") { fallback.current?.focus(); fallback.current?.select(); }
  }, [status, text]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setResult({ text, status: "copied" });
    } catch {
      setResult({ text, status: "manual" });
    }
  }
  return <>
    <div className="shopping-export-actions" role="group" aria-label="Export shopping list">
      <button className="secondary-button" disabled={!items.length} onClick={() => void copy()}>Copy shopping list</button>
      <button className="secondary-button" disabled={!items.length} onClick={() => window.print()}>Print</button>
    </div>
    <p className="quantity-note">Copy or print this week’s unchecked items, including any amount or preparation warnings.</p>
    {status === "copied" && <p role="status">Shopping list copied.</p>}
    {status === "manual" && <div className="shopping-export-fallback"><p role="status">Copying is unavailable. Select and copy the list below.</p><label>Shopping list text<textarea ref={fallback} readOnly rows={8} value={text} /></label></div>}
    {typeof document !== "undefined" && createPortal(<section className="shopping-print" aria-label="Printable shopping list"><pre>{text}</pre></section>, document.body)}
  </>;
}
