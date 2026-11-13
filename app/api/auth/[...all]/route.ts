import { getAuth } from "@/app/lib/auth";
import { householdError, HouseholdAuthError, initializeHouseholdRuntime, requireSameOrigin } from "@/app/lib/household";
export const dynamic = "force-dynamic";
const allowed = new Set(["POST /api/auth/sign-in/social", "GET /api/auth/callback/google", "POST /api/auth/sign-out"]);
async function handle(request: Request): Promise<Response> {
  try {
    await initializeHouseholdRuntime();
    requireSameOrigin(request);
    if (!allowed.has(`${request.method} ${new URL(request.url).pathname}`)) throw new HouseholdAuthError("AUTH_ROUTE_DISABLED", "This authentication operation is not enabled.", 404);
    return await (await getAuth()).handler(request);
  } catch (error) { return householdError(error); }
}
export const GET = handle;
export const POST = handle;
