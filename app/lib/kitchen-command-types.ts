import type { KitchenDocument, KitchenState } from "./kitchen-types";

export interface KitchenCommandResult {
  commandId: string;
  applied: boolean;
  document: KitchenDocument;
  /** A replay carries the original document, which may precede today's state. */
  replayed: boolean;
}

export interface KitchenCommandCommit {
  commandId: string;
  requestHash: string;
  current: KitchenDocument;
  state: KitchenState;
  applied: boolean;
}
