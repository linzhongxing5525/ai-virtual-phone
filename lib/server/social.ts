import crypto from "crypto";

import { cleanAccountText, getCurrentAccount, type AppAccount } from "./account-auth";
import { encodeSupabaseFilter, supabaseRestFetch } from "./supabase-rest";

export type SocialProfile = {
  id: string;
  username: string;
  displayName: string;
};

type FriendshipRecord = {
  id?: unknown;
  user_a?: unknown;
  user_b?: unknown;
  created_at?: unknown;
};

export async function requireSocialAccount(request: Request): Promise<AppAccount> {
  const account = await getCurrentAccount(request);
  if (!account) throw new SocialHttpError(401, "请先登录账号。");
  if (account.status === "disabled") throw new SocialHttpError(403, "当前账号已被停用。");
  return account;
}

export class SocialHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function socialErrorResponse(err: unknown): Response {
  const status = err instanceof SocialHttpError ? err.status : 500;
  const raw = err instanceof Error ? err.message : String(err);
  const message = /social_|schema cache|does not exist|PGRST/i.test(raw)
    ? "真人社交数据表尚未创建，请先执行 docs/social-supabase.sql。"
    : raw;
  return Response.json({ ok: false, error: message }, { status });
}

export function createSocialId(): string {
  return crypto.randomUUID();
}

export function cleanSocialText(value: unknown, maxLength: number): string {
  return cleanAccountText(value, maxLength).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

export function friendshipPair(left: string, right: string): [string, string] {
  // Account IDs are ASCII-only. Match PostgreSQL's explicit C collation in
  // docs/social-supabase.sql so every server produces the same canonical pair.
  return left <= right ? [left, right] : [right, left];
}

function isSafeSocialUserId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,120}$/.test(value);
}

function toFriendship(record: FriendshipRecord) {
  return {
    id: cleanSocialText(record.id, 80),
    userA: cleanSocialText(record.user_a, 120),
    userB: cleanSocialText(record.user_b, 120),
    createdAt: cleanSocialText(record.created_at, 80),
  };
}

export async function requireFriendship(friendshipId: string, userId: string) {
  const id = cleanSocialText(friendshipId, 80);
  if (!id) throw new SocialHttpError(400, "缺少好友关系 ID。");
  const result = await supabaseRestFetch<FriendshipRecord[]>(
    `social_friendships?id=eq.${encodeSupabaseFilter(id)}&select=id,user_a,user_b,created_at&limit=1`,
  );
  if (!result.ok) throw new Error(result.error);
  const friendship = result.data[0] ? toFriendship(result.data[0]) : null;
  if (!friendship || (friendship.userA !== userId && friendship.userB !== userId)) {
    throw new SocialHttpError(404, "好友关系不存在。");
  }
  return friendship;
}

export async function loadProfiles(userIds: string[]): Promise<Map<string, SocialProfile>> {
  const ids = [...new Set(
    userIds
      .map(id => cleanSocialText(id, 120))
      .filter(id => id && isSafeSocialUserId(id)),
  )];
  const map = new Map<string, SocialProfile>();
  if (ids.length === 0) return map;
  const filter = encodeURIComponent(`(${ids.join(",")})`);
  const result = await supabaseRestFetch<Array<{ id?: unknown; username?: unknown; display_name?: unknown }>>(
    `app_users?id=in.${filter}&select=id,username,display_name`,
  );
  if (!result.ok) throw new Error(result.error);
  for (const item of result.data) {
    const id = cleanSocialText(item.id, 120);
    const username = cleanSocialText(item.username, 40);
    if (!id || !username) continue;
    map.set(id, {
      id,
      username,
      displayName: cleanSocialText(item.display_name, 80) || username,
    });
  }
  return map;
}
