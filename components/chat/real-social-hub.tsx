"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, Bot, Check, Heart, Headphones, Loader2, MessageCircle, Music2,
  Plus, Search, Send, Sparkles, UserPlus, Users, X,
} from "lucide-react";

import { fetchCurrentAccount } from "@/lib/account-client";
import { useMusicPlayerOptional } from "@/lib/music-context";
import type { MusicTrack } from "@/lib/music-storage";
import { generateSharedWorldReply, loadSharedWorldCharacters } from "@/lib/shared-world-ai";
import {
  notifySocialTopic,
  SocialRealtimeChannel,
  socialApi,
  type SocialFriend,
  type SocialFriendRequest,
  type SocialMessage,
  type SocialPost,
  type SocialProfile,
} from "@/lib/social-client";

type HubMode = "chats" | "friends" | "posts" | "listen";

export function RealSocialHub({ onCloseApp }: { onCloseApp: () => void }) {
  const [mode, setMode] = useState<HubMode>("chats");
  const [accountId, setAccountId] = useState("");
  const [accountProfile, setAccountProfile] = useState<SocialProfile | null>(null);
  const [friends, setFriends] = useState<SocialFriend[]>([]);
  const [requests, setRequests] = useState<SocialFriendRequest[]>([]);
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [selectedFriend, setSelectedFriend] = useState<SocialFriend | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const userChannel = useRef<SocialRealtimeChannel | null>(null);
  const feedChannel = useRef<SocialRealtimeChannel | null>(null);

  const loadFriends = useCallback(async () => {
    const data = await socialApi.friends();
    setFriends(data.friends);
    setRequests(data.requests);
  }, []);

  const loadPosts = useCallback(async () => setPosts(await socialApi.posts()), []);

  const refresh = useCallback(async () => {
    setError("");
    try { await Promise.all([loadFriends(), loadPosts()]); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(false); }
  }, [loadFriends, loadPosts]);

  useEffect(() => {
    let cancelled = false;
    void fetchCurrentAccount().then(async result => {
      if (cancelled) return;
      if (!result.ok || !result.account) {
        setError("请先在账号页面登录，真人互通不会使用本地 AI 角色身份。");
        setLoading(false);
        return;
      }
      setAccountId(result.account.id);
      setAccountProfile({ id: result.account.id, username: result.account.username, displayName: result.account.displayName });
      await refresh();
      if (cancelled) return;
      userChannel.current = await SocialRealtimeChannel.connect(result.account.id, {
        refresh: () => void loadFriends(),
      });
      feedChannel.current = await SocialRealtimeChannel.connect("feed", {
        refresh: () => void loadPosts(),
      });
    });
    return () => {
      cancelled = true;
      userChannel.current?.close();
      feedChannel.current?.close();
      userChannel.current = null;
      feedChannel.current = null;
    };
  }, [loadFriends, loadPosts, refresh]);

  const toast = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(""), 2200);
  };

  const friendAction = async (action: string, request: SocialFriendRequest) => {
    setError("");
    try {
      await socialApi.friendAction(action, { requestId: request.id });
      await loadFriends();
      void notifySocialTopic(request.profile.id, "refresh");
      toast(action === "accept" ? "已成为真人好友" : "已处理好友申请");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  if (selectedFriend) {
    return (
      <RealChatRoom
        accountId={accountId}
        accountProfile={accountProfile ?? { id: accountId, username: "me", displayName: "我" }}
        friend={selectedFriend}
        onBack={() => { setSelectedFriend(null); void loadFriends(); }}
      />
    );
  }

  return (
    <div className="absolute inset-0 flex flex-col bg-[var(--c-bg)] text-[var(--c-text)]">
      <header className="shrink-0 border-b border-black/5 bg-[var(--c-bg)]/95 px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))] backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <button className="rounded-full p-2 hover:bg-black/5" onClick={onCloseApp} aria-label="关闭">
            <ArrowLeft size={21} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-[17px] font-semibold">共享世界</div>
            <div className="text-[11px] opacity-55">真人好友和双方 AI 角色可以同场互动</div>
          </div>
          <button className="rounded-full p-2 hover:bg-black/5" onClick={() => void refresh()} aria-label="刷新">
            <Loader2 size={18} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </header>

      {error && <div className="mx-4 mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-[12px] text-red-600">{error}</div>}
      {notice && <div className="absolute left-1/2 top-24 z-50 -translate-x-1/2 rounded-full bg-black/75 px-4 py-2 text-[12px] text-white">{notice}</div>}

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {mode === "chats" && (
          <FriendList
            friends={friends}
            empty="还没有真人好友，先去“好友”里搜索对方账号"
            onSelect={setSelectedFriend}
            trailing="聊天"
          />
        )}
        {mode === "friends" && (
          <FriendsPanel
            friends={friends}
            requests={requests}
            onSelect={setSelectedFriend}
            onAction={friendAction}
            onChanged={async targetId => { await loadFriends(); void notifySocialTopic(targetId, "refresh"); }}
            onError={setError}
            toast={toast}
          />
        )}
        {mode === "posts" && (
          <RealPosts
            posts={posts}
            reload={loadPosts}
            broadcast={() => feedChannel.current?.send("refresh")}
            onError={setError}
            toast={toast}
          />
        )}
        {mode === "listen" && (
          <ListeningPanel accountId={accountId} friends={friends} onError={setError} toast={toast} />
        )}
      </main>

      <nav className="grid shrink-0 grid-cols-4 border-t border-black/5 bg-[var(--c-bg)]/95 pb-[max(8px,env(safe-area-inset-bottom))] pt-2 backdrop-blur-xl">
        <HubTab active={mode === "chats"} icon={<MessageCircle size={19} />} label="聊天" onClick={() => setMode("chats")} />
        <HubTab active={mode === "friends"} icon={<Users size={19} />} label="好友" badge={requests.filter(item => item.incoming).length} onClick={() => setMode("friends")} />
        <HubTab active={mode === "posts"} icon={<Heart size={19} />} label="真人圈" onClick={() => setMode("posts")} />
        <HubTab active={mode === "listen"} icon={<Headphones size={19} />} label="一起听" onClick={() => setMode("listen")} />
      </nav>
    </div>
  );
}

function HubTab({ active, icon, label, badge = 0, onClick }: { active: boolean; icon: React.ReactNode; label: string; badge?: number; onClick: () => void }) {
  return (
    <button className={`relative flex flex-col items-center gap-1 py-1 text-[10px] ${active ? "text-[var(--c-accent)]" : "opacity-55"}`} onClick={onClick}>
      {icon}<span>{label}</span>
      {badge > 0 && <span className="absolute right-[24%] top-0 min-w-4 rounded-full bg-red-500 px-1 text-[9px] leading-4 text-white">{badge}</span>}
    </button>
  );
}

function Avatar({ profile, size = 44 }: { profile: SocialProfile; size?: number }) {
  const label = (profile.displayName || profile.username || "?").slice(0, 1).toUpperCase();
  return <div className="grid shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-violet-400 to-sky-400 font-semibold text-white shadow-sm" style={{ width: size, height: size }}>{label}</div>;
}

function FriendList({ friends, empty, onSelect, trailing }: { friends: SocialFriend[]; empty: string; onSelect: (friend: SocialFriend) => void; trailing: string }) {
  if (friends.length === 0) return <EmptyState icon={<Users size={30} />} text={empty} />;
  return <div className="space-y-2">{friends.map(friend => (
    <button key={friend.friendshipId} className="flex w-full items-center gap-3 rounded-2xl bg-[var(--c-card)] p-3 text-left shadow-sm" onClick={() => onSelect(friend)}>
      <Avatar profile={friend.profile} />
      <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-semibold">{friend.profile.displayName}</div><div className="truncate text-[11px] opacity-50">@{friend.profile.username}</div></div>
      <span className="text-[11px] text-[var(--c-accent)]">{trailing}</span>
    </button>
  ))}</div>;
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-center opacity-45">{icon}<p className="max-w-60 text-[12px] leading-5">{text}</p></div>;
}

function FriendsPanel({ friends, requests, onSelect, onAction, onChanged, onError, toast }: {
  friends: SocialFriend[];
  requests: SocialFriendRequest[];
  onSelect: (friend: SocialFriend) => void;
  onAction: (action: string, request: SocialFriendRequest) => void;
  onChanged: (targetId: string) => Promise<void>;
  onError: (message: string) => void;
  toast: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SocialProfile[]>([]);
  const [searching, setSearching] = useState(false);

  const search = async () => {
    if (query.trim().length < 2) return;
    setSearching(true); onError("");
    try { setResults(await socialApi.searchUsers(query.trim())); }
    catch (err) { onError(err instanceof Error ? err.message : String(err)); }
    finally { setSearching(false); }
  };

  const add = async (profile: SocialProfile) => {
    try {
      await socialApi.friendAction("send", { targetUserId: profile.id, message: "想和你成为真人好友" });
      await onChanged(profile.id);
      toast("好友申请已发送");
    } catch (err) { onError(err instanceof Error ? err.message : String(err)); }
  };

  const incoming = requests.filter(item => item.incoming);
  const outgoing = requests.filter(item => !item.incoming);
  const friendIds = new Set(friends.map(item => item.profile.id));

  return <div className="space-y-5">
    <section>
      <div className="mb-2 text-[13px] font-semibold">搜索真人账号</div>
      <div className="flex gap-2"><div className="flex flex-1 items-center gap-2 rounded-2xl bg-[var(--c-card)] px-3"><Search size={16} className="opacity-45" /><input className="min-w-0 flex-1 bg-transparent py-3 text-[13px] outline-none" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && void search()} placeholder="输入账号或昵称" /></div><button className="rounded-2xl bg-[var(--c-accent)] px-4 text-[12px] text-white" onClick={() => void search()}>{searching ? <Loader2 size={16} className="animate-spin" /> : "搜索"}</button></div>
      {results.length > 0 && <div className="mt-2 space-y-2">{results.map(profile => <div key={profile.id} className="flex items-center gap-3 rounded-2xl bg-[var(--c-card)] p-3"><Avatar profile={profile} size={40} /><div className="min-w-0 flex-1"><div className="truncate text-[13px] font-semibold">{profile.displayName}</div><div className="truncate text-[10px] opacity-50">@{profile.username}</div></div>{friendIds.has(profile.id) ? <span className="text-[11px] opacity-45">已是好友</span> : <button className="rounded-full bg-[var(--c-accent)]/10 p-2 text-[var(--c-accent)]" onClick={() => void add(profile)}><UserPlus size={17} /></button>}</div>)}</div>}
    </section>
    {incoming.length > 0 && <section><div className="mb-2 text-[13px] font-semibold">收到的申请</div><div className="space-y-2">{incoming.map(request => <div key={request.id} className="rounded-2xl bg-[var(--c-card)] p-3"><div className="flex items-center gap-3"><Avatar profile={request.profile} size={40} /><div className="min-w-0 flex-1"><div className="truncate text-[13px] font-semibold">{request.profile.displayName}</div><div className="text-[11px] opacity-55">{request.message || "请求添加你为好友"}</div></div><button className="rounded-full bg-emerald-500/15 p-2 text-emerald-600" onClick={() => onAction("accept", request)}><Check size={17} /></button><button className="rounded-full bg-red-500/10 p-2 text-red-500" onClick={() => onAction("reject", request)}><X size={17} /></button></div></div>)}</div></section>}
    {outgoing.length > 0 && <section><div className="mb-2 text-[13px] font-semibold">已发送</div><div className="space-y-2">{outgoing.map(request => <div key={request.id} className="flex items-center gap-3 rounded-2xl bg-[var(--c-card)] p-3"><Avatar profile={request.profile} size={38} /><div className="min-w-0 flex-1 text-[12px]"><div className="font-semibold">{request.profile.displayName}</div><div className="opacity-50">等待对方通过</div></div><button className="text-[11px] opacity-55" onClick={() => onAction("cancel", request)}>取消</button></div>)}</div></section>}
    <section><div className="mb-2 text-[13px] font-semibold">我的真人好友</div><FriendList friends={friends} empty="还没有真人好友" onSelect={onSelect} trailing="打开" /></section>
  </div>;
}

function RealChatRoom({ accountId, accountProfile, friend, onBack }: { accountId: string; accountProfile: SocialProfile; friend: SocialFriend; onBack: () => void }) {
  const [messages, setMessages] = useState<SocialMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [characters] = useState(() => loadSharedWorldCharacters());
  const storagePrefix = `ai_phone_shared_world_${friend.friendshipId}`;
  const [selectedCharacterId, setSelectedCharacterId] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(`${storagePrefix}_character`) ?? "";
  });
  const [autoJoin, setAutoJoin] = useState(() => typeof window !== "undefined" && window.localStorage.getItem(`${storagePrefix}_auto`) === "true");
  const [includeMemory, setIncludeMemory] = useState(() => typeof window !== "undefined" && window.localStorage.getItem(`${storagePrefix}_memory`) === "true");
  const [aiGenerating, setAiGenerating] = useState(false);
  const channelRef = useRef<SocialRealtimeChannel | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const seenHumanMessages = useRef<Set<string>>(new Set());
  const initializedMessages = useRef(false);
  const selectedCharacter = characters.find(character => character.id === selectedCharacterId) ?? null;

  const reload = useCallback(async () => {
    try { setMessages(await socialApi.messages(friend.friendshipId)); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, [friend.friendshipId]);

  useEffect(() => {
    let interval = 0;
    void reload();
    void SocialRealtimeChannel.connect(friend.friendshipId, { refresh: () => void reload() }).then(channel => {
      channelRef.current = channel;
      if (!channel) interval = window.setInterval(() => void reload(), 5000);
    });
    return () => { channelRef.current?.close(); if (interval) window.clearInterval(interval); };
  }, [friend.friendshipId, reload]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length]);

  useEffect(() => {
    if (!selectedCharacterId && characters[0]) setSelectedCharacterId(characters[0].id);
  }, [characters, selectedCharacterId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (selectedCharacterId) window.localStorage.setItem(`${storagePrefix}_character`, selectedCharacterId);
  }, [selectedCharacterId, storagePrefix]);

  const inviteAi = useCallback(async (sourceMessages: SocialMessage[] = messages) => {
    if (!selectedCharacter || aiGenerating) return;
    setAiGenerating(true); setError("");
    try {
      const reply = await generateSharedWorldReply({
        character: selectedCharacter,
        messages: sourceMessages,
        self: accountProfile,
        friend,
        includeMemory,
      });
      await socialApi.sendAiMessage(friend.friendshipId, { localId: selectedCharacter.id, name: selectedCharacter.name }, reply);
      await reload();
      await channelRef.current?.send("refresh");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiGenerating(false);
    }
  }, [accountProfile, aiGenerating, friend, includeMemory, messages, reload, selectedCharacter]);

  useEffect(() => {
    const humanMessages = messages.filter(message => !message.actor);
    if (!initializedMessages.current) {
      humanMessages.forEach(message => seenHumanMessages.current.add(message.id));
      initializedMessages.current = true;
      return;
    }
    const arrived = humanMessages.filter(message => !seenHumanMessages.current.has(message.id));
    humanMessages.forEach(message => seenHumanMessages.current.add(message.id));
    if (arrived.length > 0 && autoJoin && selectedCharacter && !aiGenerating) void inviteAi(messages);
  }, [aiGenerating, autoJoin, inviteAi, messages, selectedCharacter]);

  const toggleAutoJoin = () => {
    const next = !autoJoin;
    setAutoJoin(next);
    window.localStorage.setItem(`${storagePrefix}_auto`, String(next));
  };

  const toggleMemory = () => {
    const next = !includeMemory;
    setIncludeMemory(next);
    window.localStorage.setItem(`${storagePrefix}_memory`, String(next));
  };

  const send = async () => {
    const text = draft.trim(); if (!text || sending) return;
    setSending(true); setDraft(""); setError("");
    try { await socialApi.sendMessage(friend.friendshipId, text); await reload(); await channelRef.current?.send("refresh"); }
    catch (err) { setDraft(text); setError(err instanceof Error ? err.message : String(err)); }
    finally { setSending(false); }
  };

  return <div className="absolute inset-0 flex flex-col bg-[var(--c-bg)] text-[var(--c-text)]">
    <header className="flex shrink-0 items-center gap-3 border-b border-black/5 px-3 pb-3 pt-[max(12px,env(safe-area-inset-top))]"><button className="p-2" onClick={onBack}><ArrowLeft size={21} /></button><Avatar profile={friend.profile} size={36} /><div className="min-w-0 flex-1"><div className="truncate text-[14px] font-semibold">和 {friend.profile.displayName} 的共享世界</div><div className="text-[10px] opacity-45">两位真人 · 双方 AI 都能加入</div></div></header>
    {error && <div className="mx-4 mt-2 rounded-xl bg-red-500/10 px-3 py-2 text-[11px] text-red-600">{error}</div>}
    <div className="shrink-0 border-b border-black/5 bg-[var(--c-card)]/55 px-3 py-2">
      {characters.length > 0 ? <><div className="flex items-center gap-2"><Bot size={16} className="shrink-0 opacity-55" /><select className="min-w-0 flex-1 rounded-xl bg-[var(--c-card)] px-2 py-2 text-[11px] outline-none" value={selectedCharacterId} onChange={event => setSelectedCharacterId(event.target.value)} aria-label="选择加入共享世界的AI角色">{characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}</select><button className="flex shrink-0 items-center gap-1 rounded-xl bg-[var(--c-accent)] px-3 py-2 text-[11px] text-white disabled:opacity-40" disabled={!selectedCharacter || aiGenerating} onClick={() => void inviteAi()}>{aiGenerating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}请他接话</button></div><div className="mt-2 flex flex-wrap gap-2 text-[10px]"><button className={`rounded-full px-3 py-1.5 ${autoJoin ? "bg-[var(--c-accent)] text-white" : "bg-black/5 opacity-65"}`} onClick={toggleAutoJoin}>自动参与 {autoJoin ? "开" : "关"}</button><button className={`rounded-full px-3 py-1.5 ${includeMemory ? "bg-amber-500 text-white" : "bg-black/5 opacity-65"}`} onClick={toggleMemory}>结合本地记忆 {includeMemory ? "开" : "关"}</button></div></> : <div className="text-[11px] opacity-55">本机还没有 AI 角色，创建角色后就能邀请他加入共享世界。</div>}
    </div>
    <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4"><div className="space-y-3">{messages.length === 0 && <div className="py-12 text-center text-[11px] opacity-40">先由真人说句话，或邀请一个 AI 角色开启共同剧情。</div>}{messages.map(message => { const mine = message.senderId === accountId; const isAi = message.actor?.type === "ai"; const ownerName = mine ? accountProfile.displayName : friend.profile.displayName; return <div key={message.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}><div className={`max-w-[82%] rounded-2xl px-3 py-2 text-[13px] leading-5 ${isAi ? (mine ? "rounded-br-md bg-violet-500 text-white" : "rounded-bl-md bg-sky-500/15") : mine ? "rounded-br-md bg-[var(--c-accent)] text-white" : "rounded-bl-md bg-[var(--c-card)]"}`}>{isAi && <div className={`mb-1 flex items-center gap-1 text-[9px] font-semibold ${mine ? "text-white/75" : "text-sky-700/70"}`}><Bot size={11} />{message.actor?.name} · {ownerName}的AI</div>}<div className="whitespace-pre-wrap break-words">{message.body}</div><div className={`mt-1 text-right text-[9px] ${mine && !isAi ? "text-white/65" : mine && isAi ? "text-white/65" : "opacity-40"}`}>{formatTime(message.createdAt)}</div></div></div>; })}<div ref={endRef} /></div></main>
    <footer className="flex shrink-0 items-end gap-2 border-t border-black/5 bg-[var(--c-bg)] px-3 pb-[max(10px,env(safe-area-inset-bottom))] pt-2"><textarea className="max-h-28 min-h-10 flex-1 resize-none rounded-2xl bg-[var(--c-card)] px-3 py-2 text-[13px] outline-none" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} placeholder="以真人身份说话…" /><button className="grid h-10 w-10 place-items-center rounded-full bg-[var(--c-accent)] text-white disabled:opacity-40" disabled={!draft.trim() || sending} onClick={() => void send()}>{sending ? <Loader2 size={17} className="animate-spin" /> : <Send size={17} />}</button></footer>
  </div>;
}

function RealPosts({ posts, reload, broadcast, onError, toast }: { posts: SocialPost[]; reload: () => Promise<void>; broadcast: () => Promise<void> | undefined; onError: (message: string) => void; toast: (message: string) => void }) {
  const [draft, setDraft] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [composing, setComposing] = useState(false);
  const [comments, setComments] = useState<Record<string, string>>({});
  const act = async (action: string, input: Record<string, unknown>, success?: string) => {
    onError("");
    try { await socialApi.postAction(action, input); await reload(); await broadcast(); if (success) toast(success); }
    catch (err) { onError(err instanceof Error ? err.message : String(err)); }
  };
  const publish = async () => {
    if (!draft.trim() && !imageUrl.trim()) return;
    await act("create", { body: draft, imageUrl }, "真人朋友圈已发布"); setDraft(""); setImageUrl(""); setComposing(false);
  };
  return <div className="space-y-4">
    <button className="flex w-full items-center gap-2 rounded-2xl bg-[var(--c-card)] p-3 text-left text-[12px] opacity-70" onClick={() => setComposing(true)}><Plus size={17} />发布一条只给真人好友看的朋友圈</button>
    {composing && <div className="rounded-2xl bg-[var(--c-card)] p-3 shadow-sm"><textarea className="min-h-24 w-full resize-none bg-transparent text-[13px] outline-none" value={draft} onChange={e => setDraft(e.target.value)} placeholder="这一刻的想法…" /><input className="mt-2 w-full rounded-xl bg-black/5 px-3 py-2 text-[11px] outline-none" value={imageUrl} onChange={e => setImageUrl(e.target.value)} placeholder="可选：HTTPS 图片链接" /><div className="mt-3 flex justify-end gap-2"><button className="rounded-full px-3 py-2 text-[11px] opacity-55" onClick={() => setComposing(false)}>取消</button><button className="rounded-full bg-[var(--c-accent)] px-4 py-2 text-[11px] text-white" onClick={() => void publish()}>发布</button></div></div>}
    {posts.length === 0 ? <EmptyState icon={<Heart size={30} />} text="还没有真人朋友圈。这里不会混入 AI 自动生成的动态。" /> : posts.map(post => <article key={post.id} className="rounded-2xl bg-[var(--c-card)] p-4 shadow-sm"><div className="flex items-center gap-3"><Avatar profile={post.author} size={40} /><div className="min-w-0 flex-1"><div className="truncate text-[13px] font-semibold">{post.author.displayName}</div><div className="text-[10px] opacity-40">真人 · {formatTime(post.createdAt)}</div></div>{post.mine && <button className="text-[10px] text-red-500/70" onClick={() => void act("delete", { postId: post.id })}>删除</button>}</div><p className="mt-3 whitespace-pre-wrap break-words text-[13px] leading-5">{post.body}</p>{post.imageUrl && <img src={post.imageUrl} alt="朋友圈图片" className="mt-3 max-h-72 w-full rounded-xl object-cover" />}
      <div className="mt-3 flex items-center gap-4 text-[11px]"><button className={post.likedByMe ? "text-rose-500" : "opacity-55"} onClick={() => void act(post.likedByMe ? "unlike" : "like", { postId: post.id })}><Heart size={15} className="mr-1 inline" fill={post.likedByMe ? "currentColor" : "none"} />{post.likes.length || "赞"}</button><span className="opacity-55"><MessageCircle size={15} className="mr-1 inline" />{post.comments.length || "评论"}</span></div>
      {(post.likes.length > 0 || post.comments.length > 0) && <div className="mt-3 rounded-xl bg-black/[0.035] p-2 text-[11px] leading-5">{post.likes.length > 0 && <div className="text-[var(--c-accent)]">{post.likes.map(item => item.profile?.displayName ?? "好友").join("、")}</div>}{post.comments.map(comment => <div key={comment.id}><span className="font-semibold">{comment.profile?.displayName ?? "好友"}：</span>{comment.body}</div>)}</div>}
      <div className="mt-3 flex gap-2"><input className="min-w-0 flex-1 rounded-full bg-black/5 px-3 py-2 text-[11px] outline-none" value={comments[post.id] ?? ""} onChange={e => setComments(prev => ({ ...prev, [post.id]: e.target.value }))} placeholder="评论真人好友…" /><button className="rounded-full bg-[var(--c-accent)]/10 px-3 text-[11px] text-[var(--c-accent)]" onClick={() => { const body = (comments[post.id] ?? "").trim(); if (!body) return; setComments(prev => ({ ...prev, [post.id]: "" })); void act("comment", { postId: post.id, body }); }}>发送</button></div>
    </article>)}
  </div>;
}

function ListeningPanel({ accountId, friends, onError, toast }: { accountId: string; friends: SocialFriend[]; onError: (message: string) => void; toast: (message: string) => void }) {
  const player = useMusicPlayerOptional();
  const [friend, setFriend] = useState<SocialFriend | null>(null);
  const [active, setActive] = useState(false);
  const [following, setFollowing] = useState(true);
  const [remoteState, setRemoteState] = useState<Record<string, unknown> | null>(null);
  const channelRef = useRef<SocialRealtimeChannel | null>(null);
  const playerRef = useRef(player);
  playerRef.current = player;

  const applyRemote = useCallback((state: Record<string, unknown>) => {
    setRemoteState(state);
    if (!following || !playerRef.current) return;
    const trackId = String(state.trackId ?? "");
    if (!trackId) return;
    const p = playerRef.current;
    if (p.currentTrack?.id !== trackId) {
      const track: MusicTrack = { id: trackId, title: String(state.title ?? "一起听"), artist: String(state.artist ?? ""), coverUrl: String(state.coverUrl ?? ""), duration: 0, liked: false, addedAt: new Date().toISOString() };
      p.playTrack(track);
      window.setTimeout(() => {
        const elapsed = state.isPlaying ? Math.max(0, (Date.now() - Number(state.sentAt || Date.now())) / 1000) : 0;
        p.seek(Number(state.position || 0) + elapsed);
        if (state.isPlaying) p.resume(); else p.pause();
      }, 1000);
    } else {
      const elapsed = state.isPlaying ? Math.max(0, (Date.now() - Number(state.sentAt || Date.now())) / 1000) : 0;
      const target = Number(state.position || 0) + elapsed;
      if (Math.abs(p.currentTime - target) > 3) p.seek(target);
      if (state.isPlaying && !p.isPlaying) p.resume();
      if (!state.isPlaying && p.isPlaying) p.pause();
    }
  }, [following]);

  useEffect(() => {
    channelRef.current?.close(); channelRef.current = null; setActive(false); setRemoteState(null);
    if (!friend) return;
    let cancelled = false;
    void socialApi.listening(friend.friendshipId).then(data => { const state = data.session?.state; if (!cancelled && state) applyRemote(state); }).catch(() => undefined);
    void SocialRealtimeChannel.connect(friend.friendshipId, { listening: payload => { if (String(payload.leaderId ?? "") !== accountId) applyRemote(payload); } }).then(channel => { if (!cancelled) channelRef.current = channel; else channel?.close(); });
    return () => { cancelled = true; channelRef.current?.close(); channelRef.current = null; };
  }, [accountId, applyRemote, friend]);

  const makeState = useCallback((): Record<string, unknown> | null => {
    if (!player?.currentTrack) return null;
    return { leaderId: accountId, trackId: player.currentTrack.id, title: player.currentTrack.title, artist: player.currentTrack.artist, coverUrl: player.currentTrack.coverUrl ?? "", isPlaying: player.isPlaying, position: player.currentTime, sentAt: Date.now() };
  }, [accountId, player?.currentTime, player?.currentTrack, player?.isPlaying]);

  useEffect(() => {
    if (!active || following || !friend) return;
    const push = () => { const state = makeState(); if (state) void channelRef.current?.send("listening", state); };
    push(); const timer = window.setInterval(push, 1800); return () => window.clearInterval(timer);
  }, [active, following, friend, makeState]);

  const lead = async () => {
    if (!friend) return;
    const state = makeState();
    if (!state) { onError("请先在音乐 APP 里播放一首歌，再开始一起听。"); return; }
    setFollowing(false); setActive(true); onError("");
    try { await socialApi.saveListening(friend.friendshipId, state); await channelRef.current?.send("listening", state); toast("已把当前音乐同步给好友"); }
    catch (err) { onError(err instanceof Error ? err.message : String(err)); }
  };

  if (!friend) return <div><div className="mb-3 text-[13px] font-semibold">选择一起听的真人好友</div><FriendList friends={friends} empty="添加真人好友后，就能一起听网易云歌曲" onSelect={setFriend} trailing="选择" /></div>;
  const remoteTitle = String(remoteState?.title ?? "");
  return <div className="space-y-4"><button className="flex items-center gap-2 text-[12px] opacity-60" onClick={() => setFriend(null)}><ArrowLeft size={16} />更换好友</button><div className="rounded-3xl bg-gradient-to-br from-violet-500/15 to-sky-500/15 p-5 text-center"><div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[var(--c-card)] shadow-sm"><Music2 size={28} /></div><div className="mt-3 text-[15px] font-semibold">和 {friend.profile.displayName} 一起听</div><div className="mt-1 text-[11px] opacity-55">只同步歌曲 ID、播放/暂停和进度，不上传音频</div>{remoteTitle && <div className="mt-4 rounded-2xl bg-[var(--c-card)] p-3 text-left"><div className="text-[10px] opacity-45">好友正在同步</div><div className="mt-1 truncate text-[13px] font-semibold">{remoteTitle}</div><div className="truncate text-[11px] opacity-55">{String(remoteState?.artist ?? "")}</div></div>}</div><button className="w-full rounded-2xl bg-[var(--c-accent)] py-3 text-[13px] font-semibold text-white" onClick={() => void lead()}>把我当前播放的歌同步给 TA</button><button className={`w-full rounded-2xl border py-3 text-[13px] ${following && active ? "border-[var(--c-accent)] text-[var(--c-accent)]" : "border-black/10"}`} onClick={() => { setFollowing(true); setActive(true); if (remoteState) applyRemote(remoteState); toast("正在跟随好友的播放状态"); }}>跟随 TA 的音乐</button><p className="text-[10px] leading-4 opacity-45">手机浏览器第一次播放可能需要你点一下按钮，这是系统的自动播放限制。</p></div>;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
