import { readHousehold, createHousehold, updateHousehold, deleteHousehold } from "@/app/lib/household-management";
import { householdError, initializeHouseholdRuntime } from "@/app/lib/household";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> { try { await initializeHouseholdRuntime(); return await readHousehold(request); } catch (error) { return householdError(error); } }
export async function POST(request: Request): Promise<Response> { try { await initializeHouseholdRuntime(); return await createHousehold(request); } catch (error) { return householdError(error); } }
export async function PATCH(request: Request): Promise<Response> { try { await initializeHouseholdRuntime(); return await updateHousehold(request); } catch (error) { return householdError(error); } }
export async function DELETE(request: Request): Promise<Response> { try { await initializeHouseholdRuntime(); return await deleteHousehold(request); } catch (error) { return householdError(error); } }
