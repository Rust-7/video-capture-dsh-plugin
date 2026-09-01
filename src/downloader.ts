import type { Readable } from "node:stream";

import { DownloaderError } from "./errors.js";

export interface DownloadRequest {
    sourceUrl: string;
    signal: AbortSignal;
}

export interface DownloadedVideo {
    stream: Readable;
    mediaType: string;
    fileExtension?: string;
}

export interface VideoDownloader {
    download(request: DownloadRequest): Promise<DownloadedVideo>;
}

export class UnavailableVideoDownloader implements VideoDownloader {
    download(): Promise<DownloadedVideo> {
        return Promise.reject(new DownloaderError("POPUP_CAPTURE_DOWNLOADER_UNAVAILABLE"));
    }
}
