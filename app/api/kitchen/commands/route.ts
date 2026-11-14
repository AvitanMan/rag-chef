import { withGatewayTrace } from "@/app/lib/service-observability";
import { kitchenService, KitchenConflictError, KitchenCommandReuseError } from "@/app/lib/kitchen-service";
import { KitchenCommandValidationError, MAX_KITCHEN_COMMAND_BYTES, parseKitchenCommand } from "@/app/lib/kitchen-command-validation";
import { KitchenValidationError } from "@/app/lib/kitchen-validation";
import { HouseholdAuthError, householdError, requireHousehold, requireSameOrigin, type HouseholdContext } from "@/app/lib/household";

export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const errorResponse = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

async function handlePOST(request: Request): Promise<Response> {
  let context: HouseholdContext;
  try {
    requireSameOrigin(request);
    context = await requireHousehold(request);
    if (context.mode === "hosted" && (!request.headers.get("x-rag-chef-actor") || !request.headers.get("x-rag-chef-household"))) {
      throw new HouseholdAuthError("SESSION_SCOPE_REQUIRED", "Refresh this tab before saving to the shared household.");
    }
  } catch (error) { return householdError(error); }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return errorResponse(415, "INVALID_CONTENT_TYPE", "Send a kitchen command as application/json.");
  }
  if (Number(request.headers.get("content-length")) > MAX_KITCHEN_COMMAND_BYTES) { void request.body?.cancel().catch(() => {}); return tooLarge(); }
  let input: unknown;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = request.body?.getReader();
    if (!reader) return errorResponse(400, "INVALID_COMMAND", "A JSON command is required.");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0, body = "";
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_KITCHEN_COMMAND_BYTES) { void reader.cancel().catch(() => {}); return tooLarge(); }
      body += decoder.decode(chunk.value, { stream: true });
    }
    input = JSON.parse(body + decoder.decode());
  } catch { void reader?.cancel().catch(() => {}); return errorResponse(400, "INVALID_COMMAND", "The command must contain valid JSON."); }
  finally { reader?.releaseLock(); }
  try {
    return json(await kitchenService.execute(parseKitchenCommand(input), context));
  } catch (error) {
    if (error instanceof HouseholdAuthError) return householdError(error);
    if (error instanceof KitchenCommandValidationError || error instanceof KitchenValidationError) return errorResponse(400, "INVALID_COMMAND", error.message);
    if (error instanceof KitchenCommandReuseError) return errorResponse(409, "COMMAND_ID_REUSED", error.message);
    if (error instanceof KitchenConflictError) return json({ error: { code: "REVISION_CONFLICT", message: error.message }, current: error.current }, 409);
    return errorResponse(503, "KITCHEN_UNAVAILABLE", "The saved kitchen is temporarily unavailable. Retry this same command when connected.");
  }
}

function tooLarge() { return errorResponse(413, "COMMAND_TOO_LARGE", "The command exceeds the storage limit."); }

export const POST = withGatewayTrace("kitchen.command", handlePOST);
