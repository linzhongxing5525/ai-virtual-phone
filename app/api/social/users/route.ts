import { requireSocialAccount, cleanSocialText, loadProfiles, socialErrorResponse } from "@/lib/server/social";
import { supabaseRestFetch } from "@/lib/server/supabase-rest";

export async function GET(request: Request) {
  try {
    const account = await requireSocialAccount(request);
    const url = new URL(request.url);
    const q = cleanSocialText(url.searchParams.get("q"), 40).replace(/[^\p{L}\p{N}_@.\-]/gu, "");
    if (q.length < 2) return Response.json({ ok: true, users: [] });
    const orFilter = encodeURIComponent(`(username.ilike.*${q}*,display_name.ilike.*${q}*)`);
    const result = await supabaseRestFetch<Array<{ id?: unknown }>>(
      `app_users?status=eq.active&or=${orFilter}&select=id&limit=20`,
    );
    if (!result.ok) throw new Error(result.error);
    const ids = result.data.map(item => cleanSocialText(item.id, 120)).filter(id => id && id !== account.id);
    const profiles = await loadProfiles(ids);
    return Response.json({ ok: true, users: ids.map(id => profiles.get(id)).filter(Boolean) });
  } catch (err) {
    return socialErrorResponse(err);
  }
}
