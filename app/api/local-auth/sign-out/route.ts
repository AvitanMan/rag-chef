import { householdError, initializeHouseholdRuntime } from "@/app/lib/household";
import { signOutLocal } from "@/app/lib/local-auth";
export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  try { await initializeHouseholdRuntime(); return await signOutLocal(request); }
  catch (error) { return householdError(error); }
}
