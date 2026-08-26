import { eq } from "drizzle-orm";
import { pendingUsers, users } from "@db/schema";
import { getDb } from "./connection";

export type OAuthIdentity = {
  linuxdoId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  trustLevel: number;
};

/**
 * OAuth 只完成身份验证，不等于注册完成。
 * 已注册身份更新 users；新身份只进入 pending_users，直到必填资料和邀请码校验通过。
 */
export async function upsertOAuthIdentity(identity: OAuthIdentity) {
  const db = getDb();
  const registered = (await db.select().from(users).where(eq(users.linuxdoId, identity.linuxdoId)).limit(1))[0];
  if (registered) {
    await db.update(users).set({
      username: identity.username,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      trustLevel: identity.trustLevel,
    }).where(eq(users.id, registered.id));
    return {
      kind: "registered" as const,
      user: { ...registered, ...identity },
    };
  }

  const existing = (await db.select().from(pendingUsers)
    .where(eq(pendingUsers.linuxdoId, identity.linuxdoId)).limit(1))[0];
  if (existing) {
    await db.update(pendingUsers).set({
      username: identity.username,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      trustLevel: identity.trustLevel,
      updatedAt: new Date(),
    }).where(eq(pendingUsers.id, existing.id));
    return { kind: "pending" as const, user: { ...existing, ...identity, updatedAt: new Date() } };
  }

  const [created] = await db.insert(pendingUsers).values(identity).returning();
  return { kind: "pending" as const, user: created };
}
