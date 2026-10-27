import { kvGet, kvRemove, kvSet } from "./kv-db";

const REAL_PHONE_BRIDGE_KEY = "ai_phone_real_phone_bridge_v1";

export type RealPhoneBridgeConfig = {
    bridgeId: string;
    secret: string;
    createdAt: number;
};

export type RealPhonePermissionState = Record<string, boolean>;

export type RealPhoneSnapshot = {
    version: number;
    capturedAt: number;
    device?: Record<string, unknown>;
    permissions?: RealPhonePermissionState;
    notifications?: unknown[];
    contacts?: unknown[];
    sms?: unknown[];
    calls?: unknown[];
    media?: unknown[];
    calendar?: unknown[];
    location?: unknown;
    usage?: unknown[];
};

function randomToken(bytes: number): string {
    const data = new Uint8Array(bytes);
    crypto.getRandomValues(data);
    return Array.from(data, value => value.toString(16).padStart(2, "0")).join("");
}

export function loadRealPhoneBridgeConfig(): RealPhoneBridgeConfig | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = kvGet(REAL_PHONE_BRIDGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<RealPhoneBridgeConfig>;
        if (!parsed.bridgeId || !parsed.secret) return null;
        return { bridgeId: parsed.bridgeId, secret: parsed.secret, createdAt: parsed.createdAt || Date.now() };
    } catch {
        return null;
    }
}

export function createRealPhoneBridgeConfig(): RealPhoneBridgeConfig {
    const config = { bridgeId: randomToken(16), secret: randomToken(32), createdAt: Date.now() };
    kvSet(REAL_PHONE_BRIDGE_KEY, JSON.stringify(config));
    return config;
}

export function clearRealPhoneBridgeConfig(): void {
    kvRemove(REAL_PHONE_BRIDGE_KEY);
}

export function buildRealPhonePairingCode(config: RealPhoneBridgeConfig): string {
    return btoa(JSON.stringify({ v: 1, i: config.bridgeId, s: config.secret, u: window.location.origin }));
}

function base64ToBytes(value: string): Uint8Array {
    const binary = atob(value);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function hexToBytes(value: string): Uint8Array {
    if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("手机桥接密钥格式无效");
    return Uint8Array.from(value.match(/.{2}/g) || [], part => Number.parseInt(part, 16));
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
    const buffer = new ArrayBuffer(value.byteLength);
    new Uint8Array(buffer).set(value);
    return buffer;
}

async function bridgeAuthToken(secret: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(hexToBytes(secret)));
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

async function importBridgeKey(secret: string): Promise<CryptoKey> {
    return crypto.subtle.importKey("raw", toArrayBuffer(hexToBytes(secret)), { name: "AES-GCM" }, false, ["decrypt"]);
}

async function decryptEnvelope(secret: string, envelope: { iv: string; ciphertext: string }): Promise<RealPhoneSnapshot> {
    const key = await importBridgeKey(secret);
    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(envelope.iv)) },
        key,
        toArrayBuffer(base64ToBytes(envelope.ciphertext)),
    );
    return JSON.parse(new TextDecoder().decode(decrypted)) as RealPhoneSnapshot;
}

export async function fetchRealPhoneSnapshot(): Promise<RealPhoneSnapshot> {
    const config = loadRealPhoneBridgeConfig();
    if (!config) throw new Error("尚未配对真实手机助手");
    const authToken = await bridgeAuthToken(config.secret);
    const response = await fetch(`/api/phone-bridge/snapshot?id=${encodeURIComponent(config.bridgeId)}`, {
        headers: { Authorization: `Bearer ${authToken}` },
        cache: "no-store",
    });
    const data = await response.json().catch(() => ({})) as { envelope?: { iv: string; ciphertext: string }; error?: string };
    if (!response.ok || !data.envelope) throw new Error(data.error || "无法读取真实手机快照");
    return decryptEnvelope(config.secret, data.envelope);
}

export function summarizeRealPhoneSnapshot(snapshot: RealPhoneSnapshot, section: string, query?: string, limit = 30): unknown {
    if (section === "status") {
        return { capturedAt: snapshot.capturedAt, device: snapshot.device, permissions: snapshot.permissions };
    }
    const value = snapshot[section as keyof RealPhoneSnapshot];
    if (!Array.isArray(value)) return value ?? null;
    const normalizedQuery = query?.trim().toLowerCase();
    const filtered = normalizedQuery
        ? value.filter(item => JSON.stringify(item).toLowerCase().includes(normalizedQuery))
        : value;
    return filtered.slice(0, Math.max(1, Math.min(100, limit)));
}
