import { NextRequest, NextResponse } from "next/server";
import {
    normalizeTakeoutBridgeId,
    normalizeTakeoutProfile,
    pairKey,
    readTakeoutBearerToken,
    takeoutAuthHash,
    takeoutStore,
    type TakeoutPairRecord,
} from "@/lib/takeout-bridge-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: NextRequest) {
    const bridgeId = normalizeTakeoutBridgeId(request.nextUrl.searchParams.get("id"));
    const token = readTakeoutBearerToken(request);
    if (!bridgeId || !token) return NextResponse.json({ error: "配对凭据无效" }, { status: 401 });
    let body: unknown = {};
    try { body = await request.json(); } catch { /* empty profile is allowed */ }
    const store = takeoutStore();
    const existing = await store.get(pairKey(bridgeId), { type: "json" }) as TakeoutPairRecord | null;
    if (existing?.authHash && existing.authHash !== takeoutAuthHash(token)) {
        return NextResponse.json({ error: "该桥接 ID 已使用其他密钥配对" }, { status: 409 });
    }
    const now = Date.now();
    const record: TakeoutPairRecord = {
        authHash: takeoutAuthHash(token),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        workerLastSeenAt: now,
        profile: normalizeTakeoutProfile(body),
    };
    await store.setJSON(pairKey(bridgeId), record);
    return NextResponse.json({ ok: true, profile: record.profile });
}
