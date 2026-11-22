import { cleanSocialText, createSocialId, requireFriendship, requireSocialAccount, SocialHttpError, socialErrorResponse } from "@/lib/server/social";
import { encodeSupabaseFilter, supabaseRestFetch } from "@/lib/server/supabase-rest";

type MessageRow = { id?: unknown; friendship_id?: unknown; sender_id?: unknown; body?: unknown; message_type?: unknown; created_at?: unknown; read_at?: unknown };

const SHARED_WORLD_PREFIX = "[[ai-phone-shared-world:v1]]";

type SharedWorldEnvelope = {
  actorType?: unknown;
  actorName?: unknown;
  actorOwnerId?: unknown;
  actorLocalId?: unknown;
  text?: unknown;
};

function readSharedWorldEnvelope(raw: string): {
  body: string;
  actor: { type: "ai"; name: string; ownerId: string; localId: string } | null;
} {
  if (!raw.startsWith(SHARED_WORLD_PREFIX)) return { body: raw, actor: null };
  try {
    const value = JSON.parse(raw.slice(SHARED_WORLD_PREFIX.length)) as SharedWorldEnvelope;
    const name = cleanSocialText(value.actorName, 80);
    const ownerId = cleanSocialText(value.actorOwnerId, 120);
    const localId = cleanSocialText(value.actorLocalId, 120);
    const text = cleanSocialText(value.text, 1500);
    if (value.actorType !== "ai" || !name || !ownerId || !text) return { body: raw, actor: null };
    return { body: text, actor: { type: "ai", name, ownerId, localId } };
  } catch {
    return { body: raw, actor: null };
  }
}

function toMessage(row: MessageRow) {
  const decoded = readSharedWorldEnvelope(cleanSocialText(row.body, 2500));
  return {
    id: cleanSocialText(row.id, 80),
    friendshipId: cleanSocialText(row.friendship_id, 80),
    senderId: cleanSocialText(row.sender_id, 120),
    body: decoded.body,
    type: cleanSocialText(row.message_type, 20) || "text",
    actor: decoded.actor,
    createdAt: cleanSocialText(row.created_at, 80),
    readAt: cleanSocialText(row.read_at, 80) || null,
  };
}

export async function GET(request: Request) {
  try {
    const account = await requireSocialAccount(request);
    const url = new URL(request.url);
    const friendshipId = cleanSocialText(url.searchParams.get("friendshipId"), 80);
    const markRead = url.searchParams.get("markRead") !== "false";
    await requireFriendship(friendshipId, account.id);
    const result = await supabaseRestFetch<MessageRow[]>(
      `social_messages?friendship_id=eq.${encodeSupabaseFilter(friendshipId)}&select=id,friendship_id,sender_id,body,message_type,created_at,read_at&order=created_at.asc&limit=300`,
    );
    if (!result.ok) throw new Error(result.error);
    if (markRead) {
      void supabaseRestFetch(
        `social_messages?friendship_id=eq.${encodeSupabaseFilter(friendshipId)}&sender_id=neq.${encodeSupabaseFilter(account.id)}&read_at=is.null`,
        { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ read_at: new Date().toISOString() }) },
      );
    }
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
    const actorInput = body.actor && typeof body.actor === "object" ? body.actor as Record<string, unknown> : null;
    const isAi = actorInput?.type === "ai";
    const text = cleanSocialText(body.body, isAi ? 1500 : 2000);
    if (!text) throw new SocialHttpError(400, "消息不能为空。");
    await requireFriendship(friendshipId, account.id);
    let storedBody = text;
    let messageType = "text";
    if (isAi) {
      const actorName = cleanSocialText(actorInput?.name, 80);
      const actorLocalId = cleanSocialText(actorInput?.localId, 120);
      if (!actorName || !actorLocalId) throw new SocialHttpError(400, "AI 角色信息不完整。");
      storedBody = `${SHARED_WORLD_PREFIX}${JSON.stringify({
        actorType: "ai",
        actorName,
        actorOwnerId: account.id,
        actorLocalId,
        text,
      })}`;
      messageType = "system";
    }
    const result = await supabaseRestFetch<MessageRow[]>(
      "social_messages?select=id,friendship_id,sender_id,body,message_type,created_at,read_at",
      {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ id: createSocialId(), friendship_id: friendshipId, sender_id: account.id, body: storedBody, message_type: messageType }),
      },
    );
    if (!result.ok) throw new Error(result.error);
    return Response.json({ ok: true, message: result.data[0] ? toMessage(result.data[0]) : null });
  } catch (err) {
    return socialErrorResponse(err);
  }
}
