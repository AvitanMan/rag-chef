import { withGatewayTrace } from "@/app/lib/service-observability";
import { authorizeCatalogRequest } from "@/app/lib/catalog-auth";
import { catalogJobJson, catalogRequestText, submitCatalogJob } from "@/app/lib/catalog-job-api";

/** Original starter recipes are saved by the durable catalog worker. */
async function handlePOST(request: Request): Promise<Response> {
  const denied = await authorizeCatalogRequest(request);
  if (denied) return denied;
  try {
    if ((await catalogRequestText(request, 1024)).trim()) throw new Error();
  } catch { return catalogJobJson({ error: { message: "This action takes no recipe data." } }, 400); }
  return submitCatalogJob(request, { kind: "demo" });
}

export const POST = withGatewayTrace("catalog.demo", handlePOST);
