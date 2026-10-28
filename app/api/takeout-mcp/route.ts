import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
    authenticateTakeoutBridge,
    jobKey,
    normalizeTakeoutBridgeId,
    normalizeTakeoutOrderInput,
    readTakeoutBearerToken,
    takeoutStore,
    type TakeoutJobRecord,
} from "@/lib/takeout-bridge-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MCP_PROTOCOL_VERSION = "2025-03-26";

const PREPARE_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        kw: { type: "string", description: "用户想吃/喝的内容，例如冰美式、米线、奶茶" },
        dish: { type: "string", description: "可选，用户明确点名的菜品" },
        shop: { type: "string", description: "可选，用户明确指定的店铺关键词" },
        specs: { type: "array", items: { type: "string" }, description: "可选规格，例如大杯、少冰、三分糖" },
        qty: { type: "number", description: "数量，默认 1" },
        address: { type: "string", description: "本机地址簿里的标签，例如家、公司；不要填写完整门牌地址" },
        max: { type: "number", description: "用户允许的最高实付金额，人民币元" },
    },
    required: ["kw", "max"],
};

const PUBLIC_TOOLS = [
    {
        name: "查看真实外卖助手状态",
        description: "查看用户电脑上的真实外卖助手是否在线，以及可用地址标签和默认预算。只读，可在聊到点餐或收货安排时主动调用。",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    {
        name: "准备真实外卖订单",
        description: "用户本轮明确表示想让你替他点外卖时使用。生成独立订单确认卡，用户点击卡片后才会真实下单；调用本动作本身不会花钱。不得因为闲聊、猜测或角色自己想送餐而擅自准备订单。",
        inputSchema: PREPARE_SCHEMA,
    },
];

function rpc(id: unknown, result?: unknown, error?: { code: number; message: string }) {
    return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, ...(error ? { error } : { result }) }, {
        headers: { "cache-control": "no-store", "MCP-Protocol-Version": MCP_PROTOCOL_VERSION },
    });
}
function textResult(value: unknown) {
    return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

export async function POST(request: NextRequest) {
    const bridgeId = normalizeTakeoutBridgeId(request.nextUrl.searchParams.get("id"));
    const token = readTakeoutBearerToken(request);
    if (!bridgeId || !token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const pair = await authenticateTakeoutBridge(bridgeId, token);
    if (!pair) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await request.json().catch(() => null) as { id?: unknown; method?: string; params?: Record<string, unknown> } | null;
    if (!body?.method) return rpc(body?.id, undefined, { code: -32600, message: "Invalid Request" });

    if (body.method === "initialize") {
        return rpc(body.id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "Starforest 真实外卖助手", version: "1.0.0" },
        });
    }
    if (body.method === "notifications/initialized") return rpc(body.id, {});
    if (body.method === "tools/list") return rpc(body.id, { tools: PUBLIC_TOOLS });
    if (body.method !== "tools/call") return rpc(body.id, undefined, { code: -32601, message: "Method not found" });

    const name = String(body.params?.name || "");
    const args = body.params?.arguments && typeof body.params.arguments === "object"
        ? body.params.arguments as Record<string, unknown>
        : {};
    const workerOnline = Boolean(pair.workerLastSeenAt && Date.now() - pair.workerLastSeenAt < 45_000);

    if (name === "查看真实外卖助手状态") {
        return rpc(body.id, textResult({
            online: workerOnline,
            lastSeenAt: pair.workerLastSeenAt || null,
            addressLabels: pair.profile?.addressLabels || [],
            maskedPhone: pair.profile?.maskedPhone || null,
            defaultAddress: pair.profile?.defaultAddress || null,
            defaultBudget: pair.profile?.defaultBudget || null,
            note: workerOnline ? "外卖助手在线" : "外卖助手离线，请在电脑上启动 Starforest 外卖助手",
        }));
    }

    if (name === "准备真实外卖订单") {
        if (!workerOnline) return rpc(body.id, textResult({ ok: false, error: "外卖助手离线，请先在电脑上启动" }));
        try {
            const input = normalizeTakeoutOrderInput(args, pair.profile);
            const jobId = randomUUID();
            const now = Date.now();
            const job: TakeoutJobRecord = { id: jobId, bridgeId, status: "queued_prepare", input, createdAt: now, updatedAt: now };
            await takeoutStore().setJSON(jobKey(bridgeId, jobId), job);
            return rpc(body.id, textResult({
                kind: "starforest.takeout.approval",
                version: 1,
                serverJobId: jobId,
                summary: input.dish || input.kw,
                shop: input.shop || "自动选择合适店铺",
                addressLabel: input.address,
                maskedPhone: pair.profile?.maskedPhone || "本机保存",
                quantity: input.qty,
                specs: input.specs || [],
                maxAmount: input.max,
            }));
        } catch (error) {
            return rpc(body.id, textResult({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        }
    }

    const jobId = String(args.jobId || "");
    if (!/^[a-f0-9-]{20,64}$/.test(jobId)) return rpc(body.id, textResult({ ok: false, error: "任务 ID 无效" }));
    const store = takeoutStore();
    const key = jobKey(bridgeId, jobId);
    const job = await store.get(key, { type: "json" }) as TakeoutJobRecord | null;
    if (!job) return rpc(body.id, textResult({ ok: false, error: "订单确认已失效" }));

    if (name === "__confirm_takeout_order") {
        if (!workerOnline) return rpc(body.id, textResult({ ok: false, error: "外卖助手已离线，请在电脑上启动后再确认" }));
        if (job.status !== "review_pending") return rpc(body.id, textResult({ ok: false, error: `当前状态不能确认：${job.status}` }));
        const next: TakeoutJobRecord = { ...job, status: "queued_submit", confirmedAt: Date.now(), updatedAt: Date.now() };
        await store.setJSON(key, next);
        return rpc(body.id, textResult({ ok: true, status: next.status }));
    }
    if (name === "__cancel_takeout_order") {
        if (job.status === "queued_prepare" || job.status === "review_pending" || job.status === "queued_submit") {
            await store.setJSON(key, { ...job, status: "canceled", updatedAt: Date.now(), finishedAt: Date.now() });
        }
        return rpc(body.id, textResult({ ok: true, status: "canceled" }));
    }
    if (name === "__takeout_order_status") {
        const current = await store.get(key, { type: "json" }) as TakeoutJobRecord | null;
        if (!current) return rpc(body.id, textResult({ ok: false, error: "订单确认已失效" }));
        return rpc(body.id, textResult({
            ok: true,
            status: current.status,
            result: current.result ?? null,
            error: current.error || null,
            updatedAt: current.updatedAt,
        }));
    }
    return rpc(body.id, undefined, { code: -32602, message: "Unknown tool" });
}
