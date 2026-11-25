import { withGatewayTrace } from "@/app/lib/service-observability";
import { handleKitchenCommandRequest } from "@/app/lib/kitchen-command-http";
import { parseFillEmptyDaysApply } from "@/app/lib/kitchen-command-validation";
import { applyFillEmptyDays } from "@/app/lib/fill-empty-days-service";

export const dynamic = "force-dynamic";
export const POST = withGatewayTrace("kitchen.command", (request: Request) =>
  handleKitchenCommandRequest(request, (input, context) => applyFillEmptyDays(parseFillEmptyDaysApply(input), context), 4096));
