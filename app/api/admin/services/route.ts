import { authorizeCatalogRequest } from "@/app/lib/catalog-auth";
import { catalogReadScope } from "@/app/lib/catalog-read-service";
import { SERVICE_SCHEMA_VERSION, serviceReadiness } from "@/app/lib/service-readiness";
import { readChefBody } from "@/app/lib/chef-protocol";
import { compatibleServiceResponse, serviceRequestHeaders, withGatewayTrace } from "@/app/lib/service-observability";

async function readiness(request: Request): Promise<Response> {
  const denied = await authorizeCatalogRequest(request);
  if (denied) return denied;
  const scope = catalogReadScope();
  const local = await serviceReadiness("gateway");
  const gateway = await local.json() as Record<string, unknown>;
  const check = async (name: "CATALOG" | "CHEF", service: "catalog" | "chef") => {
    try {
      const { env } = await import("cloudflare:workers");
      const binding = (env as unknown as Record<string, Fetcher>)[name];
      if (!binding) throw new Error();
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]);
      const response = await binding.fetch("https://service.internal/ready", { headers: serviceRequestHeaders(), signal });
      const body = JSON.parse(await readChefBody({ headers: response.headers, body: response.body, signal }, 100_000)) as Record<string, unknown>;
      if (!response.ok || !compatibleServiceResponse(response) || body.service !== service || body.protocol !== 1 || body.controls !== 1 || body.schema !== SERVICE_SCHEMA_VERSION
        || JSON.stringify(body.scope) !== JSON.stringify(scope) || body.release !== gateway.release || JSON.stringify(body.limits) !== JSON.stringify(gateway.limits)) throw new Error();
      return { ...body, ok: true };
    } catch { return { ok: false, service, error: { code: "service_not_ready", message: "Service binding, release, schema or runtime policy does not match the gateway." } }; }
  };
  const [catalog, chef] = await Promise.all([check("CATALOG", "catalog"), check("CHEF", "chef")]);
  const ok = gateway.ok === true && catalog.ok && chef.ok;
  return Response.json({ ok, services: { gateway, catalog, chef } }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
export const GET = withGatewayTrace("services.ready", readiness);
