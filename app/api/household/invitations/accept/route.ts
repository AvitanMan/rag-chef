import { acceptInvitation } from "@/app/lib/household-management";
import { householdError, initializeHouseholdRuntime } from "@/app/lib/household";
export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> { try { await initializeHouseholdRuntime(); return await acceptInvitation(request); } catch (error) { return householdError(error); } }
