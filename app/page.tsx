import RagChefApp from "./components/RagChefApp";
import { AppSessionGate } from "./components/AppSessionGate";
import { hostedMode, initializeHouseholdRuntime } from "./lib/household";

export const dynamic = "force-dynamic";

export default async function Home() {
  await initializeHouseholdRuntime();
  return <AppSessionGate hosted={hostedMode()}><RagChefApp /></AppSessionGate>;
}
