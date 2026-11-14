import { withGatewayTrace } from "../app/lib/service-observability";
/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { authorizeApplicationRequest, configureHouseholdRuntime, hostedMode, requireLocalRequest } from "../app/lib/household";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  configureHouseholdRuntime(env);
  const denied = await authorizeApplicationRequest(request);
  if (denied) return denied;
  const url = new URL(request.url);

  if (url.pathname === "/_vinext/image") {
    const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
    return handleImageOptimization(request, {
      fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
      transformImage: async (body, { width, format, quality }) => {
        const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
        return result.response();
      },
    }, allowedWidths);
  }

  const response = await handler.fetch(request, env, ctx);
  if (hostedMode() && (url.pathname.startsWith("/api/") || /^text\/html\b/i.test(response.headers.get("content-type") ?? ""))) {
    const privateResponse = new Response(response.body, response);
    privateResponse.headers.set("Cache-Control", "private, no-store");
    return privateResponse;
  }
  // Only the unauthenticated loopback HTML shell is available offline.
  // Kitchen data is fetched separately through no-store APIs. Normal loads
  // still revalidate while the service worker keeps an explicit fallback.
  if (!hostedMode() && request.method === "GET" && !request.headers.has("authorization") && url.pathname === "/" && !url.search && response.ok && /^text\/html\b/i.test(response.headers.get("content-type") ?? "")) {
    try { requireLocalRequest(request); } catch { return response; }
    const shell = new Response(response.body, response);
    shell.headers.set("Cache-Control", "private, no-cache");
    return shell;
  }
  return response;
}
const worker = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new URL(request.url).pathname.startsWith("/api/")
      ? withGatewayTrace("gateway.request", (request: Request) => handleFetch(request, env, ctx))(request)
      : handleFetch(request, env, ctx);
  },
};
export default worker;
