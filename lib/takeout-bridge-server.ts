import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export type TakeoutPairRecord = {
    authHash: string;
    createdAt: number;
    updatedAt: number;
    workerLastSeenAt?: number;
    profile?: {
        addressLabels: string[];
        maskedPhone?: string;
        defaultAddress?: string;
        defaultBudget?: number;
    };
};

export type TakeoutOrderInput = {
    kw: string;
    dish?: string;
    shop?: string;
    specs?: string[];
    qty: number;
    address: string;
    max: number;
};

export type TakeoutJobRecord = {
    id: string;
    bridgeId: string;
    status: "queued_prepare" | "preparing" | "review_pending" | "queued_submit" | "submitting" | "completed" | "failed" | "canceled";
    input: TakeoutOrderInput;
    createdAt: number;
    updatedAt: number;
    confirmedAt?: number;
    startedAt?: number;
    finishedAt?: number;
    result?: unknown;
    error?: string;
};

export function takeoutStore() {
    return getStore({ name: "starforest-takeout-bridge", consistency: "strong" });
}
export function normalizeTakeoutBridgeId(value: string | null): string | null {
    return value && /^[a-f0-9]{32}$/.test(value) ? value : null;
}

export function normalizeTakeoutToken(value: string | null): string | null {
    return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

export function readTakeoutBearerToken(request: NextRequest): string | null {
    const value = request.headers.get("authorization") || "";
    return normalizeTakeoutToken(value.startsWith("Bearer ") ? value.slice(7).trim() : null);
}

export function takeoutAuthHash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

function hashesEqual(a: string, b: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");
    return left.length === right.length && timingSafeEqual(left, right);
}

export function pairKey(bridgeId: string): string {
    return `pairs/${bridgeId}`;
}

export function jobKey(bridgeId: string, jobId: string): string {
    return `jobs/${bridgeId}/${jobId}`;
}

export async function authenticateTakeoutBridge(
    bridgeId: string,
    token: string,
): Promise<TakeoutPairRecord | null> {
    const record = await takeoutStore().get(pairKey(bridgeId), { type: "json" }) as TakeoutPairRecord | null;
    if (!record?.authHash || !hashesEqual(record.authHash, takeoutAuthHash(token))) return null;
    return record;
}

export function maskTakeoutPhone(value: unknown): string | undefined {
    const digits = String(value ?? "").replace(/\D/g, "");
    if (digits.length < 7) return undefined;
    return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

export function normalizeTakeoutProfile(value: unknown): TakeoutPairRecord["profile"] {
    const record = value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    const labels = Array.isArray(record.addressLabels)
        ? record.addressLabels.map(String).map(item => item.trim()).filter(Boolean).slice(0, 20)
        : [];
    const defaultBudget = Number(record.defaultBudget);
    const defaultAddress = String(record.defaultAddress || "").trim();
    return {
        addressLabels: labels,
        ...(maskTakeoutPhone(record.phone ?? record.maskedPhone) ? { maskedPhone: maskTakeoutPhone(record.phone ?? record.maskedPhone) } : {}),
        ...(defaultAddress ? { defaultAddress: defaultAddress.slice(0, 40) } : {}),
        ...(Number.isFinite(defaultBudget) && defaultBudget > 0 ? { defaultBudget: Math.min(1000, defaultBudget) } : {}),
    };
}

export function normalizeTakeoutOrderInput(value: unknown, profile?: TakeoutPairRecord["profile"]): TakeoutOrderInput {
    const record = value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    const kw = String(record.kw || record.item || record.query || "").trim().slice(0, 100);
    if (!kw) throw new Error("请说明想点什么");
    const address = String(record.address || profile?.defaultAddress || "家").trim().slice(0, 40);
    if (profile?.addressLabels?.length && !profile.addressLabels.includes(address)) {
        throw new Error(`地址标签不存在，可用地址：${profile.addressLabels.join("、")}`);
    }
    const requestedMax = Number(record.max ?? record.budget ?? profile?.defaultBudget ?? 50);
    if (!Number.isFinite(requestedMax) || requestedMax <= 0) throw new Error("金额上限必须大于 0");
    const localMax = Number(profile?.defaultBudget);
    const maxValue = Number.isFinite(localMax) && localMax > 0
        ? Math.min(requestedMax, localMax)
        : requestedMax;
    const qtyValue = Number(record.qty ?? 1);
    const rawSpecs = record.specs ?? record.规格;
    const specs = Array.isArray(rawSpecs)
        ? rawSpecs.map(String).map((item: string) => item.trim()).filter(Boolean).slice(0, 10)
        : [];
    const dish = String(record.dish || "").trim().slice(0, 100);
    const shop = String(record.shop || "").trim().slice(0, 100);
    return {
        kw,
        ...(dish ? { dish } : {}),
        ...(shop ? { shop } : {}),
        ...(specs.length ? { specs } : {}),
        qty: Math.max(1, Math.min(10, Math.floor(Number.isFinite(qtyValue) ? qtyValue : 1))),
        address: address || "家",
        max: Math.round(Math.min(1000, maxValue) * 100) / 100,
    };
}
