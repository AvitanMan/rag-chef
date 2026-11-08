/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { authorizeApplicationRequest, configureHouseholdRuntime, hostedMode, requireLocalRequest, secureLanMode } from "../app/lib/household";

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

function protectLocalResponse(response: Response): Response {
  const protectedResponse = new Response(response.body, response);
  protectedResponse.headers.set("Cache-Control", "private, no-store");
  protectedResponse.headers.append("Vary", "Cookie, Authorization");
  protectedResponse.headers.set("X-Content-Type-Options", "nosniff");
  protectedResponse.headers.set("X-Frame-Options", "DENY");
  protectedResponse.headers.set("Referrer-Policy", "no-referrer");
  protectedResponse.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  return protectedResponse;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    configureHouseholdRuntime(env);
    const denied = await authorizeApplicationRequest(request);
    if (denied) return secureLanMode() ? protectLocalResponse(denied) : denied;
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const image = await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
      return secureLanMode() ? protectLocalResponse(image) : image;
    }

    const response = await handler.fetch(request, env, ctx);
    if (!secureLanMode()) {
      // Only the unauthenticated standalone HTML shell is available offline.
      // It contains no kitchen state: private data is fetched separately from
      // no-store APIs. Revalidate normal browser loads while allowing the
      // service worker to retain this shell for an explicit offline fallback.
      if (hostedMode() || request.method !== "GET" || request.headers.has("authorization") || url.pathname !== "/" || url.search || !response.ok || !/^text\/html\b/i.test(response.headers.get("content-type") ?? "")) return response;
      try { requireLocalRequest(request); } catch { return response; }
      const shell = new Response(response.body, response);
      shell.headers.set("Cache-Control", "private, no-cache");
      return shell;
    }
    return protectLocalResponse(response);
  },
};

export default worker;
