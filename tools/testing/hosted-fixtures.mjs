// Synthetic identities are inserted only by the isolated runner, never an API.
export const HOSTED_TEST_SECRET = "isolated-hosted-auth-4f4767bd39574da689355db0";
export const HOSTED_TEST_ENCRYPTION_KEY = Buffer.alloc(32, 83).toString("base64");
export function hostedFixtureSql() {
  const at = new Date().toISOString(), expires = new Date(Date.now() + 86_400_000).toISOString();
  return ["desktop", "mobile"].flatMap(device => ["owner", "member", "other", "admin"].flatMap(role => {
    const id = `${role}-${device}`;
    return [
      `INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('${id}','${id}','${id}@example.test',1,'${at}','${at}');`,
      `INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES('session-${id}','${id}','token-${id}','${expires}','${at}','${at}');`,
    ];
  })).join("\n");
}
