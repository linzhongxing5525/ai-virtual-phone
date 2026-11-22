"use client";

import { RealtimeChannel, RealtimeClient } from "@supabase/realtime-js";

export type SocialProfile = { id: string; username: string; displayName: string };
export type SocialFriend = { friendshipId: string; createdAt: string; profile: SocialProfile };
export type SocialFriendRequest = { id: string; incoming: boolean; message: string; createdAt: string; profile: SocialProfile };
export type SocialMessage = { id: string; friendshipId: string; senderId: string; body: string; type: string; createdAt: string; readAt: string | null };
export type SocialPost = {
  id: string;
  authorId: string;
  author: SocialProfile;
  body: string;
  imageUrl: string | null;
  createdAt: string;
  mine: boolean;
  likedByMe: boolean;
  likes: Array<{ userId: string; profile: SocialProfile | null; createdAt: string }>;
  comments: Array<{ id: string; userId: string; profile: SocialProfile | null; body: string; createdAt: string }>;
};

type JsonRecord = Record<string, unknown>;

async function socialFetch<T extends JsonRecord>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({})) as JsonRecord;
  if (!response.ok || data.ok !== true) throw new Error(String(data.error ?? `请求失败（HTTP ${response.status}）`));
  return data as T;
}

export const socialApi = {
  searchUsers: async (query: string) => (await socialFetch<{ ok: true; users: SocialProfile[] }>(`/api/social/users?q=${encodeURIComponent(query)}`)).users,
  friends: async () => socialFetch<{ ok: true; friends: SocialFriend[]; requests: SocialFriendRequest[] }>("/api/social/friends"),
  friendAction: async (action: string, input: JsonRecord = {}) => socialFetch<{ ok: true }>("/api/social/friends", {
    method: "POST", body: JSON.stringify({ action, ...input }),
  }),
  messages: async (friendshipId: string) => (await socialFetch<{ ok: true; messages: SocialMessage[] }>(`/api/social/messages?friendshipId=${encodeURIComponent(friendshipId)}`)).messages,
  sendMessage: async (friendshipId: string, body: string) => socialFetch<{ ok: true; message: SocialMessage }>("/api/social/messages", {
    method: "POST", body: JSON.stringify({ friendshipId, body }),
  }),
  posts: async () => (await socialFetch<{ ok: true; posts: SocialPost[] }>("/api/social/posts")).posts,
  postAction: async (action: string, input: JsonRecord = {}) => socialFetch<{ ok: true }>("/api/social/posts", {
    method: "POST", body: JSON.stringify({ action, ...input }),
  }),
  listening: async (friendshipId: string) => socialFetch<{ ok: true; session: { state?: JsonRecord; updated_by?: string } | null }>(`/api/social/listening?friendshipId=${encodeURIComponent(friendshipId)}`),
  saveListening: async (friendshipId: string, state: JsonRecord) => socialFetch<{ ok: true }>("/api/social/listening", {
    method: "POST", body: JSON.stringify({ friendshipId, state }),
  }),
};

type OnlineConfig = { supabaseUrl: string; anonKey: string };
let configPromise: Promise<OnlineConfig | null> | null = null;

async function onlineConfig(): Promise<OnlineConfig | null> {
  if (!configPromise) {
    configPromise = fetch("/api/online/config", { cache: "no-store" })
      .then(response => response.json())
      .then(data => data?.configured && data.supabaseUrl && data.anonKey
        ? { supabaseUrl: String(data.supabaseUrl), anonKey: String(data.anonKey) }
        : null)
      .catch(() => null);
  }
  return configPromise;
}

/**
 * Realtime 只传“刷新提示”或公开的播放状态；聊天正文仍必须通过登录 API 读取。
 * 因此即使 anon key 在浏览器端公开，也无法绕过好友关系读取私人数据。
 */
export class SocialRealtimeChannel {
  private constructor(private client: RealtimeClient, private channel: RealtimeChannel) {}

  static async connect(topic: string, handlers: Record<string, (payload: JsonRecord) => void>): Promise<SocialRealtimeChannel | null> {
    const config = await onlineConfig();
    if (!config) return null;
    const client = new RealtimeClient(`${config.supabaseUrl.replace(/^http/, "ws")}/realtime/v1`, {
      params: { apikey: config.anonKey }, heartbeatIntervalMs: 25_000,
    });
    const channel = client.channel(`social:${topic}`, { config: { broadcast: { self: false, ack: false } } });
    for (const [event, handler] of Object.entries(handlers)) {
      channel.on("broadcast", { event }, ({ payload }) => handler((payload ?? {}) as JsonRecord));
    }
    const connected = await new Promise<boolean>(resolve => {
      const timer = window.setTimeout(() => resolve(false), 10_000);
      channel.subscribe(status => {
        if (status === "SUBSCRIBED") { window.clearTimeout(timer); resolve(true); }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") { window.clearTimeout(timer); resolve(false); }
      });
    });
    if (!connected) {
      try { void channel.unsubscribe(); client.disconnect(); } catch { /* noop */ }
      return null;
    }
    return new SocialRealtimeChannel(client, channel);
  }

  async send(event: string, payload: JsonRecord = {}): Promise<void> {
    await this.channel.send({ type: "broadcast", event, payload });
  }

  close(): void {
    try { void this.channel.unsubscribe(); } catch { /* noop */ }
    try { this.client.disconnect(); } catch { /* noop */ }
  }
}

export async function notifySocialTopic(topic: string, event = "refresh", payload: JsonRecord = {}): Promise<void> {
  const channel = await SocialRealtimeChannel.connect(topic, {});
  if (!channel) return;
  try { await channel.send(event, payload); } finally { channel.close(); }
}
