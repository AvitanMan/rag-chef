/** Explicit test composition for app routes that use the private read service. */
export async function attachCatalogReadBinding(sources, env) {
  const { localCatalogReadService } = await sources.import("app/lib/catalog-read-service.ts");
  const { serviceResponseHeaders } = await sources.import("app/lib/service-observability.ts");
  env.CATALOG = {
    async fetch(_url, options) {
      const { method, args } = JSON.parse(options.body);
      if (!["list", "embeddings", "sourcePolicy", "configured", "search"].includes(method)) throw new Error("Unknown catalog read method");
      const values = args.map(value => value === null ? undefined : value);
      if (method === "search") values[0] = { ...values[0], signal: options.signal };
      return Response.json(await localCatalogReadService[method](...values), { headers: serviceResponseHeaders() });
    },
  };
}
