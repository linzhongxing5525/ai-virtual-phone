"use client";

import { simpleLLMCall } from "./api-helpers";
import { loadCharacters } from "./character-storage";
import type { Character } from "./character-types";
import { loadMemoryEntries } from "./memory-storage";
import { loadApiConfigs, loadBindingConfig, resolveBinding, resolveUserIdentity } from "./settings-storage";
import type { SocialFriend, SocialMessage, SocialProfile } from "./social-client";

function compact(value: string, max: number): string {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function speakerLabel(message: SocialMessage, self: SocialProfile, friend: SocialFriend): string {
  if (message.actor?.type === "ai") {
    const side = message.actor.ownerId === self.id ? self.displayName : friend.profile.displayName;
    return `${message.actor.name}（${side}的AI角色）`;
  }
  return message.senderId === self.id ? self.displayName : friend.profile.displayName;
}

export async function generateSharedWorldReply(input: {
  character: Character;
  messages: SocialMessage[];
  self: SocialProfile;
  friend: SocialFriend;
  includeMemory: boolean;
}): Promise<string> {
  const { character, messages, self, friend, includeMemory } = input;
  const binding = resolveBinding(loadBindingConfig(), character.id, "group_chat");
  const api = loadApiConfigs().find(item => item.id === binding.apiConfigId);
  if (!api) throw new Error(`请先给「${character.name}」配置可用的群聊 API。`);

  const identity = resolveUserIdentity(character.id, "group_chat");
  let memoryBlock = "";
  if (includeMemory) {
    const memories = await loadMemoryEntries(character.id);
    memoryBlock = memories
      .filter(item => item.type === "core" || item.type === "long_term")
      .slice(-20)
      .map(item => `- ${compact(item.content, 240)}`)
      .join("\n")
      .slice(0, 3200);
  }

  const history = messages.slice(-40).map(message => ({
    role: "user",
    content: `${speakerLabel(message, self, friend)}：${compact(message.body, 700)}`,
  }));
  const system = [
    `你是${character.name}，正在一个真实共享世界群聊里。`,
    `群聊里的两位真人是${self.displayName}和${friend.profile.displayName}，也可能有双方带来的其他AI角色。`,
    character.persona ? `你的人设：${compact(character.persona, 4000)}` : "",
    character.personality ? `你的性格：${compact(character.personality, 1000)}` : "",
    identity?.name ? `你平时称呼本机用户为${identity.name}。` : "",
    memoryBlock ? `你可参考的本地记忆如下。只能自然延续关系，不要逐条复述、泄露隐私或声称看见了记忆库：\n${memoryBlock}` : "",
    "请阅读共享聊天后自然接话。分清每位真人和AI角色，不要替任何真人说话，不要假装自己是对方手机里的角色。",
    "只输出你真正发到群聊中的一条自然消息，不要写角色名、前缀、括号语气、旁白说明、XML或方括号指令。一般1到3句，除非语境需要，不要长篇大论。",
  ].filter(Boolean).join("\n");

  const result = await simpleLLMCall(api, [
    { role: "system", content: system },
    ...history,
    { role: "user", content: `现在轮到${character.name}决定如何自然接话。` },
  ], { temperature: 0.9, max_tokens: 320 });
  if (!result.content) throw new Error(result.error || "AI 没有生成回复。");
  const reply = result.content
    .replace(/^\s*\[消息\]\s*/i, "")
    .replace(/\s*\[\/消息\]\s*$/i, "")
    .replace(new RegExp(`^\\s*${character.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[：:]\\s*`), "")
    .trim();
  if (!reply) throw new Error("AI 生成了空回复，请重试。");
  return compact(reply, 1500);
}

export function loadSharedWorldCharacters(): Character[] {
  return loadCharacters().filter(character => character.name.trim());
}
