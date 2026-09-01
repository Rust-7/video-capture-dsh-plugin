import { CAPTURE_REQUEST_VERSION, type CaptureRequestV1 } from "./contracts.js";
import { captureError } from "./errors.js";

export type CaptureRequestValidation =
    | { ok: true; value: CaptureRequestV1 }
    | { ok: false; error: ReturnType<typeof captureError> };

export function validateCaptureRequest(input: unknown): CaptureRequestValidation {
    if (!isRecord(input)) {
        return invalidRequest();
    }

    const keys = Object.keys(input);
    if (
        keys.length !== 2
        || !Object.hasOwn(input, "contract_version")
        || !Object.hasOwn(input, "video_urls")
        || input.contract_version !== CAPTURE_REQUEST_VERSION
        || !Array.isArray(input.video_urls)
        || input.video_urls.length < 1
        || input.video_urls.length > 3
    ) {
        return invalidRequest();
    }

    const urls: string[] = [];
    const seen = new Set<string>();
    for (const candidate of input.video_urls) {
        if (typeof candidate !== "string" || !isAllowedVideoUrl(candidate) || seen.has(candidate)) {
            return {
                ok: false,
                error: captureError("POPUP_CAPTURE_INVALID_URL", {
                    ...(typeof candidate === "string" && candidate.startsWith("https://") ?
                        { sourceUrl: candidate }
                    :   {})
                })
            };
        }
        seen.add(candidate);
        urls.push(candidate);
    }

    return { ok: true, value: { contract_version: CAPTURE_REQUEST_VERSION, video_urls: urls } };
}

function invalidRequest(): CaptureRequestValidation {
    return { ok: false, error: captureError("POPUP_CAPTURE_INVALID_REQUEST") };
}

function isAllowedVideoUrl(value: string): boolean {
    if (!value.startsWith("https://")) {
        return false;
    }
    try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname.length > 0 && url.username === "" && url.password === "";
    } catch {
        return false;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
