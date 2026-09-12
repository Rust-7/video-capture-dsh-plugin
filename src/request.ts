import { CAPTURE_REQUEST_VERSION, CAPTURE_REQUEST_V2_VERSION, type CaptureRequest } from "./contracts.js";
import { captureError } from "./errors.js";

export type CaptureRequestValidation =
    | { ok: true; value: CaptureRequest }
    | { ok: false; error: ReturnType<typeof captureError> };

export function validateCaptureRequest(input: unknown): CaptureRequestValidation {
    if (!isRecord(input)) {
        return invalidRequest();
    }

    const keys = Object.keys(input);
    const isV2 = input.contract_version === CAPTURE_REQUEST_V2_VERSION;
    const requiredKeys =
        isV2 ?
            ["contract_version", "video_urls", "account_name", "sequence_start"]
        :   ["contract_version", "video_urls"];
    if (
        keys.length !== requiredKeys.length
        || requiredKeys.some(key => !Object.hasOwn(input, key))
        || (!isV2 && input.contract_version !== CAPTURE_REQUEST_VERSION)
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

    if (isV2) {
        const { account_name, sequence_start } = input;
        if (
            typeof account_name !== "string"
            || account_name.trim().length === 0
            || typeof sequence_start !== "number"
            || !Number.isSafeInteger(sequence_start)
            || sequence_start < 1
            || sequence_start > Number.MAX_SAFE_INTEGER - 2
        ) {
            return invalidRequest();
        }
        return {
            ok: true,
            value: {
                contract_version: CAPTURE_REQUEST_V2_VERSION,
                video_urls: urls,
                account_name: account_name.trim(),
                sequence_start
            }
        };
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
