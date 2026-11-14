// Synthetic identities are inserted only into the isolated runner's disposable DB.
export const HOSTED_TEST_SECRET = "isolated-hosted-auth-4f4767bd39574da689355db0";
export const HOSTED_SCENARIOS = ["sharing", "stocktake", "revocation", "switching", "timezone"];
const identities = ["desktop", "mobile"].flatMap(device => HOSTED_SCENARIOS.flatMap(scenario =>
  ["owner", "member", "other", "admin"].map(role => ({ id: `${role}-${scenario}-${device}`, role }))));
export const HOSTED_OWNER_EMAILS = identities.filter(({ role }) => ["owner", "other"].includes(role)).map(({ id }) => `${id}@example.test`).join(",");
export const HOSTED_ADMIN_EMAILS = identities.filter(({ role }) => role === "admin").map(({ id }) => `${id}@example.test`).join(",");
export function hostedFixtureSql() {
  const at = new Date().toISOString(), expires = new Date(Date.now() + 86_400_000).toISOString();
  return identities.flatMap(({ id }) => [
    `INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('${id}','${id}','${id}@example.test',1,'${at}','${at}');`,
    `INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES('session-${id}','${id}','token-${id}','${expires}','${at}','${at}');`,
  ]).join("\n");
}
