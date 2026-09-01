import { createReadStream } from "node:fs";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
    DouyinCookieCredential,
    type CookieCredentialLease,
    type DouyinCookieProvider,
    isDouyinUrl
} from "./douyin-cookie-credential.js";
import type { DownloadRequest, DownloadedVideo, VideoDownloader } from "./downloader.js";
import { DownloaderError, isAbortError } from "./errors.js";
import { runProcess, type ProcessRunner } from "./process-runner.js";

const DEFAULT_EXECUTABLE = "yt-dlp.exe";
const OUTPUT_TEMPLATE = "capture.%(ext)s";

const VIDEO_MEDIA_TYPES: Readonly<Record<string, string>> = {
    ".3gp": "video/3gpp",
    ".avi": "video/x-msvideo",
    ".flv": "video/x-flv",
    ".m4v": "video/x-m4v",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".mpeg": "video/mpeg",
    ".mpg": "video/mpeg",
    ".ts": "video/mp2t",
    ".webm": "video/webm"
};

export interface YtDlpVideoDownloaderOptions {
    executable?: string;
    processRunner?: ProcessRunner;
    douyinCookieCredential?: DouyinCookieProvider;
}

export class YtDlpVideoDownloader implements VideoDownloader {
    private readonly executable: string;
    private readonly processRunner: ProcessRunner;
    private readonly douyinCookieCredential: DouyinCookieProvider;

    constructor(options: YtDlpVideoDownloaderOptions = {}) {
        this.executable = options.executable ?? DEFAULT_EXECUTABLE;
        this.processRunner = options.processRunner ?? runProcess;
        this.douyinCookieCredential = options.douyinCookieCredential ?? new DouyinCookieCredential();
    }

    async download(request: DownloadRequest): Promise<DownloadedVideo> {
        const retryAfterRefresh = isDouyinUrl(request.sourceUrl) && this.douyinCookieCredential.supportsRefresh;
        try {
            return await this.downloadAttempt(request, false);
        } catch (error) {
            if (retryAfterRefresh && error instanceof YtDlpExitError) {
                return await this.mapDownloadError(request, () => this.downloadAttempt(request, true));
            }
            return await this.mapDownloadError(request, async () => {
                throw error;
            });
        }
    }

    private async mapDownloadError(
        request: DownloadRequest,
        operation: () => Promise<DownloadedVideo>
    ): Promise<DownloadedVideo> {
        try {
            return await operation();
        } catch (error) {
            if (request.signal.aborted || isAbortError(error)) {
                throw error;
            }
            if (isExecutableNotFound(error)) {
                throw new DownloaderError("POPUP_CAPTURE_DOWNLOADER_UNAVAILABLE", { cause: error });
            }
            if (error instanceof DownloaderError) {
                throw new DownloaderError(error.code, { cause: error.cause });
            }
            throw new DownloaderError("POPUP_CAPTURE_DOWNLOAD_FAILED", { cause: error });
        }
    }

    private async downloadAttempt(request: DownloadRequest, forceRefresh: boolean): Promise<DownloadedVideo> {
        let cookieLease: CookieCredentialLease | undefined;
        let temporaryDirectory: string | undefined;
        let streamOwnsDirectory = false;

        try {
            cookieLease = await this.douyinCookieCredential.prepare(request.sourceUrl, request.signal, {
                forceRefresh
            });
            temporaryDirectory = await mkdtemp(join(tmpdir(), "popup-capture-yt-dlp-"));
            const result = await this.processRunner({
                executable: this.executable,
                arguments: ytDlpArguments(
                    join(temporaryDirectory, OUTPUT_TEMPLATE),
                    request.sourceUrl,
                    cookieLease?.filePath
                ),
                cwd: temporaryDirectory,
                signal: request.signal
            });
            if (result.exitCode !== 0) {
                throw new YtDlpExitError();
            }

            const reportedPath = lastOutputLine(result.stdout);
            if (reportedPath === undefined) {
                throw new DownloaderError("POPUP_CAPTURE_DOWNLOAD_FAILED");
            }

            const videoPath = await validatedVideoPath(temporaryDirectory, reportedPath);
            const extension = extname(videoPath).toLowerCase();
            const mediaType = VIDEO_MEDIA_TYPES[extension];
            if (mediaType === undefined) {
                throw new DownloaderError("POPUP_CAPTURE_DOWNLOAD_FAILED");
            }

            const videoStats = await stat(videoPath);
            if (!videoStats.isFile() || videoStats.size === 0) {
                throw new DownloaderError("POPUP_CAPTURE_DOWNLOAD_FAILED");
            }

            const stream = createReadStream(videoPath, { signal: request.signal });
            const cleanup = cleanupOnce(temporaryDirectory);
            stream.once("close", () => void cleanup());
            streamOwnsDirectory = true;
            return { stream, mediaType, fileExtension: extension.slice(1) };
        } finally {
            await cookieLease?.dispose();
            if (!streamOwnsDirectory && temporaryDirectory !== undefined) {
                await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
            }
        }
    }
}

class YtDlpExitError extends DownloaderError {
    constructor() {
        super("POPUP_CAPTURE_DOWNLOAD_FAILED");
        this.name = "YtDlpExitError";
    }
}

function ytDlpArguments(outputTemplate: string, sourceUrl: string, cookieFile: string | undefined): string[] {
    return [
        "--ignore-config",
        "--no-plugin-dirs",
        "--no-playlist",
        "--no-overwrites",
        "--no-simulate",
        "--socket-timeout",
        "30",
        "--retries",
        "3",
        "--fragment-retries",
        "3",
        "--file-access-retries",
        "3",
        "--extractor-retries",
        "3",
        ...(cookieFile === undefined ? [] : ["--cookies", cookieFile]),
        "--output",
        outputTemplate,
        "--print",
        "after_move:filepath",
        "--",
        sourceUrl
    ];
}

function lastOutputLine(stdout: string): string | undefined {
    return stdout
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .at(-1);
}

async function validatedVideoPath(temporaryDirectory: string, reportedPath: string): Promise<string> {
    const candidate = isAbsolute(reportedPath) ? resolve(reportedPath) : resolve(temporaryDirectory, reportedPath);
    const [temporaryRealPath, candidateRealPath] = await Promise.all([
        realpath(temporaryDirectory),
        realpath(candidate)
    ]);
    const pathFromTemporaryDirectory = relative(temporaryRealPath, candidateRealPath);
    if (
        pathFromTemporaryDirectory === ".."
        || pathFromTemporaryDirectory.startsWith(`..${sep}`)
        || isAbsolute(pathFromTemporaryDirectory)
    ) {
        throw new DownloaderError("POPUP_CAPTURE_DOWNLOAD_FAILED");
    }
    return candidateRealPath;
}

function isExecutableNotFound(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function cleanupOnce(temporaryDirectory: string): () => Promise<void> {
    let cleanup: Promise<void> | undefined;
    return () => {
        cleanup ??= rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
        return cleanup;
    };
}
