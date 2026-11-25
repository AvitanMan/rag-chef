import { withGatewayTrace } from "@/app/lib/service-observability";
import { handleKitchenCommandRequest } from "@/app/lib/kitchen-command-http";
import { parseFillEmptyDaysPreview } from "@/app/lib/kitchen-command-validation";
import { previewFillEmptyDays } from "@/app/lib/fill-empty-days-service";

export const dynamic = "force-dynamic";
export const POST = withGatewayTrace("kitchen.read", (request: Request) =>
  handleKitchenCommandRequest(request, (input, context) => previewFillEmptyDays(parseFillEmptyDaysPreview(input), context), 4096));
