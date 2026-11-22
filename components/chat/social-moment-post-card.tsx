"use client";

import { useState } from "react";
import { Heart, MessageCircle, Send } from "lucide-react";

import { notifySocialTopic, socialApi, type SocialPost } from "@/lib/social-client";

export function SocialMomentActivity({ post, onChanged, compact = false }: {
  post: SocialPost;
  onChanged: () => Promise<void>;
  compact?: boolean;
}) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  const act = async (action: string, input: Record<string, unknown> = {}) => {
    if (busy) return;
    setBusy(true);
    try {
      await socialApi.postAction(action, { postId: post.id, ...input });
      await onChanged();
      void notifySocialTopic("feed", "refresh");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={compact ? "mx-4 -mt-4 mb-5 rounded-xl bg-violet-500/[0.045] p-3" : "mt-3"}>
      {compact && <div className="mb-2 ts-10 font-semibold text-violet-600/70">真人好友互动</div>}
      <div className="flex items-center gap-5 ts-12">
        <button className={post.likedByMe ? "text-rose-500" : "text-[var(--c-icon)]"} disabled={busy} onClick={() => void act(post.likedByMe ? "unlike" : "like")}>
          <Heart size={15} className="mr-1 inline" fill={post.likedByMe ? "currentColor" : "none"} />{post.likes.length || "赞"}
        </button>
        <span className="text-[var(--c-icon)]"><MessageCircle size={15} className="mr-1 inline" />{post.comments.length || "评论"}</span>
      </div>
      {(post.likes.length > 0 || post.comments.length > 0) && (
        <div className="mt-3 rounded-xl bg-black/[0.035] p-2 ts-12 leading-5 text-[var(--c-text)]">
          {post.likes.length > 0 && <div className="text-[var(--c-accent)]">{post.likes.map(item => item.profile?.displayName || "好友").join("、")}</div>}
          {post.comments.map(item => <div key={item.id}><span className="font-semibold">{item.profile?.displayName || "好友"}：</span>{item.body}</div>)}
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <input className="min-w-0 flex-1 rounded-full bg-black/5 px-3 py-2 ts-12 outline-none" value={comment} onChange={event => setComment(event.target.value)} placeholder="评论这条朋友圈…" />
        <button className="grid h-9 w-9 place-items-center rounded-full bg-[var(--c-accent)] text-white disabled:opacity-40" disabled={!comment.trim() || busy} onClick={() => { const body = comment.trim(); if (!body) return; setComment(""); void act("comment", { body }); }}>
          <Send size={15} />
        </button>
      </div>
    </div>
  );
}

export function SocialMomentPostCard({ post, onChanged }: { post: SocialPost; onChanged: () => Promise<void> }) {
  const remove = async () => {
    await socialApi.postAction("delete", { postId: post.id });
    await onChanged();
    void notifySocialTopic("feed", "refresh");
  };
  return (
    <article className="feed-post relative mb-5 w-full border-b-[2.5px] border-[var(--c-card-border)] bg-transparent px-4 pb-5 pt-2" data-moment-post-id={`social-${post.id}`}>
      <div className="flex items-center gap-3">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-gradient-to-br from-violet-400 to-sky-400 font-semibold text-white">
          {post.author.displayName.slice(0, 1)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate ts-16 font-semibold text-[var(--c-text-title)]">{post.author.displayName}</div>
          <div className="ts-11 text-[var(--c-icon)]">真人 · {new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(post.createdAt))}</div>
        </div>
        {post.mine && <button className="ts-11 text-red-500/70" onClick={() => void remove()}>删除</button>}
      </div>
      <p className="mt-3 whitespace-pre-wrap break-words ts-14 leading-6 text-[var(--c-text)]">{post.body}</p>
      {post.imageUrl && <img src={post.imageUrl} alt="朋友圈图片" className="mt-3 max-h-80 w-full rounded-xl object-cover" />}
      <SocialMomentActivity post={post} onChanged={onChanged} />
    </article>
  );
}
