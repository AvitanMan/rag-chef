import type { Request } from "@playwright/test";

/** Observe both compatibility snapshots and durable commands in write assertions. */
export function isKitchenWrite(request: Pick<Request, "url" | "method">): boolean {
  return ["/api/kitchen", "/api/kitchen/commands"].includes(new URL(request.url()).pathname)
    && ["PUT", "POST"].includes(request.method());
}

export function kitchenWriteRevision(request: Request): number {
  const body = request.postDataJSON();
  return request.method() === "POST" ? body.expectedRevision : body.revision;
}
