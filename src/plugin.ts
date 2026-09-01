import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type { JobHooks, JobOutcome } from "@deepseek-ai/dsh-jobs";
import { defineTool, type JsonValue } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

import { captureVideos } from "./capture.js";
import {
    CAPTURE_REQUEST_VERSION,
    CAPTURE_SUBMISSION_VERSION,
    type CaptureRequestV1,
    type CapturedVideoSetV1,
    type CaptureSubmissionV1
} from "./contracts.js";
import { DouyinCookieCredential } from "./douyin-cookie-credential.js";
import { ManagedDouyinCookieCredential } from "./douyin-cookie-refresher.js";
import type { VideoDownloader } from "./downloader.js";
import { captureError } from "./errors.js";
import { validateCaptureRequest } from "./request.js";
import { YtDlpVideoDownloader } from "./yt-dlp-downloader.js";

declare module "@deepseek-ai/dsh-jobs" {
    interface JobKindMap {
        "popup-capture": "popup-capture";
    }
}

export const name = "dsh-popup-capture";
export const inject = ["tools", "jobs"];

export interface Config {
    artifactRoot?: string;
    ytDlpExecutable?: string;
    douyinCookieFile?: string;
    douyinCookieMaxAgeSeconds?: number;
    douyinCredentialMode?: "file" | "managed-edge";
    douyinManagedRoot?: string;
    douyinManagedRefreshSeconds?: number;
    douyinManagedBrowserTimeoutMs?: number;
}

export const Config: z<Config> = z.object({
    artifactRoot: z.string().default(".popup-artifacts/capture"),
    ytDlpExecutable: z.string().default("yt-dlp.exe"),
    douyinCookieFile: z.string(),
    douyinCookieMaxAgeSeconds: z.number().step(1).min(1).default(1800),
    douyinCredentialMode: z.union(["file", "managed-edge"]).default("file"),
    douyinManagedRoot: z.string(),
    douyinManagedRefreshSeconds: z.number().step(1).min(1).max(1800).default(1200),
    douyinManagedBrowserTimeoutMs: z.number().step(1).min(1).max(120000).default(45000)
});

export function apply(ctx: Context, config: Config = {}): void {
    const artifactRoot = resolve(config.artifactRoot ?? ".popup-artifacts/capture");
    const forbiddenRoots = [process.cwd(), artifactRoot, tmpdir()];
    const douyinCookieCredential =
        config.douyinCredentialMode === "managed-edge" ?
            new ManagedDouyinCookieCredential({
                managedRoot: config.douyinManagedRoot,
                refreshSeconds: config.douyinManagedRefreshSeconds ?? 1200,
                browserTimeoutMs: config.douyinManagedBrowserTimeoutMs ?? 45000,
                forbiddenRoots
            })
        :   new DouyinCookieCredential({
                sourceFile: config.douyinCookieFile,
                maxAgeSeconds: config.douyinCookieMaxAgeSeconds ?? 1800,
                forbiddenRoots
            });
    registerCapture(
        ctx,
        config,
        new YtDlpVideoDownloader({ executable: config.ytDlpExecutable ?? "yt-dlp.exe", douyinCookieCredential })
    );
}

export function registerCapture(ctx: Context, config: Config, downloader: VideoDownloader): () => void {
    const artifactRoot = resolve(config.artifactRoot ?? ".popup-artifacts/capture");

    return ctx.tools.register(
        defineTool({
            name: "popup_capture",
            description:
                "Queue asynchronous capture of 1 to 3 HTTPS video URLs. Returns a run id and DSH job id immediately; read the final CapturedVideoSet v1 JSON with job_output.",
            parameters: {
                contract_version: {
                    type: "string",
                    const: CAPTURE_REQUEST_VERSION,
                    required: true,
                    description: "Must be popup.capture.request.v1."
                },
                video_urls: {
                    type: "array",
                    items: { type: "string" },
                    required: true,
                    description: "An array containing 1 to 3 unique HTTPS video URLs without credentials."
                }
            },
            output: {
                schema: { type: "json" },
                render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }]
            },
            async execute(args, exec): Promise<JsonValue> {
                const validation = validateCaptureRequest(args);
                if (!validation.ok) {
                    return asJsonValue(rejected(validation.error));
                }
                if (exec.signal.aborted) {
                    return asJsonValue(rejected(captureError("POPUP_CAPTURE_CANCELLED")));
                }

                const runId = `capture-run-${randomUUID()}`;
                const controller = new AbortController();
                const relayAbort = () => controller.abort(exec.signal.reason);
                exec.signal.addEventListener("abort", relayAbort, { once: true });

                let resolveJobId!: (jobId: string) => void;
                let rejectJobId!: (error: unknown) => void;
                let runStarted = false;
                const jobIdReady = new Promise<string>((resolveId, rejectId) => {
                    resolveJobId = resolveId;
                    rejectJobId = rejectId;
                });

                try {
                    const jobId = ctx.jobs.start({
                        kind: "popup-capture",
                        label: `capture ${validation.value.video_urls.length} video(s)`,
                        owner: exec.agent,
                        run: () => {
                            runStarted = true;
                            return createJobHooks({
                                request: validation.value,
                                runId,
                                artifactRoot,
                                downloader,
                                controller,
                                jobIdReady,
                                onSettled: () => exec.signal.removeEventListener("abort", relayAbort)
                            });
                        }
                    });
                    resolveJobId(String(jobId));
                    return asJsonValue({
                        contract_version: CAPTURE_SUBMISSION_VERSION,
                        status: "queued",
                        run_id: runId,
                        job_id: String(jobId)
                    } satisfies CaptureSubmissionV1);
                } catch (error) {
                    controller.abort(error);
                    if (runStarted) {
                        rejectJobId(error);
                    }
                    exec.signal.removeEventListener("abort", relayAbort);
                    return asJsonValue(rejected(captureError("POPUP_CAPTURE_INTERNAL_ERROR")));
                }
            }
        })
    );
}

interface JobHookOptions {
    request: CaptureRequestV1;
    runId: string;
    artifactRoot: string;
    downloader: VideoDownloader;
    controller: AbortController;
    jobIdReady: Promise<string>;
    onSettled(): void;
}

function createJobHooks(options: JobHookOptions): JobHooks {
    const done = settleCaptureJob(options).finally(options.onSettled);
    return { cancel: (reason?: string) => options.controller.abort(reason), done };
}

async function settleCaptureJob(options: JobHookOptions): Promise<JobOutcome> {
    try {
        const jobId = await options.jobIdReady;
        const result = await captureVideos({
            request: options.request,
            runId: options.runId,
            jobId,
            artifactRoot: options.artifactRoot,
            downloader: options.downloader,
            signal: options.controller.signal
        });
        return jobOutcome(result, options.controller.signal.aborted);
    } catch {
        return { status: options.controller.signal.aborted ? "killed" : "failed", detail: "internal error" };
    }
}

function jobOutcome(result: CapturedVideoSetV1, cancelled: boolean): JobOutcome {
    if (cancelled) {
        return { status: "killed", detail: "cancelled", output: JSON.stringify(result) };
    }
    if (result.status === "failed") {
        return { status: "failed", detail: "all captures failed", output: JSON.stringify(result) };
    }
    return {
        status: "completed",
        detail: result.status === "partial" ? "partial capture" : `${result.videos.length} captured`,
        output: JSON.stringify(result)
    };
}

function rejected(error: ReturnType<typeof captureError>): CaptureSubmissionV1 {
    return { contract_version: CAPTURE_SUBMISSION_VERSION, status: "rejected", error };
}

function asJsonValue(value: CaptureSubmissionV1): JsonValue {
    return value as unknown as JsonValue;
}
