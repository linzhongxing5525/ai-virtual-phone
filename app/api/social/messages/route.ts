import { cleanSocialText, createSocialId, requireFriendship, requireSocialAccount, SocialHttpError, socialErrorResponse } from "@/lib/server/social";
import { encodeSupabaseFilter, supabaseRestFetch } from "@/lib/server/supabase-rest";

type MessageRow = { id?: unknown; friendship_id?: unknown; sender_id?: unknown; body?: unknown; message_type?: unknown; created_at?: unknown; read_at?: unknown };

function toMessage(row: MessageRow) {
  return {
    id: cleanSocialText(row.id, 80),
    friendshipId: cleanSocialText(row.friendship_id, 80),
    senderId: cleanSocialText(row.sender_id, 120),
    body: cleanSocialText(row.body, 2000),
    type: cleanSocialText(row.message_type, 20) || "text",
    createdAt: cleanSocialText(row.created_at, 80),
    readAt: cleanSocialText(row.read_at, 80) || null,
  };
}

export async function GET(request: Request) {
  try {
    const account = await requireSocialAccount(request);
    const url = new URL(request.url);
    const friendshipId = cleanSocialText(url.searchParams.get("friendshipId"), 80);
    await requireFriendship(friendshipId, account.id);
    const result = await supabaseRestFetch<MessageRow[]>(
      `social_messages?friendship_id=eq.${encodeSupabaseFilter(friendshipId)}&select=id,friendship_id,sender_id,body,message_type,created_at,read_at&order=created_at.asc&limit=300`,
    );
    if (!result.ok) throw new Error(result.error);
    void supabaseRestFetch(
      `social_messages?friendship_id=eq.${encodeSupabaseFilter(friendshipId)}&sender_id=neq.${encodeSupabaseFilter(account.id)}&read_at=is.null`,
      { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ read_at: new Date().toISOString() }) },
    );
    return Response.json({ ok: true, messages: result.data.map(toMessage) });
  } catch (err) {
    return socialErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const account = await requireSocialAccount(request);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const friendshipId = cleanSocialText(body.friendshipId, 80);
    const text = cleanSocialText(body.body, 2000);
    if (!text) throw new SocialHttpError(400, "消息不能为空。");
    await requireFriendship(friendshipId, account.id);
    const result = await supabaseRestFetch<MessageRow[]>(
      "social_messages?select=id,friendship_id,sender_id,body,message_type,created_at,read_at",
      {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ id: createSocialId(), friendship_id: friendshipId, sender_id: account.id, body: text, message_type: "text" }),
      },
    );
    if (!result.ok) throw new Error(result.error);
    return Response.json({ ok: true, message: result.data[0] ? toMessage(result.data[0]) : null });
  } catch (err) {
    return socialErrorResponse(err);
  }
}
