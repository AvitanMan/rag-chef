import { withGatewayTrace } from "@/app/lib/service-observability";
import { authorizeCatalogRequest } from "@/app/lib/catalog-auth";
import { catalogJobActor, catalogJobError, catalogJobJson, catalogJobResponse } from "@/app/lib/catalog-job-api";
import { getCatalogJob } from "@/app/lib/catalog-job-store";

async function handleGET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = await authorizeCatalogRequest(request);
  if (denied) return denied;
  try {
    const { id } = await context.params;
    const actor = await catalogJobActor(request);
    const job = await getCatalogJob(id, actor.actorId, actor.actorMode);
    return job ? catalogJobResponse(job) : catalogJobJson({ error: { code: "CATALOG_JOB_NOT_FOUND", message: "Catalog job not found." } }, 404);
  } catch (error) { return catalogJobError(error); }
}

export const GET = withGatewayTrace("catalog.job.status", handleGET);
