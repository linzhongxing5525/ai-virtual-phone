import { NextRequest, NextResponse } from "next/server";
import {
    authenticateTakeoutBridge,
    jobKey,
    normalizeTakeoutBridgeId,
    pairKey,
    readTakeoutBearerToken,
    takeoutStore,
    type TakeoutJobRecord,
} from "@/lib/takeout-bridge-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function credentials(request: NextRequest) {
    const bridgeId = normalizeTakeoutBridgeId(request.nextUrl.searchParams.get("id"));
    const token = readTakeoutBearerToken(request);
    if (!bridgeId || !token) return null;
    const pair = await authenticateTakeoutBridge(bridgeId, token);
    return pair ? { bridgeId, pair } : null;
}
export async function GET(request: NextRequest) {
    const auth = await credentials(request);
    if (!auth) return NextResponse.json({ error: "配对凭据无效" }, { status: 401 });
    const store = takeoutStore();
    await store.setJSON(pairKey(auth.bridgeId), { ...auth.pair, workerLastSeenAt: Date.now(), updatedAt: Date.now() });
    const listing = await store.list({ prefix: `jobs/${auth.bridgeId}/` });
    for (const blob of listing.blobs) {
        const job = await store.get(blob.key, { type: "json" }) as TakeoutJobRecord | null;
        if (!job || (job.status !== "queued_prepare" && job.status !== "queued_submit")) continue;
        const running: TakeoutJobRecord = {
            ...job,
            status: job.status === "queued_prepare" ? "preparing" : "submitting",
            startedAt: Date.now(),
            updatedAt: Date.now(),
        };
        await store.setJSON(blob.key, running);
        return NextResponse.json({ job: running }, { headers: { "cache-control": "no-store" } });
    }
    return NextResponse.json({ job: null }, { headers: { "cache-control": "no-store" } });
}

export async function PUT(request: NextRequest) {
    const auth = await credentials(request);
    if (!auth) return NextResponse.json({ error: "配对凭据无效" }, { status: 401 });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const jobId = typeof body?.jobId === "string" && /^[a-f0-9-]{20,64}$/.test(body.jobId) ? body.jobId : null;
    if (!jobId) return NextResponse.json({ error: "任务 ID 无效" }, { status: 400 });
    const store = takeoutStore();
    const key = jobKey(auth.bridgeId, jobId);
    const job = await store.get(key, { type: "json" }) as TakeoutJobRecord | null;
    if (!job) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
    const phase = body?.phase === "preview" ? "preview" : "final";
    const ok = body?.ok === true;
    if (phase === "preview" && job.status !== "preparing") {
        return NextResponse.json({ error: "订单已不在准备阶段" }, { status: 409 });
    }
    if (phase === "final" && job.status !== "submitting") {
        return NextResponse.json({ error: "订单已不在提交阶段" }, { status: 409 });
    }
    const next: TakeoutJobRecord = {
        ...job,
        status: ok ? (phase === "preview" ? "review_pending" : "completed") : "failed",
        updatedAt: Date.now(),
        ...(ok && phase === "final" ? { finishedAt: Date.now() } : {}),
        ...(ok ? { result: body?.result ?? null } : { finishedAt: Date.now(), error: String(body?.error || "下单失败").slice(0, 4000), result: body?.result ?? null }),
    };
    await store.setJSON(key, next);
    return NextResponse.json({ ok: true });
}
