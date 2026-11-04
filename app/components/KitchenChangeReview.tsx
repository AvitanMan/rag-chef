"use client";

import { useEffect, useRef } from "react";
import type { KitchenChangePreview, KitchenChangeRow } from "../lib/kitchen-change-preview";
import type { RecoveryDraftPreview } from "../lib/use-kitchen";
import { Modal } from "./Modal";

function ChangeRow({ row, beforeLabel, afterLabel }: { row: KitchenChangeRow; beforeLabel: string; afterLabel: string }) {
  return <li className="kitchen-change-row">
    <div className="kitchen-change-heading"><strong>{row.label}</strong><span>{row.kind === "added" ? "Added" : row.kind === "removed" ? "Removed" : "Changed"}</span></div>
    <dl><div><dt>{beforeLabel}</dt><dd>{row.before ?? "Not present"}</dd></div><div><dt>{afterLabel}</dt><dd>{row.after ?? "Not present"}</dd></div></dl>
  </li>;
}

/** Keep the important differences readable without dumping internal state. */
export function KitchenChangeList({ preview, beforeLabel, afterLabel }: { preview: KitchenChangePreview; beforeLabel: string; afterLabel: string }) {
  if (!preview.hasChanges) return <p className="quantity-note">The kitchen contents match. There are no ingredient, dinner, or preference changes to review.</p>;
  const categories = [...new Set(preview.rows.map(row => row.category))];
  return <div className="kitchen-change-list">{categories.map(category => {
    const priority = { changed: 0, removed: 1, added: 2 };
    const rows = preview.rows.filter(row => row.category === category).sort((left, right) => priority[left.kind] - priority[right.kind] || left.label.localeCompare(right.label));
    return <section key={category} aria-label={`Changes to ${category.toLowerCase()}`}><h3>{category} <small>· {rows.length} {rows.length === 1 ? "change" : "changes"}</small></h3>
      <ul>{rows.slice(0, 4).map(row => <ChangeRow key={row.id} row={row} beforeLabel={beforeLabel} afterLabel={afterLabel} />)}</ul>
      {rows.length > 4 && <details className="more-kitchen-changes"><summary>Show {rows.length - 4} more {category.toLowerCase()} changes</summary><ul>{rows.slice(4).map(row => <ChangeRow key={row.id} row={row} beforeLabel={beforeLabel} afterLabel={afterLabel} />)}</ul></details>}
    </section>;
  })}</div>;
}

export function RecoveryDraftReview({ preview, busy, error, close, refresh, confirm }: {
  preview: RecoveryDraftPreview; busy: boolean; error: string; close: () => void; refresh: () => void; confirm: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeButton.current?.focus({ preventScroll: true }); }, []);
  return <Modal className="kitchen-modal-backdrop recovery-review-backdrop" label="Review browser draft" close={close}>
    <section className="panel kitchen-modal recovery-review">
      <div className="recovery-review-body">
      <header><div className="recovery-review-title"><span className="eyebrow">Before recovering</span><button ref={closeButton} className="text-button" aria-label="Close draft review" onClick={close}>Close</button></div><h2>Review this browser draft</h2><p>Compare this kitchen with the draft below. Recovering keeps a copy of your current kitchen and preserves the original draft.</p>{preview.updatedAt && <p className="quantity-note">Draft saved <time dateTime={preview.updatedAt}>{new Date(preview.updatedAt).toLocaleString()}</time></p>}</header>
      <KitchenChangeList preview={preview.changes} beforeLabel="This kitchen" afterLabel="Browser draft" /></div>
      <footer>{error && <p role="alert">{error}</p>}<p className="quantity-note">Recovery may ask you to resolve newer saved changes before saving.</p><div className="modal-actions"><button className="secondary-button" onClick={close}>Cancel</button>{error && <button className="secondary-button" disabled={busy} onClick={refresh}>Review latest changes</button>}<button className="primary-button" disabled={busy || Boolean(error)} onClick={confirm}>Recover this draft</button></div></footer>
    </section>
  </Modal>;
}
