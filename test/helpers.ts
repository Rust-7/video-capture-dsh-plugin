import { Readable } from "node:stream";

import type { Context } from "@deepseek-ai/cordis";
import { JobId, type JobHooks, type JobStart } from "@deepseek-ai/dsh-jobs";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

import type { DownloadRequest, DownloadedVideo, VideoDownloader } from "../src/downloader.js";
import { DownloaderError, type DownloaderErrorCode } from "../src/errors.js";

export class CaptureHarness {
    readonly definitions = new Map<string, ToolDefinition>();
    readonly jobs: Array<{ spec: JobStart; hooks: JobHooks; id: ReturnType<typeof JobId> }> = [];
    readonly context: Context;

    constructor(startError?: Error) {
        this.context = {
            tools: {
                register: (definition: ToolDefinition) => {
                    if (this.definitions.has(definition.name)) {
                        throw new Error(`duplicate tool: ${definition.name}`);
                    }
                    this.definitions.set(definition.name, definition);
                    return () => this.definitions.delete(definition.name);
                }
            },
            jobs: {
                start: (spec: JobStart) => {
                    if (startError !== undefined) {
                        throw startError;
                    }
                    const id = JobId(`popup-capture-${this.jobs.length + 1}`);
                    const hooks = spec.run();
                    this.jobs.push({ spec, hooks, id });
                    return id;
                }
            }
        } as unknown as Context;
    }

    execute(args: unknown, signal: AbortSignal = new AbortController().signal): Promise<unknown> {
        const definition = this.definitions.get("popup_capture");
        if (definition === undefined) {
            throw new Error("popup_capture is not registered");
        }
        return definition.execute(args, { signal } as never);
    }

    get lastJob(): { spec: JobStart; hooks: JobHooks; id: ReturnType<typeof JobId> } {
        const job = this.jobs.at(-1);
        if (job === undefined) {
            throw new Error("no job was started");
        }
        return job;
    }
}

export type DownloadOutcome =
    | { bytes: Uint8Array; mediaType?: string; fileExtension?: string }
    | { error: DownloaderErrorCode };

export class FixtureDownloader implements VideoDownloader {
    readonly calls: string[] = [];

    constructor(private readonly outcomes: ReadonlyMap<string, DownloadOutcome>) {}

    download(request: DownloadRequest): Promise<DownloadedVideo> {
        this.calls.push(request.sourceUrl);
        if (request.signal.aborted) {
            return Promise.reject(abortError());
        }
        const outcome = this.outcomes.get(request.sourceUrl);
        if (outcome === undefined) {
            return Promise.reject(new DownloaderError("POPUP_CAPTURE_DOWNLOAD_FAILED"));
        }
        if ("error" in outcome) {
            return Promise.reject(new DownloaderError(outcome.error));
        }
        return Promise.resolve({
            stream: Readable.from([Buffer.from(outcome.bytes)]),
            mediaType: outcome.mediaType ?? "video/mp4",
            ...(outcome.fileExtension === undefined ? {} : { fileExtension: outcome.fileExtension })
        });
    }
}

export class BlockingDownloader implements VideoDownloader {
    download(request: DownloadRequest): Promise<DownloadedVideo> {
        return new Promise((_resolve, reject) => {
            if (request.signal.aborted) {
                reject(abortError());
                return;
            }
            request.signal.addEventListener("abort", () => reject(abortError()), { once: true });
        });
    }
}

export function abortError(): Error {
    const error = new Error("aborted");
    error.name = "AbortError";
    return error;
}
