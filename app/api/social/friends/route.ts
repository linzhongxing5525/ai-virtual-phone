import {
  cleanSocialText,
  createSocialId,
  friendshipPair,
  loadProfiles,
  requireSocialAccount,
  SocialHttpError,
  socialErrorResponse,
} from "@/lib/server/social";
import { encodeSupabaseFilter, supabaseRestFetch } from "@/lib/server/supabase-rest";

type FriendshipRow = { id?: unknown; user_a?: unknown; user_b?: unknown; created_at?: unknown };
type RequestRow = { id?: unknown; from_user_id?: unknown; to_user_id?: unknown; message?: unknown; status?: unknown; created_at?: unknown };

export async function GET(request: Request) {
  try {
    const account = await requireSocialAccount(request);
    const userFilter = encodeURIComponent(`(user_a.eq.${account.id},user_b.eq.${account.id})`);
    const requestFilter = encodeURIComponent(`(from_user_id.eq.${account.id},to_user_id.eq.${account.id})`);
    const [friendshipsResult, requestsResult] = await Promise.all([
      supabaseRestFetch<FriendshipRow[]>(
        `social_friendships?or=${userFilter}&select=id,user_a,user_b,created_at&order=created_at.desc`,
      ),
      supabaseRestFetch<RequestRow[]>(
        `social_friend_requests?or=${requestFilter}&status=eq.pending&select=id,from_user_id,to_user_id,message,status,created_at&order=created_at.desc`,
      ),
    ]);
    if (!friendshipsResult.ok) throw new Error(friendshipsResult.error);
    if (!requestsResult.ok) throw new Error(requestsResult.error);
    const relatedIds = [
      ...friendshipsResult.data.flatMap(row => [cleanSocialText(row.user_a, 120), cleanSocialText(row.user_b, 120)]),
      ...requestsResult.data.flatMap(row => [cleanSocialText(row.from_user_id, 120), cleanSocialText(row.to_user_id, 120)]),
    ].filter(id => id && id !== account.id);
    const profiles = await loadProfiles(relatedIds);
    const friends = friendshipsResult.data.map(row => {
      const userA = cleanSocialText(row.user_a, 120);
      const userB = cleanSocialText(row.user_b, 120);
      const friendId = userA === account.id ? userB : userA;
      return {
        friendshipId: cleanSocialText(row.id, 80),
        createdAt: cleanSocialText(row.created_at, 80),
        profile: profiles.get(friendId) ?? null,
      };
    }).filter(item => item.friendshipId && item.profile);
    const requests = requestsResult.data.map(row => {
      const fromUserId = cleanSocialText(row.from_user_id, 120);
      const toUserId = cleanSocialText(row.to_user_id, 120);
      const incoming = toUserId === account.id;
      const otherUserId = incoming ? fromUserId : toUserId;
      return {
        id: cleanSocialText(row.id, 80),
        incoming,
        message: cleanSocialText(row.message, 300),
        createdAt: cleanSocialText(row.created_at, 80),
        profile: profiles.get(otherUserId) ?? null,
      };
    }).filter(item => item.id && item.profile);
    return Response.json({ ok: true, friends, requests });
  } catch (err) {
    return socialErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const account = await requireSocialAccount(request);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = cleanSocialText(body.action, 30);
    if (action === "send") {
      const targetUserId = cleanSocialText(body.targetUserId, 120);
      if (!targetUserId || targetUserId === account.id) throw new SocialHttpError(400, "不能添加自己为好友。");
      const profile = await loadProfiles([targetUserId]);
      if (!profile.has(targetUserId)) throw new SocialHttpError(404, "没有找到该账号。");
      const [userA, userB] = friendshipPair(account.id, targetUserId);
      const exists = await supabaseRestFetch<Array<{ id?: unknown }>>(
        `social_friendships?user_a=eq.${encodeSupabaseFilter(userA)}&user_b=eq.${encodeSupabaseFilter(userB)}&select=id&limit=1`,
      );
      if (!exists.ok) throw new Error(exists.error);
      if (exists.data.length > 0) throw new SocialHttpError(409, "你们已经是好友了。");
      const reverse = await supabaseRestFetch<RequestRow[]>(
        `social_friend_requests?from_user_id=eq.${encodeSupabaseFilter(targetUserId)}&to_user_id=eq.${encodeSupabaseFilter(account.id)}&status=eq.pending&select=id&limit=1`,
      );
      if (!reverse.ok) throw new Error(reverse.error);
      if (reverse.data[0]) {
        return acceptRequest(cleanSocialText(reverse.data[0].id, 80), account.id);
      }
      const created = await supabaseRestFetch<RequestRow[]>("social_friend_requests?select=id,from_user_id,to_user_id,message,status,created_at", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          id: createSocialId(),
          from_user_id: account.id,
          to_user_id: targetUserId,
          message: cleanSocialText(body.message, 300),
          status: "pending",
        }),
      });
      if (!created.ok) {
        if (/duplicate key/i.test(created.error)) throw new SocialHttpError(409, "好友申请已经发送过了。");
        throw new Error(created.error);
      }
      return Response.json({ ok: true, request: created.data[0] ?? null });
    }
    if (action === "accept") return acceptRequest(cleanSocialText(body.requestId, 80), account.id);
    if (action === "reject" || action === "cancel") {
      const requestId = cleanSocialText(body.requestId, 80);
      if (!requestId) throw new SocialHttpError(400, "缺少好友申请 ID。");
      const side = action === "reject" ? `to_user_id=eq.${encodeSupabaseFilter(account.id)}` : `from_user_id=eq.${encodeSupabaseFilter(account.id)}`;
      const patched = await supabaseRestFetch<RequestRow[]>(
        `social_friend_requests?id=eq.${encodeSupabaseFilter(requestId)}&${side}&status=eq.pending&select=id`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ status: action === "reject" ? "rejected" : "cancelled", updated_at: new Date().toISOString() }),
        },
      );
      if (!patched.ok) throw new Error(patched.error);
      if (patched.data.length === 0) throw new SocialHttpError(404, "好友申请不存在或已处理。");
      return Response.json({ ok: true });
    }
    if (action === "remove") {
      const friendshipId = cleanSocialText(body.friendshipId, 80);
      const membership = encodeURIComponent(`(user_a.eq.${account.id},user_b.eq.${account.id})`);
      const removed = await supabaseRestFetch<FriendshipRow[]>(
        `social_friendships?id=eq.${encodeSupabaseFilter(friendshipId)}&or=${membership}&select=id`,
        { method: "DELETE", headers: { Prefer: "return=representation" } },
      );
      if (!removed.ok) throw new Error(removed.error);
      if (removed.data.length === 0) throw new SocialHttpError(404, "好友关系不存在。");
      return Response.json({ ok: true });
    }
    throw new SocialHttpError(400, "不支持的好友操作。");
  } catch (err) {
    return socialErrorResponse(err);
  }
}

async function acceptRequest(requestId: string, currentUserId: string): Promise<Response> {
  if (!requestId) throw new SocialHttpError(400, "缺少好友申请 ID。");
  const found = await supabaseRestFetch<RequestRow[]>(
    `social_friend_requests?id=eq.${encodeSupabaseFilter(requestId)}&to_user_id=eq.${encodeSupabaseFilter(currentUserId)}&status=eq.pending&select=id,from_user_id,to_user_id&limit=1`,
  );
  if (!found.ok) throw new Error(found.error);
  const row = found.data[0];
  if (!row) throw new SocialHttpError(404, "好友申请不存在或已处理。");
  const fromId = cleanSocialText(row.from_user_id, 120);
  const toId = cleanSocialText(row.to_user_id, 120);
  const [userA, userB] = friendshipPair(fromId, toId);
  const friendship = await supabaseRestFetch<FriendshipRow[]>(
    "social_friendships?on_conflict=user_a,user_b&select=id,user_a,user_b,created_at",
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ id: createSocialId(), user_a: userA, user_b: userB }),
    },
  );
  if (!friendship.ok) throw new Error(friendship.error);
  const patched = await supabaseRestFetch<RequestRow[]>(
    `social_friend_requests?id=eq.${encodeSupabaseFilter(requestId)}&status=eq.pending&select=id`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ status: "accepted", updated_at: new Date().toISOString() }),
    },
  );
  if (!patched.ok) throw new Error(patched.error);
  return Response.json({ ok: true, friendship: friendship.data[0] ?? null });
}
