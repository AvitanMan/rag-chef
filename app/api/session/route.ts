import { sessionResponse } from "@/app/lib/household-management";
import { householdError, initializeHouseholdRuntime, secureLanMode } from "@/app/lib/household";
import { publicLocalServerConfig } from "@/app/lib/local-server-config";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> { try { await initializeHouseholdRuntime(); if (secureLanMode()) { const { localSessionResponse } = await import("@/app/lib/local-auth"); return await localSessionResponse(request); } const response = await sessionResponse(request);
  const localServer = publicLocalServerConfig();
  if (!localServer || !response.ok) return response;
  const session = await response.json() as Record<string, unknown>;
  return Response.json({ ...session, localServer }, { headers: { "Cache-Control": "no-store" } }); } catch (error) { return householdError(error); } }
