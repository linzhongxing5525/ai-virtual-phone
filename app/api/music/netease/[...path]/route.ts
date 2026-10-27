import { createRequire } from "node:module";

import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { isSelfHostedModeEnabled } from "@/lib/self-hosting";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

const require = createRequire(import.meta.url);
const neteaseApi = require("NeteaseCloudMusicApi") as Record<
    string,
    (query: Record<string, unknown>) => Promise<{ status?: number; body?: unknown }>
>;

const ALLOWED_MODULES = new Set([
    "artist_album",
    "artist_detail",
    "artist_follow_count",
    "artist_top_song",
    "check_music",
    "cloudsearch",
    "comment_music",
    "comment_playlist",
    "lyric",
    "personalized",
    "playlist_detail",
    "playlist_track_all",
    "search",
    "search_hot_detail",
    "song_detail",
    "song_url",
    "toplist_detail",
]);

function noStoreHeaders(): HeadersInit {
    return {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    };
}

function serverCookie(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const part of (process.env.NETEASE_COOKIE || "").split(";")) {
        const separator = part.indexOf("=");
        if (separator < 1) continue;
        result[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
    }
    if (!result.__csrf && process.env.NETEASE_CSRF) result.__csrf = process.env.NETEASE_CSRF;
    return result;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
    if (request.method !== "POST") return {};
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
        const value: unknown = await request.json().catch(() => ({}));
        return value && typeof value === "object" && !Array.isArray(value)
            ? value as Record<string, unknown>
            : {};
    }
    const form = await request.formData();
    return Object.fromEntries([...form.entries()].filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
    const account = await getCurrentAccount(request);
    if (!account) {
        return NextResponse.json(
            { code: 401, message: "请先登录账号" },
            { status: 401, headers: noStoreHeaders() },
        );
    }
    const allowedUsers = (process.env.NETEASE_ALLOWED_USERS || "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
    if (!isSelfHostedModeEnabled() && !allowedUsers.includes(account.username.toLowerCase())) {
        return NextResponse.json(
            { code: 403, message: "当前站内账号没有网易云访问权限" },
            { status: 403, headers: noStoreHeaders() },
        );
    }

    const { path } = await context.params;
    const moduleName = path.join("_");
    const handler = ALLOWED_MODULES.has(moduleName) ? neteaseApi[moduleName] : undefined;
    if (typeof handler !== "function") {
        return NextResponse.json({ code: 404, message: "Not found" }, { status: 404, headers: noStoreHeaders() });
    }

    const cookie = serverCookie();
    if (!cookie.MUSIC_U) {
        return NextResponse.json(
            { code: 503, message: "网易云账号尚未在 Netlify 配置" },
            { status: 503, headers: noStoreHeaders() },
        );
    }

    try {
        const url = new URL(request.url);
        url.searchParams.delete("cookie");
        url.searchParams.delete("realIP");
        const query: Record<string, unknown> = {
            ...Object.fromEntries(url.searchParams),
            ...await readBody(request),
            cookie,
        };
        delete query.realIP;
        const result = await handler(query);
        return NextResponse.json(result?.body ?? result, {
            status: result?.status || 200,
            headers: noStoreHeaders(),
        });
    } catch (error: unknown) {
        const value = error as { status?: number; body?: unknown; message?: string };
        return NextResponse.json(
            value.body ?? { code: value.status || 502, message: value.message || "网易云接口请求失败" },
            { status: value.status || 502, headers: noStoreHeaders() },
        );
    }
}

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
    return handle(request, context);
}

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
    return handle(request, context);
}
