import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins/organization";
import { householdDb, householdSetting, HouseholdAuthError, hostedMode, initializeHouseholdRuntime } from "./household";

export function validateHostedConfiguration(): { origin: string; secret: string; clientId: string; clientSecret: string } {
  const origin = householdSetting("BETTER_AUTH_URL");
  const secret = householdSetting("BETTER_AUTH_SECRET");
  const clientId = householdSetting("GOOGLE_CLIENT_ID");
  const clientSecret = householdSetting("GOOGLE_CLIENT_SECRET");
  let url: URL;
  try { url = new URL(origin); } catch { throw new HouseholdAuthError("HOSTED_NOT_CONFIGURED", "Hosted sign-in is not configured.", 503); }
  const secureOrigin = url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!hostedMode() || secret.length < 32 || !clientId || !clientSecret || url.origin !== origin || !secureOrigin) {
    throw new HouseholdAuthError("HOSTED_NOT_CONFIGURED", "Hosted sign-in is not configured.", 503);
  }
  return { origin, secret, clientId, clientSecret };
}

export async function getAuth() {
  await initializeHouseholdRuntime();
  const { origin, secret, clientId, clientSecret } = validateHostedConfiguration();
  return betterAuth({
    appName: "RAG Chef", baseURL: origin, basePath: "/api/auth", secret,
    database: await householdDb(), trustedOrigins: [origin],
    socialProviders: { google: { clientId, clientSecret } },
    emailAndPassword: { enabled: false },
    session: { expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
    advanced: { useSecureCookies: origin.startsWith("https:"), defaultCookieAttributes: { httpOnly: true, sameSite: "lax" } },
    plugins: [organization({ allowUserToCreateOrganization: false, creatorRole: "owner", membershipLimit: 20, invitationExpiresIn: 60 * 60 * 24 * 7 })],
  });
}
