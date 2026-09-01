import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

import {
    ARTIFACT_REF_VERSION,
    CAPTURED_VIDEO_SET_VERSION,
    type ArtifactRefV1,
    type CaptureErrorV1,
    type CaptureRequestV1,
    type CapturedVideoSetV1
} from "./contracts.js";
import type { DownloadedVideo, VideoDownloader } from "./downloader.js";
import { captureError, DownloaderError, isAbortError } from "./errors.js";

export interface CaptureExecution {
    request: CaptureRequestV1;
    runId: string;
    jobId: string;
    artifactRoot: string;
    downloader: VideoDownloader;
    signal: AbortSignal;
}

export async function captureVideos(execution: CaptureExecution): Promise<CapturedVideoSetV1> {
    const videos: CapturedVideoSetV1["videos"] = [];
    const failures: CaptureErrorV1[] = [];

    for (const [index, sourceUrl] of execution.request.video_urls.entries()) {
        if (execution.signal.aborted) {
            failures.push(captureError("POPUP_CAPTURE_CANCELLED", { sourceUrl }));
            continue;
        }

        try {
            const download = await execution.downloader.download({ sourceUrl, signal: execution.signal });
            const artifact = await materializeArtifact(download, sourceUrl, index, execution);
            videos.push({ source_url: sourceUrl, artifact });
        } catch (error) {
            failures.push(mapCaptureFailure(error, sourceUrl, execution.signal));
        }
    }

    const status =
        videos.length === 0 ? "failed"
        : failures.length === 0 ? "completed"
        : "partial";
    const aggregateError = aggregateCaptureError(status, failures, execution.signal.aborted);

    return {
        contract_version: CAPTURED_VIDEO_SET_VERSION,
        run_id: execution.runId,
        job_id: execution.jobId,
        status,
        videos,
        failures,
        ...(aggregateError === undefined ? {} : { error: aggregateError })
    };
}

async function materializeArtifact(
    download: DownloadedVideo,
    sourceUrl: string,
    index: number,
    execution: CaptureExecution
): Promise<ArtifactRefV1> {
    if (!download.mediaType.startsWith("video/")) {
        throw new DownloaderError("POPUP_CAPTURE_DOWNLOAD_FAILED");
    }

    const runDirectory = resolve(execution.artifactRoot, execution.runId);
    const extension = normalizeExtension(download.fileExtension, download.mediaType);
    const artifactPath = resolve(runDirectory, `video-${index + 1}.${extension}`);
    const hash = createHash("sha256");
    let byteSize = 0;

    const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            byteSize += bytes.byteLength;
            hash.update(bytes);
            callback(null, bytes);
        }
    });

    try {
        await mkdir(runDirectory, { recursive: true });
        await pipeline(download.stream, meter, createWriteStream(artifactPath, { flags: "wx" }), {
            signal: execution.signal
        });
        if (byteSize === 0) {
            await rm(artifactPath, { force: true });
            throw new DownloaderError("POPUP_CAPTURE_DOWNLOAD_FAILED");
        }
    } catch (error) {
        await rm(artifactPath, { force: true }).catch(() => undefined);
        if (error instanceof DownloaderError || isAbortError(error) || execution.signal.aborted) {
            throw error;
        }
        throw new ArtifactWriteError({ cause: error });
    }

    return {
        contract_version: ARTIFACT_REF_VERSION,
        artifact_id: `capture:${execution.runId}:${index + 1}`,
        kind: "video",
        uri: pathToFileURL(artifactPath).href,
        media_type: download.mediaType,
        byte_size: byteSize,
        sha256: hash.digest("hex"),
        metadata: { source_url: sourceUrl }
    };
}

function mapCaptureFailure(error: unknown, sourceUrl: string, signal: AbortSignal): CaptureErrorV1 {
    if (signal.aborted || isAbortError(error)) {
        return captureError("POPUP_CAPTURE_CANCELLED", { sourceUrl });
    }
    if (error instanceof DownloaderError) {
        return captureError(error.code, { sourceUrl });
    }
    if (error instanceof ArtifactWriteError) {
        return captureError("POPUP_CAPTURE_ARTIFACT_WRITE_FAILED", { sourceUrl });
    }
    return captureError("POPUP_CAPTURE_INTERNAL_ERROR", { sourceUrl });
}

function aggregateCaptureError(
    status: CapturedVideoSetV1["status"],
    failures: CaptureErrorV1[],
    cancelled: boolean
): CaptureErrorV1 | undefined {
    if (status === "completed") {
        return undefined;
    }
    const retryable = failures.some(failure => failure.retryable);
    if (cancelled) {
        return captureError("POPUP_CAPTURE_CANCELLED", { retryable });
    }
    return captureError(status === "partial" ? "POPUP_CAPTURE_PARTIAL_FAILURE" : "POPUP_CAPTURE_ALL_FAILED", {
        retryable
    });
}

function normalizeExtension(extension: string | undefined, mediaType: string): string {
    const requested = extension?.replace(/^\./, "").toLowerCase();
    if (requested !== undefined && /^[a-z0-9]{1,10}$/.test(requested)) {
        return requested;
    }
    if (mediaType === "video/mp4") return "mp4";
    if (mediaType === "video/webm") return "webm";
    if (mediaType === "video/quicktime") return "mov";
    return "bin";
}

class ArtifactWriteError extends Error {
    constructor(options?: ErrorOptions) {
        super("artifact write failed", options);
        this.name = "ArtifactWriteError";
    }
}
