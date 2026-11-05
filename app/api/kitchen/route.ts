import {
  getKitchenDocument,
  KitchenConflictError,
  KitchenValidationError,
  MAX_KITCHEN_BODY_BYTES,
  saveKitchenDocument,
  validateKitchenWrite,
} from "@/app/lib/kitchen-store";
import { requireHousehold, requireSameOrigin, HouseholdAuthError, householdError, type HouseholdContext } from "@/app/lib/household";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: HEADERS });
}

function unavailable(): Response {
  return json({
    error: {
      code: "KITCHEN_UNAVAILABLE",
      message: "The saved kitchen is temporarily unavailable. Your local changes have not been saved.",
    },
  }, 503);
}

export async function GET(request: Request): Promise<Response> {
  try {
    return json(await getKitchenDocument(await requireHousehold(request)));
  } catch (error) {
    if (error instanceof HouseholdAuthError) return householdError(error);
    return unavailable();
  }
}

export async function PUT(request: Request): Promise<Response> {
  let context: HouseholdContext;
  try {
    requireSameOrigin(request);
    context = await requireHousehold(request);
    if (context.mode === "hosted" && (!request.headers.get("x-rag-chef-actor") || !request.headers.get("x-rag-chef-household"))) throw new HouseholdAuthError("SESSION_SCOPE_REQUIRED", "Refresh this tab before saving to the shared household.");
  } catch (error) { return householdError(error); }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return json({ error: { code: "INVALID_CONTENT_TYPE", message: "Send the kitchen as application/json." } }, 415);
  }
  const declaredSize = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_KITCHEN_BODY_BYTES) {
    return json({ error: { code: "KITCHEN_TOO_LARGE", message: "The kitchen exceeds the storage limit." } }, 413);
  }

  let input: unknown;
  try {
    // Bound streamed bodies too: Content-Length is optional and untrusted.
    const reader = request.body?.getReader();
    if (!reader) throw new KitchenValidationError("The request body is required.");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let body = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_KITCHEN_BODY_BYTES) {
        await reader.cancel();
        return json({ error: { code: "KITCHEN_TOO_LARGE", message: "The kitchen exceeds the storage limit." } }, 413);
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    input = JSON.parse(body);
  } catch {
    return json({ error: { code: "INVALID_KITCHEN", message: "The request must contain valid JSON." } }, 400);
  }

  try {
    const { revision, state } = validateKitchenWrite(input);
    return json(await saveKitchenDocument(revision, state, context));
  } catch (error) {
    if (error instanceof HouseholdAuthError) return householdError(error);
    if (error instanceof KitchenValidationError) {
      return json({ error: { code: "INVALID_KITCHEN", message: error.message } }, 400);
    }
    if (error instanceof KitchenConflictError) {
      return json({
        error: { code: "REVISION_CONFLICT", message: error.message },
        current: error.current,
      }, 409);
    }
    return unavailable();
  }
}
