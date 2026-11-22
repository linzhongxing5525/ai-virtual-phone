"use client";

import { useCallback, useEffect, useState } from "react";

import { fetchCurrentAccount } from "@/lib/account-client";
import {
  SocialRealtimeChannel,
  socialApi,
  type SocialFriend,
  type SocialFriendRequest,
  type SocialMessage,
  type SocialProfile,
} from "@/lib/social-client";

export type SocialConversationPreview = {
  message: SocialMessage | null;
  unread: number;
};

export function useUnifiedSocialDirectory() {
  const [account, setAccount] = useState<SocialProfile | null>(null);
  const [friends, setFriends] = useState<SocialFriend[]>([]);
  const [requests, setRequests] = useState<SocialFriendRequest[]>([]);
  const [previews, setPreviews] = useState<Record<string, SocialConversationPreview>>({});
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    const current = await fetchCurrentAccount();
    if (!current.ok || !current.account) {
      setAccount(null);
      setFriends([]);
      setRequests([]);
      setPreviews({});
      setReady(true);
      return;
    }
    const profile: SocialProfile = {
      id: current.account.id,
      username: current.account.username,
      displayName: current.account.displayName,
    };
    setAccount(profile);
    try {
      const directory = await socialApi.friends();
      setFriends(directory.friends);
      setRequests(directory.requests);
      const entries = await Promise.all(directory.friends.map(async friend => {
        try {
          const messages = await socialApi.messages(friend.friendshipId, { markRead: false });
          const last = messages.at(-1) ?? null;
          const unread = messages.filter(message => message.senderId !== profile.id && !message.readAt).length;
          return [friend.friendshipId, { message: last, unread }] as const;
        } catch {
          return [friend.friendshipId, { message: null, unread: 0 }] as const;
        }
      }));
      setPreviews(Object.fromEntries(entries));
    } catch {
      setFriends([]);
      setRequests([]);
      setPreviews({});
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let channel: SocialRealtimeChannel | null = null;
    void refresh().then(async () => {
      if (cancelled) return;
      const current = await fetchCurrentAccount();
      if (!current.ok || !current.account || cancelled) return;
      channel = await SocialRealtimeChannel.connect(current.account.id, { refresh: () => void refresh() });
    });
    const timer = window.setInterval(() => void refresh(), 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      channel?.close();
    };
  }, [refresh]);

  return { account, friends, requests, previews, ready, refresh };
}
