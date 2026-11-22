import { cleanSocialText, requireFriendship, requireSocialAccount, socialErrorResponse } from "@/lib/server/social";
import { encodeSupabaseFilter, supabaseRestFetch } from "@/lib/server/supabase-rest";

type ListeningRow = { friendship_id?: unknown; state?: unknown; updated_by?: unknown; revision?: unknown; updated_at?: unknown };

export async function GET(request: Request) {
  try {
    const account = await requireSocialAccount(request);
    const friendshipId = cleanSocialText(new URL(request.url).searchParams.get("friendshipId"), 80);
    await requireFriendship(friendshipId, account.id);
    const result = await supabaseRestFetch<ListeningRow[]>(
      `social_listening_sessions?friendship_id=eq.${encodeSupabaseFilter(friendshipId)}&select=friendship_id,state,updated_by,revision,updated_at&limit=1`,
    );
    if (!result.ok) throw new Error(result.error);
    return Response.json({ ok: true, session: result.data[0] ?? null });
  } catch (err) {
    return socialErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const account = await requireSocialAccount(request);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const friendshipId = cleanSocialText(body.friendshipId, 80);
    await requireFriendship(friendshipId, account.id);
    const input = body.state && typeof body.state === "object" && !Array.isArray(body.state)
      ? body.state as Record<string, unknown>
      : {};
    const state = {
      leaderId: cleanSocialText(input.leaderId, 120),
      trackId: cleanSocialText(input.trackId, 120),
      title: cleanSocialText(input.title, 200),
      artist: cleanSocialText(input.artist, 200),
      coverUrl: cleanSocialText(input.coverUrl, 1000),
      isPlaying: input.isPlaying === true,
      position: Math.max(0, Math.min(86400, Number(input.position) || 0)),
      sentAt: Date.now(),
    };
    const result = await supabaseRestFetch<ListeningRow[]>(
      "social_listening_sessions?on_conflict=friendship_id&select=friendship_id,state,updated_by,revision,updated_at",
      {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({ friendship_id: friendshipId, state, updated_by: account.id, revision: Date.now(), updated_at: new Date().toISOString() }),
      },
    );
    if (!result.ok) throw new Error(result.error);
    return Response.json({ ok: true, session: result.data[0] ?? null });
  } catch (err) {
    return socialErrorResponse(err);
  }
}
