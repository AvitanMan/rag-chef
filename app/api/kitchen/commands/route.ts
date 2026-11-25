import { withGatewayTrace } from "@/app/lib/service-observability";
import { handleKitchenCommandRequest } from "@/app/lib/kitchen-command-http";
import { kitchenService } from "@/app/lib/kitchen-service";
import { parseKitchenCommand } from "@/app/lib/kitchen-command-validation";

export const dynamic = "force-dynamic";
export const POST = withGatewayTrace("kitchen.command", (request: Request) =>
  handleKitchenCommandRequest(request, (input, context) => kitchenService.execute(parseKitchenCommand(input), context)));
