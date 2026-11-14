import { requireOwner, type HouseholdContext } from "./household";
import { applyKitchenCommand, type KitchenCommand } from "./kitchen-commands";
import { EMPTY_KITCHEN, type KitchenDocument, type KitchenState } from "./kitchen-types";
import { getKitchenDocument, saveKitchenDocument, KitchenConflictError } from "./kitchen-store";
import { validateKitchenWrite } from "./kitchen-validation";
import { parseKitchenCommand, kitchenCommandHash } from "./kitchen-command-validation";
import { findKitchenCommand, commitKitchenCommand } from "./kitchen-command-store";
import type { KitchenCommandCommit, KitchenCommandResult } from "./kitchen-command-types";
export type { KitchenCommandResult } from "./kitchen-command-types";

/** The repository must atomically recheck revision and household authorization. */
export interface KitchenRepository {
  read(context?: HouseholdContext): Promise<KitchenDocument>;
  save(revision: number, state: KitchenState, context?: HouseholdContext): Promise<KitchenDocument>;
}

export interface KitchenCommandRepository {
  find(commandId: string, requestHash: string, context?: HouseholdContext): Promise<KitchenCommandResult | null>;
  commit(input: KitchenCommandCommit, context?: HouseholdContext): Promise<KitchenCommandResult>;
}

export interface KitchenService extends KitchenRepository {
  execute(command: KitchenCommand, context?: HouseholdContext): Promise<KitchenCommandResult>;
}

export function createKitchenService(repository: KitchenRepository, commands: KitchenCommandRepository): KitchenService {
  return {
    read: (context) => repository.read(context),
    save: (revision, state, context) => {
      validateKitchenWrite({ revision, state });
      return repository.save(revision, state, context);
    },
    async execute(input, context) {
      const command = parseKitchenCommand(input);
      if (context?.mode === "hosted" && command.type === "SetCookingProfile") requireOwner(context);
      const requestHash = await kitchenCommandHash(command);
      const previous = await commands.find(command.commandId, requestHash, context);
      if (previous) return previous;
      const current = await repository.read(context);
      if (command.expectedRevision !== current.revision) {
        // A duplicate can finish between the first lookup and this read.
        const raced = await commands.find(command.commandId, requestHash, context);
        if (raced) return raced;
        throw new KitchenConflictError(current);
      }
      const state = current.state ?? structuredClone(EMPTY_KITCHEN);
      const next = applyKitchenCommand(state, command, {
        revision: current.revision,
        canEditProfile: context?.mode !== "hosted" || context.role === "owner",
      });
      validateKitchenWrite({ revision: current.revision, state: next });
      // The receipt and state mutation share one transaction. Even a no-op
      // records its result with an atomic revision/authorization precondition.
      return commands.commit({ commandId: command.commandId, requestHash, current, state: next, applied: next !== state }, context);
    },
  };
}

export const kitchenService = createKitchenService(
  { read: getKitchenDocument, save: saveKitchenDocument },
  { find: findKitchenCommand, commit: commitKitchenCommand },
);
export { KitchenConflictError } from "./kitchen-store";
export { KitchenCommandReuseError } from "./kitchen-command-store";
