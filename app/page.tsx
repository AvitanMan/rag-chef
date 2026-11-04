import RagChefApp from "./components/RagChefApp";
import { AppSessionGate } from "./components/AppSessionGate";
import { hostedMode, initializeHouseholdRuntime } from "./lib/household";

import { publicLocalServerConfig } from "./lib/local-server-config";

export const dynamic = "force-dynamic";

export default async function Home() {
  await initializeHouseholdRuntime();
  return <AppSessionGate hosted={hostedMode()} localServer={publicLocalServerConfig()}><RagChefApp /></AppSessionGate>;
}
