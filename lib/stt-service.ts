// lib/stt-service.ts — 浏览器 Web Speech + 云端录音转写兜底

import type { VoiceApiConfig } from "./settings-types";

export type STTCallbacks = {
    onInterim: (text: string) => void;
    onFinal: (text: string) => void;
    onError: (error: string) => void;
    onEnd: () => void;         // 没有识别到任何内容就结束了
    onNoSpeech: () => void;    // 没检测到语音（用于自动重试）
};

export type STTSession = {
    start: () => void;
    stop: () => void;
    abort: () => void;
    isSupported: boolean;
};

type CloudSTTConfig = Pick<VoiceApiConfig, "sttProvider" | "sttApiKey" | "sttBaseUrl" | "sttModel" | "enableSTT"> | null | undefined;

function isAndroidEdge(): boolean {
    return typeof navigator !== "undefined"
        && /Android/i.test(navigator.userAgent)
        && /EdgA\//i.test(navigator.userAgent);
}

function hasCloudSTT(config: CloudSTTConfig): config is NonNullable<CloudSTTConfig> {
    return Boolean(
        config?.enableSTT !== false
        && (
            ((config?.sttProvider === "Groq" || config?.sttProvider === "OpenAI") && config?.sttApiKey?.trim())
            || (config?.sttProvider === "Custom" && config?.sttBaseUrl?.trim())
        ),
    );
}

function createCloudSTTSession(callbacks: STTCallbacks, lang: string, config: NonNullable<CloudSTTConfig>): STTSession {
    let recorder: MediaRecorder | null = null;
    let stream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let analyserTimer: ReturnType<typeof setInterval> | null = null;
    let maxTimer: ReturnType<typeof setTimeout> | null = null;
    let aborted = false;
    let speechDetected = false;
    let speechStartedAt = 0;
    let lastVoiceAt = 0;
    const chunks: Blob[] = [];

    const cleanup = () => {
        if (analyserTimer) clearInterval(analyserTimer);
        if (maxTimer) clearTimeout(maxTimer);
        analyserTimer = null;
        maxTimer = null;
        try { stream?.getTracks().forEach(track => track.stop()); } catch { /* ignore */ }
        try { audioContext?.close(); } catch { /* ignore */ }
        stream = null;
        audioContext = null;
    };

    const finishRecording = () => {
        if (recorder?.state === "recording") {
            try { recorder.stop(); } catch { /* ignore */ }
        }
    };

    const start = async () => {
        aborted = false;
        speechDetected = false;
        chunks.length = 0;
        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
            callbacks.onError("当前浏览器无法录音");
            return;
        }
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
            if (aborted) { cleanup(); return; }

            const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
                .find(type => { try { return MediaRecorder.isTypeSupported(type); } catch { return false; } });
            recorder = mimeType
                ? new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32_000 })
                : new MediaRecorder(stream);
            recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
            recorder.onerror = () => { cleanup(); if (!aborted) callbacks.onError("录音失败"); };
            recorder.onstop = async () => {
                const detected = speechDetected;
                const blob = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" });
                cleanup();
                if (aborted) return;
                if (!detected || blob.size < 800) {
                    callbacks.onNoSpeech();
                    return;
                }
                callbacks.onInterim("正在识别…");
                try {
                    const form = new FormData();
                    form.set("file", blob, blob.type.includes("mp4") ? "speech.m4a" : "speech.webm");
                    form.set("provider", config.sttProvider || "");
                    form.set("apiKey", config.sttApiKey || "");
                    if (config.sttBaseUrl?.trim()) form.set("baseUrl", config.sttBaseUrl.trim());
                    if (config.sttModel?.trim()) form.set("model", config.sttModel.trim());
                    form.set("language", lang.toLowerCase().startsWith("zh") ? "zh" : lang.split("-")[0]);
                    const response = await fetch("/api/voice/transcribe", { method: "POST", body: form });
                    const data = await response.json().catch(() => ({})) as { text?: string; error?: string };
                    if (!response.ok) throw new Error(data.error || `语音识别失败 (${response.status})`);
                    const text = data.text?.trim() || "";
                    if (text) callbacks.onFinal(text);
                    else callbacks.onNoSpeech();
                } catch (error) {
                    callbacks.onError(error instanceof Error ? error.message : "语音识别失败");
                }
            };
            recorder.start(250);

            const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (AudioContextCtor) {
                audioContext = new AudioContextCtor();
                const source = audioContext.createMediaStreamSource(stream);
                const analyser = audioContext.createAnalyser();
                analyser.fftSize = 1024;
                source.connect(analyser);
                const samples = new Uint8Array(analyser.fftSize);
                analyserTimer = setInterval(() => {
                    if (!analyser || aborted) return;
                    analyser.getByteTimeDomainData(samples);
                    let sum = 0;
                    for (const sample of samples) {
                        const normalized = (sample - 128) / 128;
                        sum += normalized * normalized;
                    }
                    const rms = Math.sqrt(sum / samples.length);
                    const now = Date.now();
                    if (rms > 0.025) {
                        if (!speechDetected) {
                            speechDetected = true;
                            speechStartedAt = now;
                            callbacks.onInterim("正在聆听…");
                        }
                        lastVoiceAt = now;
                    } else if (speechDetected && now - speechStartedAt > 650 && now - lastVoiceAt > 1100) {
                        finishRecording();
                    }
                }, 100);
            } else {
                // Without an analyser we still capture a useful fixed-length utterance.
                speechDetected = true;
                callbacks.onInterim("正在聆听…");
            }
            maxTimer = setTimeout(finishRecording, 15_000);
        } catch (error) {
            cleanup();
            if (!aborted) {
                const name = error instanceof DOMException ? error.name : "";
                callbacks.onError(name === "NotAllowedError" ? "麦克风权限被拒绝" : "无法访问麦克风");
            }
        }
    };

    return {
        start: () => { void start(); },
        stop: finishRecording,
        abort: () => {
            aborted = true;
            if (recorder?.state === "recording") { try { recorder.stop(); } catch { /* ignore */ } }
            cleanup();
        },
        isSupported: true,
    };
}

/**
 * Create an STT session using browser Web Speech API.
 */
export function createSTTSession(
    callbacks: STTCallbacks,
    lang = "zh-CN",
    cloudConfig?: CloudSTTConfig,
): STTSession {
    if (isAndroidEdge()) {
        if (hasCloudSTT(cloudConfig)) return createCloudSTTSession(callbacks, lang, cloudConfig);
        return {
            start: () => callbacks.onError("Android Edge 的内置语音识别不可用，请在语音设置中配置 Groq 或 OpenAI 云端识别"),
            stop: () => {},
            abort: () => {},
            isSupported: true,
        };
    }
    const SpeechRecognition =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
        return {
            start: () => callbacks.onError("浏览器不支持语音识别"),
            stop: () => {},
            abort: () => {},
            isSupported: false,
        };
    }

    const recognition = new SpeechRecognition();
    recognition.lang = lang;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    let aborted = false;
    let finalText = "";
    let hadNoSpeech = false;

    recognition.onresult = (event: any) => {
        if (aborted) return;

        let interim = "";
        finalText = "";
        for (let i = 0; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                finalText += transcript;
            } else {
                interim += transcript;
            }
        }

        callbacks.onInterim(finalText + interim);
    };

    recognition.onerror = (event: any) => {
        if (aborted) return;
        if (event.error === "aborted") return;

        if (event.error === "no-speech") {
            hadNoSpeech = true;
            return;
        }

        const errorMap: Record<string, string> = {
            "audio-capture": "无法访问麦克风",
            "not-allowed": "麦克风权限被拒绝",
            "network": "网络错误",
        };
        callbacks.onError(errorMap[event.error] || `语音识别错误: ${event.error}`);
    };

    recognition.onend = () => {
        if (aborted) return;

        if (finalText.trim()) {
            callbacks.onFinal(finalText.trim());
        } else if (hadNoSpeech) {
            hadNoSpeech = false;
            callbacks.onNoSpeech();
        } else {
            callbacks.onEnd();
        }
    };

    return {
        start: () => {
            aborted = false;
            finalText = "";
            hadNoSpeech = false;
            try {
                recognition.start();
            } catch {
                // Already started — ignore
            }
        },
        stop: () => {
            try {
                recognition.stop();
            } catch {
                // Already stopped — ignore
            }
        },
        abort: () => {
            aborted = true;
            try {
                recognition.abort();
            } catch {
                // Already aborted — ignore
            }
        },
        isSupported: true,
    };
}
