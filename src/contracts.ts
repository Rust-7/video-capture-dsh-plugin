export const CAPTURE_REQUEST_VERSION = "popup.capture.request.v1" as const;
export const CAPTURE_SUBMISSION_VERSION = "popup.capture.submission.v1" as const;
export const CAPTURED_VIDEO_SET_VERSION = "popup.capture.video-set.v1" as const;
export const ARTIFACT_REF_VERSION = "popup.artifact-ref.v1" as const;

export const CAPTURE_ERROR_CODES = [
    "POPUP_CAPTURE_INVALID_REQUEST",
    "POPUP_CAPTURE_INVALID_URL",
    "POPUP_CAPTURE_DOWNLOADER_UNAVAILABLE",
    "POPUP_CAPTURE_NETWORK_ERROR",
    "POPUP_CAPTURE_DOWNLOAD_FAILED",
    "POPUP_CAPTURE_ARTIFACT_WRITE_FAILED",
    "POPUP_CAPTURE_CANCELLED",
    "POPUP_CAPTURE_PARTIAL_FAILURE",
    "POPUP_CAPTURE_ALL_FAILED",
    "POPUP_CAPTURE_INTERNAL_ERROR"
] as const;

export type CaptureErrorCode = (typeof CAPTURE_ERROR_CODES)[number];

export interface CaptureRequestV1 {
    contract_version: typeof CAPTURE_REQUEST_VERSION;
    video_urls: string[];
}

export interface CaptureErrorV1 {
    code: CaptureErrorCode;
    message: string;
    retryable: boolean;
    source_url?: string;
}

export interface ArtifactRefV1 {
    contract_version: typeof ARTIFACT_REF_VERSION;
    artifact_id: string;
    kind: "video";
    uri: string;
    media_type: string;
    byte_size: number;
    sha256?: string;
    metadata: { source_url: string };
}

export interface CapturedVideoV1 {
    source_url: string;
    artifact: ArtifactRefV1;
}

export interface CapturedVideoSetV1 {
    contract_version: typeof CAPTURED_VIDEO_SET_VERSION;
    run_id: string;
    job_id: string;
    status: "completed" | "partial" | "failed";
    videos: CapturedVideoV1[];
    failures: CaptureErrorV1[];
    error?: CaptureErrorV1;
}

export type CaptureSubmissionV1 =
    | { contract_version: typeof CAPTURE_SUBMISSION_VERSION; status: "queued"; run_id: string; job_id: string }
    | { contract_version: typeof CAPTURE_SUBMISSION_VERSION; status: "rejected"; error: CaptureErrorV1 };
