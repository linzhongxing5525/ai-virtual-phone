import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function normalizeId(value: string | null): string | null {
    return value && /^[a-f0-9]{32}$/.test(value) ? value : null;
}

function readAuthToken(request: NextRequest): string | null {
    const value = request.headers.get("authorization") || "";
    const secret = value.startsWith("Bearer ") ? value.slice(7).trim() : "";
    return /^[a-f0-9]{64}$/.test(secret) ? secret : null;
}

function authHash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

function hashesEqual(a: string, b: string): boolean {
    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");
    return left.length === right.length && timingSafeEqual(left, right);
}

function store() {
    return getStore({ name: "starforest-phone-bridge", consistency: "strong" });
}

export async function PUT(request: NextRequest) {
    const id = normalizeId(request.nextUrl.searchParams.get("id"));
    const token = readAuthToken(request);
    if (!id || !token) return NextResponse.json({ error: "配对凭据无效" }, { status: 401 });
    const raw = await request.text();
    if (!raw || Buffer.byteLength(raw) > MAX_BODY_BYTES) return NextResponse.json({ error: "快照为空或过大" }, { status: 413 });
    let envelope: { iv?: unknown; ciphertext?: unknown };
    try { envelope = JSON.parse(raw); } catch { return NextResponse.json({ error: "快照格式无效" }, { status: 400 }); }
    if (typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") {
        return NextResponse.json({ error: "加密快照格式无效" }, { status: 400 });
    }
    await store().setJSON(id, { authHash: authHash(token), updatedAt: Date.now(), envelope });
    return NextResponse.json({ ok: true });
}

export async function GET(request: NextRequest) {
    const id = normalizeId(request.nextUrl.searchParams.get("id"));
    const token = readAuthToken(request);
    if (!id || !token) return NextResponse.json({ error: "配对凭据无效" }, { status: 401 });
    const record = await store().get(id, { type: "json" }) as { authHash?: string; updatedAt?: number; envelope?: unknown } | null;
    if (!record?.authHash || !hashesEqual(record.authHash, authHash(token))) {
        return NextResponse.json({ error: "未找到已配对手机或密钥不匹配" }, { status: 404 });
    }
    return NextResponse.json({ updatedAt: record.updatedAt, envelope: record.envelope }, { headers: { "cache-control": "no-store" } });
}
