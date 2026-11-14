import { sessionResponse } from "@/app/lib/household-management";
import { householdError, initializeHouseholdRuntime } from "@/app/lib/household";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> { try { await initializeHouseholdRuntime(); return await sessionResponse(request); } catch (error) { return householdError(error); } }
