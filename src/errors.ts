import type { CaptureErrorCode, CaptureErrorV1 } from "./contracts.js";

const ERROR_MESSAGES: Record<CaptureErrorCode, string> = {
    POPUP_CAPTURE_INVALID_REQUEST: "Capture request is invalid.",
    POPUP_CAPTURE_INVALID_URL: "Video URL must be a unique HTTPS URL without credentials.",
    POPUP_CAPTURE_DOWNLOADER_UNAVAILABLE: "No callable video downloader is configured.",
    POPUP_CAPTURE_NETWORK_ERROR: "The video download failed because of a network error.",
    POPUP_CAPTURE_DOWNLOAD_FAILED: "The video downloader could not capture the requested video.",
    POPUP_CAPTURE_ARTIFACT_WRITE_FAILED: "The captured video could not be written as an artifact.",
    POPUP_CAPTURE_CANCELLED: "The capture job was cancelled.",
    POPUP_CAPTURE_PARTIAL_FAILURE: "Some videos could not be captured.",
    POPUP_CAPTURE_ALL_FAILED: "No videos could be captured.",
    POPUP_CAPTURE_INTERNAL_ERROR: "The capture job failed unexpectedly."
};

const DEFAULT_RETRYABLE: Record<CaptureErrorCode, boolean> = {
    POPUP_CAPTURE_INVALID_REQUEST: false,
    POPUP_CAPTURE_INVALID_URL: false,
    POPUP_CAPTURE_DOWNLOADER_UNAVAILABLE: false,
    POPUP_CAPTURE_NETWORK_ERROR: true,
    POPUP_CAPTURE_DOWNLOAD_FAILED: false,
    POPUP_CAPTURE_ARTIFACT_WRITE_FAILED: false,
    POPUP_CAPTURE_CANCELLED: true,
    POPUP_CAPTURE_PARTIAL_FAILURE: false,
    POPUP_CAPTURE_ALL_FAILED: false,
    POPUP_CAPTURE_INTERNAL_ERROR: false
};

export function captureError(
    code: CaptureErrorCode,
    options: { sourceUrl?: string; retryable?: boolean } = {}
): CaptureErrorV1 {
    return {
        code,
        message: ERROR_MESSAGES[code],
        retryable: options.retryable ?? DEFAULT_RETRYABLE[code],
        ...(options.sourceUrl === undefined ? {} : { source_url: options.sourceUrl })
    };
}

export type DownloaderErrorCode =
    | "POPUP_CAPTURE_DOWNLOADER_UNAVAILABLE"
    | "POPUP_CAPTURE_NETWORK_ERROR"
    | "POPUP_CAPTURE_DOWNLOAD_FAILED";

export class DownloaderError extends Error {
    constructor(
        readonly code: DownloaderErrorCode,
        options?: ErrorOptions
    ) {
        super(ERROR_MESSAGES[code], options);
        this.name = "DownloaderError";
    }
}

export function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}
