#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const configPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(process.cwd(), "takeout-bridge.local.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const origin = String(config.origin || "https://starforest.netlify.app").replace(/\/$/, "");
const bridgeId = String(config.bridgeId || "");
const token = String(config.token || "");
const upstreamDir = path.resolve(config.upstreamDir || "");
const pollMs = Math.max(3000, Number(config.pollMs) || 5000);
const orderTimeoutMs = Math.max(120000, Number(config.orderTimeoutMs) || 12 * 60 * 1000);
const configuredBudgetCap = Number(config.defaultBudget);
const budgetCap = Number.isFinite(configuredBudgetCap) && configuredBudgetCap > 0
    ? configuredBudgetCap
    : 50;

if (!/^[a-f0-9]{32}$/.test(bridgeId) || !/^[a-f0-9]{64}$/.test(token)) {
    throw new Error("takeout-bridge.local.json 的 bridgeId/token 无效，请重新运行 setup.ps1");
}
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const pairUrl = `${origin}/api/takeout-bridge/pair?id=${bridgeId}`;
const workerUrl = `${origin}/api/takeout-bridge/worker?id=${bridgeId}`;

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function request(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
}

function runOrder(input, dry = false) {
    return new Promise((resolve, reject) => {
        const args = {
            kw: input.kw,
            ...(input.dish ? { dish: input.dish } : {}),
            ...(input.shop ? { shop: input.shop, 店含: input.shop } : {}),
            ...(Array.isArray(input.specs) && input.specs.length ? { 规格: input.specs } : {}),
            qty: input.qty,
            addr: input.address,
            max: Math.min(Number(input.max) || budgetCap, budgetCap),
            ...(dry ? { dry: true } : {}),
            cdp: config.cdp || "http://127.0.0.1:9222",
        };
        // The upstream project is CommonJS. It currently has no explicit license,
        // so setup downloads it unchanged instead of bundling a fork here.
        const upstreamScript = path.join(upstreamDir, "script", "order.cjs");
        const child = spawn(process.execPath, [upstreamScript, JSON.stringify(args)], {
            cwd: path.join(upstreamDir, "script"),
            env: { ...process.env, TAKEOUT_PHONE: String(config.phone || "") },
            windowsHide: false,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error("真实下单超过等待时间，已停止本次任务；请检查专用 Chrome"));
        }, orderTimeoutMs);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", chunk => { stdout += chunk; });
        child.stderr.on("data", chunk => { stderr += chunk; });
        child.on("error", error => { clearTimeout(timer); reject(error); });
        child.on("close", code => {
            clearTimeout(timer);
            const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
            let parsed = null;
            for (let index = lines.length - 1; index >= 0; index -= 1) {
                try { parsed = JSON.parse(lines[index]); break; } catch { /* keep looking */ }
            }
            if (parsed?.ok) resolve(parsed);
            else reject(Object.assign(new Error(parsed?.why || stderr.trim() || `order.js 退出码 ${code}`), { result: parsed }));
        });
    });
}

await mkdir(path.join(path.parse(os.homedir()).root, "tmp"), { recursive: true }).catch(() => null);
await request(pairUrl, {
    method: "PUT",
    body: JSON.stringify({
        addressLabels: Object.keys(config.places || {}).filter(key => key !== "认" && key !== "phone"),
        phone: config.phone,
        defaultAddress: config.defaultAddress || "家",
        defaultBudget: config.defaultBudget || 50,
    }),
});

console.log("Starforest 外卖助手已连接。请保持此窗口和专用 Chrome 开启。");
console.log(`地址标签：${Object.keys(config.places || {}).filter(key => key !== "认" && key !== "phone").join("、") || "未配置"}`);

while (true) {
    try {
        const { job } = await request(workerUrl, { method: "GET" });
        if (!job) {
            await wait(pollMs);
            continue;
        }
        const preparing = job.status === "preparing";
        console.log(`[${new Date().toLocaleTimeString()}] ${preparing ? "试算订单" : "提交已确认订单"}：${job.input.kw} → ${job.input.address}`);
        try {
            const result = await runOrder(job.input, preparing);
            await request(workerUrl, {
                method: "PUT",
                body: JSON.stringify({ jobId: job.id, phase: preparing ? "preview" : "final", ok: true, result }),
            });
            console.log(preparing ? "试算完成，等待你在 Starforest 确认。" : "订单已提交。结果已返回 Starforest。");
        } catch (error) {
            await request(workerUrl, {
                method: "PUT",
                body: JSON.stringify({
                    jobId: job.id,
                    phase: preparing ? "preview" : "final",
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                    result: error?.result || null,
                }),
            });
            console.error(preparing ? "试算未完成：" : "下单未完成：", error instanceof Error ? error.message : error);
        }
    } catch (error) {
        console.error("连接暂时失败：", error instanceof Error ? error.message : error);
        await wait(Math.max(10000, pollMs));
    }
}
