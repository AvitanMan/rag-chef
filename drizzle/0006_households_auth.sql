-- Better Auth core and organization plugin. Dates use the native D1 adapter's ISO representation.
CREATE TABLE user (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE TABLE session (id TEXT PRIMARY KEY NOT NULL, expiresAt TEXT NOT NULL, token TEXT NOT NULL UNIQUE, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, ipAddress TEXT, userAgent TEXT, userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, activeOrganizationId TEXT);
CREATE INDEX session_user_idx ON session(userId);
CREATE TABLE account (id TEXT PRIMARY KEY NOT NULL, accountId TEXT NOT NULL, providerId TEXT NOT NULL, userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, accessToken TEXT, refreshToken TEXT, idToken TEXT, accessTokenExpiresAt TEXT, refreshTokenExpiresAt TEXT, scope TEXT, password TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE INDEX account_user_idx ON account(userId);
CREATE UNIQUE INDEX account_provider_uidx ON account(providerId, accountId);
CREATE TABLE verification (id TEXT PRIMARY KEY NOT NULL, identifier TEXT NOT NULL, value TEXT NOT NULL, expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE INDEX verification_identifier_idx ON verification(identifier);
CREATE TABLE organization (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, logo TEXT, metadata TEXT, createdAt TEXT NOT NULL);
CREATE TABLE member (id TEXT PRIMARY KEY NOT NULL, organizationId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE, userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('owner','member')), createdAt TEXT NOT NULL);
-- One account belongs to exactly zero or one household, including concurrent invite acceptance.
CREATE UNIQUE INDEX member_one_household_uidx ON member(userId);
CREATE INDEX member_org_idx ON member(organizationId);
CREATE UNIQUE INDEX household_one_owner_uidx ON member(organizationId) WHERE role='owner';
CREATE TABLE invitation (id TEXT PRIMARY KEY NOT NULL, organizationId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE, email TEXT NOT NULL, role TEXT, status TEXT NOT NULL DEFAULT 'pending', expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL, inviterId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE);
CREATE INDEX invitation_org_idx ON invitation(organizationId);
CREATE INDEX invitation_email_idx ON invitation(email);
CREATE TABLE household_settings (organizationId TEXT PRIMARY KEY NOT NULL REFERENCES organization(id) ON DELETE CASCADE, timezone TEXT NOT NULL DEFAULT 'UTC', assistantEnabled INTEGER NOT NULL DEFAULT 0);
-- Local rows remain untouched. Hosted document IDs are authenticated organization IDs.
CREATE TRIGGER household_kitchen_cleanup AFTER DELETE ON organization BEGIN DELETE FROM kitchen_state WHERE id=OLD.id; END;
