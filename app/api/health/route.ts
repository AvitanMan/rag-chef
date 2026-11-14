import { withGatewayTrace } from "@/app/lib/service-observability";
import { requireHousehold, householdError } from "@/app/lib/household";
import { callChef } from "@/app/lib/chef-client";

async function handleGET(request: Request): Promise<Response> {
  try {
    const household = await requireHousehold(request);
    const params = new URL(request.url).searchParams;
    return callChef("health", { household, query: { provider: params.get("provider"), model: params.get("model")?.trim() ?? "" } }, request.signal);
  } catch (error) { return householdError(error); }
}

export const GET = withGatewayTrace("chef.health", handleGET);
