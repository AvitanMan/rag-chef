import { revokeInvitation } from "@/app/lib/household-management";
import { householdError, initializeHouseholdRuntime } from "@/app/lib/household";
export async function DELETE(request: Request, context: { params: Promise<{id: string}> }): Promise<Response> { try { await initializeHouseholdRuntime(); return await revokeInvitation(request, (await context.params).id); } catch (error) { return householdError(error); } }
