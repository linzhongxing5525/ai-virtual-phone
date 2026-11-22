import {
  cleanSocialText,
  createSocialId,
  loadProfiles,
  requireSocialAccount,
  SocialHttpError,
  socialErrorResponse,
} from "@/lib/server/social";
import { encodeSupabaseFilter, supabaseRestFetch } from "@/lib/server/supabase-rest";

type PostRow = { id?: unknown; author_id?: unknown; body?: unknown; image_url?: unknown; created_at?: unknown; updated_at?: unknown };
type LikeRow = { post_id?: unknown; user_id?: unknown; created_at?: unknown };
type CommentRow = { id?: unknown; post_id?: unknown; author_id?: unknown; body?: unknown; created_at?: unknown };

export async function GET(request: Request) {
  try {
    const account = await requireSocialAccount(request);
    const friendFilter = encodeURIComponent(`(user_a.eq.${account.id},user_b.eq.${account.id})`);
    const friendships = await supabaseRestFetch<Array<{ user_a?: unknown; user_b?: unknown }>>(
      `social_friendships?or=${friendFilter}&select=user_a,user_b`,
    );
    if (!friendships.ok) throw new Error(friendships.error);
    const authorIds = [...new Set([
      account.id,
      ...friendships.data.map(row => {
        const a = cleanSocialText(row.user_a, 120);
        const b = cleanSocialText(row.user_b, 120);
        return a === account.id ? b : a;
      }).filter(Boolean),
    ])];
    const authorsFilter = encodeURIComponent(`(${authorIds.join(",")})`);
    const postsResult = await supabaseRestFetch<PostRow[]>(
      `social_posts?author_id=in.${authorsFilter}&deleted_at=is.null&select=id,author_id,body,image_url,created_at,updated_at&order=created_at.desc&limit=100`,
    );
    if (!postsResult.ok) throw new Error(postsResult.error);
    const postIds = postsResult.data.map(row => cleanSocialText(row.id, 80)).filter(Boolean);
    const [likesResult, commentsResult] = postIds.length > 0
      ? await Promise.all([
          supabaseRestFetch<LikeRow[]>(`social_post_likes?post_id=in.${encodeURIComponent(`(${postIds.join(",")})`)}&select=post_id,user_id,created_at`),
          supabaseRestFetch<CommentRow[]>(`social_post_comments?post_id=in.${encodeURIComponent(`(${postIds.join(",")})`)}&select=id,post_id,author_id,body,created_at&order=created_at.asc`),
        ])
      : [{ ok: true as const, data: [], status: 200 }, { ok: true as const, data: [], status: 200 }];
    if (!likesResult.ok) throw new Error(likesResult.error);
    if (!commentsResult.ok) throw new Error(commentsResult.error);
    const profileIds = [
      ...authorIds,
      ...likesResult.data.map(row => cleanSocialText(row.user_id, 120)),
      ...commentsResult.data.map(row => cleanSocialText(row.author_id, 120)),
    ];
    const profiles = await loadProfiles(profileIds);
    const posts = postsResult.data.map(row => {
      const id = cleanSocialText(row.id, 80);
      const authorId = cleanSocialText(row.author_id, 120);
      const likes = likesResult.data.filter(like => cleanSocialText(like.post_id, 80) === id).map(like => {
        const userId = cleanSocialText(like.user_id, 120);
        return { userId, profile: profiles.get(userId) ?? null, createdAt: cleanSocialText(like.created_at, 80) };
      });
      const comments = commentsResult.data.filter(comment => cleanSocialText(comment.post_id, 80) === id).map(comment => {
        const userId = cleanSocialText(comment.author_id, 120);
        return {
          id: cleanSocialText(comment.id, 80),
          userId,
          profile: profiles.get(userId) ?? null,
          body: cleanSocialText(comment.body, 1000),
          createdAt: cleanSocialText(comment.created_at, 80),
        };
      });
      return {
        id,
        authorId,
        author: profiles.get(authorId) ?? null,
        body: cleanSocialText(row.body, 3000),
        imageUrl: cleanSocialText(row.image_url, 1000) || null,
        createdAt: cleanSocialText(row.created_at, 80),
        mine: authorId === account.id,
        likedByMe: likes.some(like => like.userId === account.id),
        likes,
        comments,
      };
    }).filter(post => post.id && post.author);
    return Response.json({ ok: true, posts });
  } catch (err) {
    return socialErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const account = await requireSocialAccount(request);
    const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = cleanSocialText(payload.action, 30) || "create";
    if (action === "create") {
      const body = cleanSocialText(payload.body, 3000);
      const imageUrl = cleanSocialText(payload.imageUrl, 1000);
      if (!body && !imageUrl) throw new SocialHttpError(400, "朋友圈内容不能为空。");
      if (imageUrl && !/^https:\/\//i.test(imageUrl)) throw new SocialHttpError(400, "图片地址必须使用 HTTPS。");
      const result = await supabaseRestFetch<PostRow[]>("social_posts?select=id,author_id,body,image_url,created_at,updated_at", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ id: createSocialId(), author_id: account.id, body, image_url: imageUrl || null }),
      });
      if (!result.ok) throw new Error(result.error);
      return Response.json({ ok: true, post: result.data[0] ?? null });
    }
    const postId = cleanSocialText(payload.postId, 80);
    if (!postId) throw new SocialHttpError(400, "缺少朋友圈 ID。");
    await requireVisiblePost(postId, account.id);
    if (action === "like") {
      const result = await supabaseRestFetch("social_post_likes?on_conflict=post_id,user_id", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify({ post_id: postId, user_id: account.id }),
      });
      if (!result.ok) throw new Error(result.error);
      return Response.json({ ok: true });
    }
    if (action === "unlike") {
      const result = await supabaseRestFetch(
        `social_post_likes?post_id=eq.${encodeSupabaseFilter(postId)}&user_id=eq.${encodeSupabaseFilter(account.id)}`,
        { method: "DELETE" },
      );
      if (!result.ok) throw new Error(result.error);
      return Response.json({ ok: true });
    }
    if (action === "comment") {
      const comment = cleanSocialText(payload.body, 1000);
      if (!comment) throw new SocialHttpError(400, "评论不能为空。");
      const result = await supabaseRestFetch<CommentRow[]>("social_post_comments?select=id,post_id,author_id,body,created_at", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ id: createSocialId(), post_id: postId, author_id: account.id, body: comment }),
      });
      if (!result.ok) throw new Error(result.error);
      return Response.json({ ok: true, comment: result.data[0] ?? null });
    }
    if (action === "delete") {
      const result = await supabaseRestFetch<PostRow[]>(
        `social_posts?id=eq.${encodeSupabaseFilter(postId)}&author_id=eq.${encodeSupabaseFilter(account.id)}&deleted_at=is.null&select=id`,
        { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ deleted_at: new Date().toISOString() }) },
      );
      if (!result.ok) throw new Error(result.error);
      if (result.data.length === 0) throw new SocialHttpError(404, "朋友圈不存在或无权删除。");
      return Response.json({ ok: true });
    }
    throw new SocialHttpError(400, "不支持的朋友圈操作。");
  } catch (err) {
    return socialErrorResponse(err);
  }
}

async function requireVisiblePost(postId: string, userId: string): Promise<void> {
  const post = await supabaseRestFetch<Array<{ author_id?: unknown }>>(
    `social_posts?id=eq.${encodeSupabaseFilter(postId)}&deleted_at=is.null&select=author_id&limit=1`,
  );
  if (!post.ok) throw new Error(post.error);
  const authorId = cleanSocialText(post.data[0]?.author_id, 120);
  if (!authorId) throw new SocialHttpError(404, "朋友圈不存在。");
  if (authorId === userId) return;
  const [a, b] = userId.localeCompare(authorId) <= 0 ? [userId, authorId] : [authorId, userId];
  const friendship = await supabaseRestFetch<Array<{ id?: unknown }>>(
    `social_friendships?user_a=eq.${encodeSupabaseFilter(a)}&user_b=eq.${encodeSupabaseFilter(b)}&select=id&limit=1`,
  );
  if (!friendship.ok) throw new Error(friendship.error);
  if (friendship.data.length === 0) throw new SocialHttpError(403, "只能查看好友的朋友圈。");
}
