import { withGatewayTrace } from "@/app/lib/service-observability";
import { parseChefRequest } from "@/app/lib/chef-schema";
import { requireHousehold, householdError, type HouseholdContext } from "@/app/lib/household";
import { callChef } from "@/app/lib/chef-client";
import { chefErrorResponse, chefJsonError, readChefBody } from "@/app/lib/chef-protocol";

async function handlePOST(request: Request): Promise<Response> {
  let household: HouseholdContext;
  try { household = await requireHousehold(request); } catch (error) { return householdError(error); }
  let input: unknown;
  try {
    const text = await readChefBody(request);
    try { input = JSON.parse(text); }
    catch { return chefJsonError(400, "invalid_json", "Request body must be valid JSON."); }
    parseChefRequest(input);
  } catch (error) {
    if (error instanceof TypeError && !request.signal.aborted) return chefJsonError(400, "invalid_json", "Request body must be valid JSON.");
    return chefErrorResponse(error, request.signal);
  }
  // Forward original public JSON. Re-parsing a normalized profile would turn
  // unspecified equipment into an explicitly empty equipment restriction.
  return callChef("answer", { household, input }, request.signal);
}

export const POST = withGatewayTrace("chef.answer", handlePOST);
