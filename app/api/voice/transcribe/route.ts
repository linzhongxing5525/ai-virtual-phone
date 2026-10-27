import { NextResponse } from "next/server";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const runtime = "nodejs";
export const maxDuration = 60;

const PROVIDERS = {
    Groq: {
        baseUrl: "https://api.groq.com/openai/v1",
        defaultModel: "whisper-large-v3-turbo",
    },
    OpenAI: {
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4o-mini-transcribe",
    },
} as const;

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

function resolveCustomBaseUrl(value: FormDataEntryValue | null): string | null {
    try {
        const url = new URL(String(value || ""));
        if (url.protocol !== "https:") return null;
        const host = url.hostname.toLowerCase();
        if (
            host === "localhost"
            || host === "0.0.0.0"
            || host === "::1"
            || host.endsWith(".local")
            || /^127\./.test(host)
            || /^10\./.test(host)
            || /^192\.168\./.test(host)
            || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
        ) return null;
        return url.toString().replace(/\/$/, "");
    } catch {
        return null;
    }
}

function isPrivateIpv4(host: string): boolean {
    const parts = host.split(".").map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
        || (a === 100 && b >= 64 && b <= 127);
}

function isPrivateAddress(address: string): boolean {
    const normalized = address.toLowerCase().replace(/^::ffff:/, "");
    if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc")
        || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

async function assertPublicHost(rawUrl: string): Promise<void> {
    const hostname = new URL(rawUrl).hostname;
    if (isPrivateAddress(hostname)) throw new Error("自建转写服务不能使用内网地址");
    const addresses = await lookup(hostname, { all: true });
    if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
        throw new Error("自建转写服务解析到了内网地址");
    }
}

export async function POST(request: Request) {
    try {
        const incoming = await request.formData();
        const audio = incoming.get("file");
        const providerName = String(incoming.get("provider") || "");
        const apiKey = String(incoming.get("apiKey") || "").trim();
        const builtInProvider = PROVIDERS[providerName as keyof typeof PROVIDERS];
        const customBaseUrl = providerName === "Custom" ? resolveCustomBaseUrl(incoming.get("baseUrl")) : null;
        const provider = builtInProvider || (customBaseUrl ? { baseUrl: customBaseUrl, defaultModel: "whisper-1" } : null);

        if (!(audio instanceof File) || audio.size === 0) {
            return NextResponse.json({ error: "没有收到录音" }, { status: 400 });
        }
        if (audio.size > MAX_AUDIO_BYTES) {
            return NextResponse.json({ error: "录音文件过大" }, { status: 413 });
        }
        if (!provider) {
            return NextResponse.json({ error: "不支持的语音识别服务" }, { status: 400 });
        }
        if (!apiKey && providerName !== "Custom") {
            return NextResponse.json({ error: "语音识别 API Key 未配置" }, { status: 400 });
        }
        if (providerName === "Custom") await assertPublicHost(provider.baseUrl);

        const upstreamBody = new FormData();
        upstreamBody.set("file", audio, audio.name || "speech.webm");
        upstreamBody.set("model", String(incoming.get("model") || provider.defaultModel));
        upstreamBody.set("language", String(incoming.get("language") || "zh"));
        upstreamBody.set("response_format", "json");

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 55_000);
        let response: Response;
        try {
            response = await fetch(`${provider.baseUrl}/audio/transcriptions`, {
                method: "POST",
                headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
                body: upstreamBody,
                signal: controller.signal,
                redirect: "error",
            });
        } finally {
            clearTimeout(timer);
        }

        const data = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (!response.ok) {
            const nested = data.error && typeof data.error === "object" ? data.error as Record<string, unknown> : null;
            const message = String(nested?.message || data.message || `转写服务请求失败 (${response.status})`);
            return NextResponse.json({ error: message }, { status: response.status });
        }

        const text = typeof data.text === "string" ? data.text.trim() : "";
        return NextResponse.json({ text });
    } catch (error) {
        const message = error instanceof Error && error.name === "AbortError"
            ? "语音识别超时"
            : error instanceof Error ? error.message : "语音识别失败";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
