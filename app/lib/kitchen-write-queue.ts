import { applyKitchenCommand, type KitchenCommand } from "./kitchen-commands";
import { parseKitchenCommand } from "./kitchen-command-validation";
import { EMPTY_KITCHEN, type KitchenDocument, type KitchenState } from "./kitchen-types";
import { validateKitchenWrite } from "./kitchen-validation";

export type PendingKitchenWrite =
  | { kind: "command"; command: KitchenCommand; attempted: boolean }
  | { kind: "snapshot"; state: KitchenState; expectedRevision?: number };
export interface KitchenWriteQueue { version: 1; writes: PendingKitchenWrite[] }
export const MAX_PENDING_KITCHEN_WRITES = 2_000;

function requireQueueSpace(writes: PendingKitchenWrite[]) {
  if (writes.length >= MAX_PENDING_KITCHEN_WRITES) throw new Error("This tab has too many unsaved changes. Save or resolve the pending changes before editing again.");
}

/** A draft owns its outbox; another tab/account never adopts it implicitly. */
export function parseKitchenWriteQueue(value: unknown): KitchenWriteQueue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid kitchen write queue");
  const queue = value as KitchenWriteQueue;
  if (queue.version !== 1 || !Array.isArray(queue.writes) || queue.writes.length > MAX_PENDING_KITCHEN_WRITES) throw new Error("Invalid kitchen write queue");
  const ids = new Set<string>();
  const writes = queue.writes.map((write, index): PendingKitchenWrite => {
    if (!write || typeof write !== "object") throw new Error("Invalid pending kitchen write");
    if (write.kind === "command") {
      if (typeof write.attempted !== "boolean" || index > 0 && write.attempted) throw new Error("Invalid command order");
      const command = parseKitchenCommand(write.command);
      if (ids.has(command.commandId)) throw new Error("Duplicate queued command");
      ids.add(command.commandId);
      return { kind: "command", command, attempted: write.attempted };
    }
    if (write.kind === "snapshot") {
      validateKitchenWrite({ revision: write.expectedRevision === undefined ? 0 : write.expectedRevision, state: write.state });
      if (index > 0 && write.expectedRevision !== undefined) throw new Error("Invalid snapshot order");
      return { kind: "snapshot", state: structuredClone(write.state), ...(write.expectedRevision !== undefined ? { expectedRevision: write.expectedRevision } : {}) };
    }
    throw new Error("Unknown pending kitchen write");
  });
  return { version: 1, writes };
}

export function appendKitchenSnapshot(writes: PendingKitchenWrite[], state: KitchenState): PendingKitchenWrite[] {
  const next: PendingKitchenWrite = { kind: "snapshot", state: structuredClone(state) };
  const tail = writes.at(-1);
  if (tail?.kind === "snapshot" && tail.expectedRevision === undefined) return [...writes.slice(0, -1), next];
  requireQueueSpace(writes);
  return [...writes, next];
}

export function appendKitchenCommand(writes: PendingKitchenWrite[], command: KitchenCommand): PendingKitchenWrite[] {
  requireQueueSpace(writes);
  return [...writes, { kind: "command", command, attempted: false }];
}

/** Only an unattempted head receives a revision. Retries retain exact bytes. */
export function prepareKitchenWrite(write: PendingKitchenWrite, revision: number): PendingKitchenWrite {
  if (write.kind === "command") return write.attempted ? write : { ...write, command: { ...write.command, expectedRevision: revision }, attempted: true };
  return write.expectedRevision !== undefined ? write : { ...write, expectedRevision: revision };
}

export function hasAttemptedKitchenCommand(writes: PendingKitchenWrite[]): boolean {
  return writes[0]?.kind === "command" && writes[0].attempted;
}

/** Project only the unsent tail after an acknowledged head. No attempted intent is rebased. */
export function projectKitchenWrites(document: KitchenDocument, writes: PendingKitchenWrite[], canEditProfile: boolean): KitchenState {
  let state = document.state ?? structuredClone(EMPTY_KITCHEN);
  for (const write of writes) {
    if (write.kind === "snapshot") state = write.state;
    else {
      if (write.attempted) throw new Error("An attempted command cannot be rebased");
      state = applyKitchenCommand(state, write.command, { revision: write.command.expectedRevision, canEditProfile });
    }
  }
  return state;
}
