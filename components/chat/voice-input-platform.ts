"use client";

/**
 * Detect the actual Web Speech capability instead of blocking Android as a
 * platform. Chrome/Edge on Android expose webkitSpeechRecognition and work for
 * hands-free calls; browsers without it will still fall back to text input.
 */
export function supportsBrowserSpeechRecognition(): boolean {
    if (typeof window === "undefined") return false;
    const speechWindow = window as typeof window & {
        SpeechRecognition?: unknown;
        webkitSpeechRecognition?: unknown;
    };
    return Boolean(speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition);
}

export function isAndroidEdgeBrowser(): boolean {
    if (typeof navigator === "undefined") return false;
    return /Android/i.test(navigator.userAgent) && /EdgA\//i.test(navigator.userAgent);
}
