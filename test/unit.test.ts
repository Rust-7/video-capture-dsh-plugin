import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";

import { CAPTURE_REQUEST_VERSION, type CapturedVideoSetV1 } from "../src/contracts.js";
import {
    PlaywrightDouyinBrowserSession,
    type BrowserCookieRecord,
    type DouyinBrowserSession,
    type ManagedBrowserLauncher
} from "../src/douyin-browser-session.js";
import {
    DouyinCookieCredential,
    type CookieCredentialPrepareOptions,
    type DouyinCookieProvider
} from "../src/douyin-cookie-credential.js";
import { ManagedDouyinCookieCredential } from "../src/douyin-cookie-refresher.js";
import { DownloaderError } from "../src/errors.js";
import { apply, registerCapture } from "../src/plugin.js";
import type { ProcessRunRequest, ProcessRunner } from "../src/process-runner.js";
import { validateCaptureRequest } from "../src/request.js";
import { YtDlpVideoDownloader } from "../src/yt-dlp-downloader.js";
import { BlockingDownloader, CaptureHarness, FixtureDownloader } from "./helpers.js";

const ONE = "https://videos.example.test/one.mp4";
const TWO = "https://videos.example.test/two.mp4";
const THREE = "https://videos.example.test/three.mp4";
const DOUYIN = "https://v.douyin.com/test-share-link/";

test("request validation rejects malformed, unsafe, duplicate, and oversized input", () => {
    const invalidInputs = [
        null,
        {},
        { contract_version: "wrong", video_urls: [ONE] },
        { contract_version: CAPTURE_REQUEST_VERSION, video_urls: [] },
        { contract_version: CAPTURE_REQUEST_VERSION, video_urls: [ONE, TWO, THREE, "https://example.test/4"] },
        { contract_version: CAPTURE_REQUEST_VERSION, video_urls: ["http://videos.example.test/one.mp4"] },
        { contract_version: CAPTURE_REQUEST_VERSION, video_urls: ["https://user:pass@example.test/one.mp4"] },
        { contract_version: CAPTURE_REQUEST_VERSION, video_urls: [ONE, ONE] },
        { contract_version: CAPTURE_REQUEST_VERSION, video_urls: [ONE], extra: true }
    ];

    for (const input of invalidInputs) {
        assert.equal(validateCaptureRequest(input).ok, false);
    }
});

test("popup_capture publishes required typed CaptureRequest fields", async () => {
    const harness = new CaptureHarness();
    apply(harness.context, {});

    const definition = harness.definitions.get("popup_capture");
    assert.notEqual(definition, undefined);
    const parameters = asRecord(definition?.parameters);
    assert.deepEqual(parameters.required, ["contract_version", "video_urls"]);

    const properties = asRecord(parameters.properties);
    assert.deepEqual(asRecord(properties.contract_version), {
        type: "string",
        const: CAPTURE_REQUEST_VERSION,
        description: "Must be popup.capture.request.v1."
    });
    assert.deepEqual(asRecord(properties.video_urls), {
        type: "array",
        items: { type: "string" },
        description: "An array containing 1 to 3 unique HTTPS video URLs without credentials."
    });

    for (const invalidRequest of [{ video_urls: [ONE] }, { contract_version: "wrong", video_urls: [ONE] }]) {
        await assert.rejects(harness.execute(invalidRequest), (error: unknown) => {
            assert.equal(asRecord(error).code, "INVALID_ARGS");
            return true;
        });
    }
    assert.equal(harness.jobs.length, 0);
});

test("invalid Tool input returns a stable rejection and starts no Job", async () => {
    const harness = new CaptureHarness();
    apply(harness.context, {});

    const result = await harness.execute({
        contract_version: CAPTURE_REQUEST_VERSION,
        video_urls: ["http://videos.example.test/one.mp4"]
    });

    assert.deepEqual(result, {
        contract_version: "popup.capture.submission.v1",
        status: "rejected",
        error: {
            code: "POPUP_CAPTURE_INVALID_URL",
            message: "Video URL must be a unique HTTPS URL without credentials.",
            retryable: false
        }
    });
    assert.equal(harness.jobs.length, 0);
});

test("DSH Job preflight rejection returns a stable Tool error without starting work", async () => {
    const harness = new CaptureHarness(new Error("no attached controller"));
    apply(harness.context, {});

    const result = asRecord(await harness.execute(validRequest([ONE])));
    assert.equal(result.status, "rejected");
    assert.equal(asRecord(result.error).code, "POPUP_CAPTURE_INTERNAL_ERROR");
    assert.equal(harness.jobs.length, 0);
});

test("production plugin fails predictably when the yt-dlp executable is missing", async () => {
    await withArtifactRoot(async artifactRoot => {
        const harness = new CaptureHarness();
        apply(harness.context, { artifactRoot, ytDlpExecutable: join(artifactRoot, "missing-yt-dlp.exe") });

        const submission = await harness.execute(validRequest([ONE]));
        assert.equal(asRecord(submission).status, "queued");

        const outcome = await harness.lastJob.hooks.done;
        assert.equal(outcome.status, "failed");
        const result = parseVideoSet(outcome.output);
        assert.equal(result.status, "failed");
        assert.equal(result.failures[0]?.code, "POPUP_CAPTURE_DOWNLOADER_UNAVAILABLE");
        assert.equal(result.error?.code, "POPUP_CAPTURE_ALL_FAILED");
    });
});

test("production Tool and Job fail closed when Douyin credentials are not configured", async () => {
    await withArtifactRoot(async artifactRoot => {
        const harness = new CaptureHarness();
        apply(harness.context, { artifactRoot, ytDlpExecutable: "must-not-run.exe" });

        const submission = await harness.execute(validRequest([DOUYIN]));
        assert.equal(asRecord(submission).status, "queued");

        const outcome = await harness.lastJob.hooks.done;
        assert.equal(outcome.status, "failed");
        const result = parseVideoSet(outcome.output);
        assert.equal(result.status, "failed");
        assert.equal(result.failures[0]?.code, "POPUP_CAPTURE_DOWNLOADER_UNAVAILABLE");
        assert.equal(result.failures[0]?.source_url, DOUYIN);
        assert.equal(result.error?.code, "POPUP_CAPTURE_ALL_FAILED");
    });
});

test("managed Edge mode fails closed when its protected root is not configured", async () => {
    await withArtifactRoot(async artifactRoot => {
        const harness = new CaptureHarness();
        apply(harness.context, {
            artifactRoot,
            ytDlpExecutable: "must-not-run.exe",
            douyinCredentialMode: "managed-edge"
        });

        const submission = await harness.execute(validRequest([DOUYIN]));
        assert.equal(asRecord(submission).status, "queued");
        const result = parseVideoSet((await harness.lastJob.hooks.done).output);
        assert.equal(result.failures[0]?.code, "POPUP_CAPTURE_DOWNLOADER_UNAVAILABLE");
    });
});

test("yt-dlp adapter uses fixed safe arguments and cleans its private directory", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    let processRequest: ProcessRunRequest | undefined;
    const downloader = new YtDlpVideoDownloader({
        executable: "approved-yt-dlp.exe",
        processRunner: async request => {
            processRequest = request;
            const outputTemplate = requiredArgumentValue(request.arguments, "--output");
            const outputPath = outputTemplate.replace("%(ext)s", "mp4");
            await writeFile(outputPath, bytes);
            return { exitCode: 0, stdout: `${outputPath}\n` };
        }
    });

    const download = await downloader.download({ sourceUrl: ONE, signal: new AbortController().signal });
    const closed = once(download.stream, "close");
    const capturedBytes = await readStream(download.stream);
    await closed;

    assert.deepEqual(capturedBytes, bytes);
    assert.equal(download.mediaType, "video/mp4");
    assert.equal(download.fileExtension, "mp4");
    assert.ok(processRequest);
    assert.equal(processRequest.executable, "approved-yt-dlp.exe");
    assert.deepEqual(processRequest.arguments.slice(-2), ["--", ONE]);
    assert.ok(processRequest.arguments.includes("--ignore-config"));
    assert.ok(processRequest.arguments.includes("--no-plugin-dirs"));
    assert.ok(processRequest.arguments.includes("--no-playlist"));
    assert.ok(processRequest.arguments.includes("--no-overwrites"));
    assert.ok(processRequest.arguments.includes("--no-simulate"));
    assert.equal(requiredArgumentValue(processRequest.arguments, "--socket-timeout"), "30");
    assert.equal(requiredArgumentValue(processRequest.arguments, "--retries"), "3");
    assert.equal(requiredArgumentValue(processRequest.arguments, "--fragment-retries"), "3");
    assert.equal(requiredArgumentValue(processRequest.arguments, "--file-access-retries"), "3");
    assert.equal(requiredArgumentValue(processRequest.arguments, "--extractor-retries"), "3");
    assert.equal(requiredArgumentValue(processRequest.arguments, "--print"), "after_move:filepath");
    for (const forbiddenArgument of [
        "--config-locations",
        "--cookies",
        "--cookies-from-browser",
        "--downloader",
        "--exec",
        "--plugin-dirs"
    ]) {
        assert.equal(processRequest.arguments.includes(forbiddenArgument), false);
    }
    await assertEventuallyMissing(processRequest.cwd);
});

test("Douyin credentials create isolated per-job copies without modifying the source", async () => {
    await withArtifactRoot(async vaultRoot => {
        const now = Date.now();
        const sourceFile = join(vaultRoot, "douyin-source.txt");
        const sourceContents = validCookieFile(now);
        await writeFreshFile(sourceFile, sourceContents, now);
        const credential = new DouyinCookieCredential({ sourceFile, forbiddenRoots: [], now: () => now });

        const first = await credential.prepare(DOUYIN, new AbortController().signal);
        const second = await credential.prepare(DOUYIN, new AbortController().signal);
        assert.ok(first);
        assert.ok(second);
        assert.notEqual(first.filePath, second.filePath);
        assert.notEqual(first.filePath, sourceFile);
        assert.equal(await readFile(first.filePath, "utf8"), sourceContents);

        await first.dispose();
        await assertEventuallyMissing(first.filePath);
        assert.equal(await readFile(second.filePath, "utf8"), sourceContents);
        await second.dispose();
        await assertEventuallyMissing(second.filePath);
        assert.equal(await readFile(sourceFile, "utf8"), sourceContents);
    });
});

test("Douyin credential accepts sub-millisecond mtime precision but rejects a future millisecond", async () => {
    await withArtifactRoot(async vaultRoot => {
        const sourceFile = join(vaultRoot, "douyin-source.txt");
        const preciseModifiedAt = Date.now() + 0.75;
        await writeFile(sourceFile, validCookieFile(preciseModifiedAt), "utf8");
        await utimes(sourceFile, preciseModifiedAt / 1000, preciseModifiedAt / 1000);

        const observedModifiedAt = (await stat(sourceFile)).mtimeMs;
        const now = Math.floor(observedModifiedAt);
        assert.ok(observedModifiedAt > now, "test filesystem must preserve sub-millisecond mtime precision");

        const credential = new DouyinCookieCredential({ sourceFile, forbiddenRoots: [], now: () => now });
        const lease = await credential.prepare(DOUYIN, new AbortController().signal);
        assert.ok(lease);
        await lease.dispose();

        const futureCredential = new DouyinCookieCredential({ sourceFile, forbiddenRoots: [], now: () => now - 1 });
        await assert.rejects(
            futureCredential.prepare(DOUYIN, new AbortController().signal),
            error => error instanceof DownloaderError && error.code === "POPUP_CAPTURE_DOWNLOAD_FAILED"
        );
    });
});

test("Douyin credential skips nameless browser records and still requires a usable record", async () => {
    await withArtifactRoot(async vaultRoot => {
        const now = Date.now();
        const expiry = Math.floor(now / 1000) + 3600;
        const validRecord = `.douyin.com\tTRUE\t/\tTRUE\t${expiry}\ttest_cookie\tTEST_ONLY_NOT_A_SECRET`;
        const namelessRecord = `.douyin.com\tTRUE\t/\tTRUE\t${expiry}\t\tTEST_ONLY_NOT_A_SECRET`;

        const mixedSource = join(vaultRoot, "mixed-cookies.txt");
        await writeFreshFile(mixedSource, cookieFileWithRecords([namelessRecord, validRecord]), now);
        const mixedCredential = new DouyinCookieCredential({
            sourceFile: mixedSource,
            forbiddenRoots: [],
            now: () => now
        });
        const lease = await mixedCredential.prepare(DOUYIN, new AbortController().signal);
        assert.ok(lease);
        assert.equal(await readFile(lease.filePath, "utf8"), cookieFileWithRecords([validRecord]));
        await lease.dispose();

        const namelessOnlySource = join(vaultRoot, "nameless-only-cookies.txt");
        await writeFreshFile(namelessOnlySource, cookieFileWithRecords([namelessRecord]), now);
        const namelessOnlyCredential = new DouyinCookieCredential({
            sourceFile: namelessOnlySource,
            forbiddenRoots: [],
            now: () => now
        });
        await assert.rejects(
            namelessOnlyCredential.prepare(DOUYIN, new AbortController().signal),
            error => error instanceof DownloaderError && error.code === "POPUP_CAPTURE_DOWNLOAD_FAILED"
        );
    });
});

test("Douyin credential rejects missing and unsafe source paths as unavailable", async () => {
    const relativeCredential = new DouyinCookieCredential({ sourceFile: "relative-cookies.txt" });
    await assert.rejects(
        relativeCredential.prepare(DOUYIN, new AbortController().signal),
        error => error instanceof DownloaderError && error.code === "POPUP_CAPTURE_DOWNLOADER_UNAVAILABLE"
    );

    await withArtifactRoot(async vaultRoot => {
        const missingCredential = new DouyinCookieCredential({
            sourceFile: join(vaultRoot, "missing.txt"),
            forbiddenRoots: []
        });
        await assert.rejects(
            missingCredential.prepare(DOUYIN, new AbortController().signal),
            error => error instanceof DownloaderError && error.code === "POPUP_CAPTURE_DOWNLOADER_UNAVAILABLE"
        );

        const now = Date.now();
        const sourceFile = join(vaultRoot, "cookies.txt");
        await writeFreshFile(sourceFile, validCookieFile(now), now);
        const unsafeCredential = new DouyinCookieCredential({
            sourceFile,
            forbiddenRoots: [vaultRoot],
            now: () => now
        });
        await assert.rejects(
            unsafeCredential.prepare(DOUYIN, new AbortController().signal),
            error => error instanceof DownloaderError && error.code === "POPUP_CAPTURE_DOWNLOADER_UNAVAILABLE"
        );
    });
});

test("configured Douyin credentials are never read or passed to non-Douyin downloads", async () => {
    await withArtifactRoot(async vaultRoot => {
        const missingSource = join(vaultRoot, "must-not-be-read.txt");
        let processRequest: ProcessRunRequest | undefined;
        const downloader = new YtDlpVideoDownloader({
            douyinCookieCredential: new DouyinCookieCredential({ sourceFile: missingSource, forbiddenRoots: [] }),
            processRunner: async request => {
                processRequest = request;
                const outputPath = requiredArgumentValue(request.arguments, "--output").replace("%(ext)s", "mp4");
                await writeFile(outputPath, Uint8Array.from([1]));
                return { exitCode: 0, stdout: outputPath };
            }
        });

        const download = await downloader.download({ sourceUrl: ONE, signal: new AbortController().signal });
        await readStream(download.stream);
        assert.ok(processRequest);
        assert.equal(processRequest.arguments.includes("--cookies"), false);
        await assert.rejects(access(missingSource), error => (error as NodeJS.ErrnoException).code === "ENOENT");
    });
});

test("Douyin credential rejects stale, expired, malformed, and cross-domain files", async () => {
    await withArtifactRoot(async vaultRoot => {
        const now = Date.now();
        const cases = [
            { name: "stale", contents: validCookieFile(now), modifiedAt: now - 1801 * 1000 },
            { name: "expired", contents: validCookieFile(now, ".douyin.com", Math.floor(now / 1000) - 1) },
            { name: "malformed", contents: "not a Netscape Cookie file\n" },
            { name: "cross-domain", contents: validCookieFile(now, ".example.com") }
        ];

        for (const invalidCase of cases) {
            const sourceFile = join(vaultRoot, `${invalidCase.name}.txt`);
            await writeFreshFile(sourceFile, invalidCase.contents, invalidCase.modifiedAt ?? now);
            const credential = new DouyinCookieCredential({ sourceFile, forbiddenRoots: [], now: () => now });
            await assert.rejects(
                credential.prepare(DOUYIN, new AbortController().signal),
                error => error instanceof DownloaderError && error.code === "POPUP_CAPTURE_DOWNLOAD_FAILED",
                invalidCase.name
            );
        }
    });
});

test("managed Edge credentials refresh once and reuse the protected cache", async () => {
    await withArtifactRoot(async temporaryRoot => {
        const now = Date.now();
        const browser = new FakeDouyinBrowserSession(validBrowserCookies(now));
        const credential = new ManagedDouyinCookieCredential({
            managedRoot: join(temporaryRoot, "managed"),
            forbiddenRoots: [],
            browserSession: browser
        });

        const first = await credential.prepare(DOUYIN, new AbortController().signal);
        assert.ok(first);
        assert.match(await readFile(first.filePath, "utf8"), /\.douyin\.com/u);
        await first.dispose();

        const second = await credential.prepare(DOUYIN, new AbortController().signal);
        assert.ok(second);
        await second.dispose();
        assert.equal(browser.calls, 1);

        const refreshed = await credential.prepare(DOUYIN, new AbortController().signal, { forceRefresh: true });
        assert.ok(refreshed);
        await refreshed.dispose();
        assert.equal(browser.calls, 2);
    });
});

test("managed Edge waits for normal page load and bounded Cookie settlement before collection", async () => {
    const events: string[] = [];
    const page = {
        async goto(_url: string, options: { timeout: number; waitUntil: "load" }): Promise<void> {
            events.push(`goto:${options.waitUntil}:${options.timeout}`);
        },
        url: () => "https://www.douyin.com/video/test",
        async waitForTimeout(milliseconds: number): Promise<void> {
            events.push(`wait:${milliseconds}`);
        }
    };
    const launch: ManagedBrowserLauncher = async (_profileDirectory, timeoutMs) => {
        events.push(`launch:${timeoutMs}`);
        return {
            pages: () => [page],
            async newPage() {
                throw new Error("unexpected new page");
            },
            async cookies(urls) {
                events.push(`cookies:${urls.length}`);
                return validBrowserCookies(Date.now());
            },
            async close() {
                events.push("close");
            }
        };
    };
    const session = new PlaywrightDouyinBrowserSession(launch);

    const cookies = await session.collectCookies({
        sourceUrl: DOUYIN,
        profileDirectory: "D:\\protected-test-profile",
        timeoutMs: 45_000,
        signal: new AbortController().signal
    });

    assert.equal(cookies.length, 1);
    assert.deepEqual(events, ["launch:45000", "goto:load:45000", "wait:8000", "cookies:2", "close"]);
});

test("managed Edge refresh is single-flight across concurrent Jobs", async () => {
    await withArtifactRoot(async temporaryRoot => {
        const now = Date.now();
        let releaseRefresh!: () => void;
        const refreshAllowed = new Promise<void>(resolve => {
            releaseRefresh = resolve;
        });
        const browser = new FakeDouyinBrowserSession(validBrowserCookies(now), refreshAllowed);
        const credential = new ManagedDouyinCookieCredential({
            managedRoot: join(temporaryRoot, "managed"),
            forbiddenRoots: [],
            browserSession: browser
        });

        const first = credential.prepare(DOUYIN, new AbortController().signal);
        const second = credential.prepare("https://www.douyin.com/video/test", new AbortController().signal);
        await assertEventually(() => browser.calls === 1);
        releaseRefresh();

        const leases = await Promise.all([first, second]);
        assert.equal(browser.calls, 1);
        await Promise.all(leases.map(lease => lease?.dispose()));
    });
});

test("managed Edge rejects unsafe roots and browser cookies outside Douyin", async () => {
    const relativeCredential = new ManagedDouyinCookieCredential({
        managedRoot: "relative-managed-root",
        forbiddenRoots: [],
        browserSession: new FakeDouyinBrowserSession([])
    });
    await assert.rejects(
        relativeCredential.prepare(DOUYIN, new AbortController().signal),
        error => error instanceof DownloaderError && error.code === "POPUP_CAPTURE_DOWNLOADER_UNAVAILABLE"
    );

    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData !== undefined) {
        const personalProfileCredential = new ManagedDouyinCookieCredential({
            managedRoot: join(localAppData, "Microsoft", "Edge", "User Data", "popup-capture-must-not-use"),
            forbiddenRoots: [],
            browserSession: new FakeDouyinBrowserSession([])
        });
        await assert.rejects(
            personalProfileCredential.prepare(DOUYIN, new AbortController().signal),
            error => error instanceof DownloaderError && error.code === "POPUP_CAPTURE_DOWNLOADER_UNAVAILABLE"
        );
    }

    await withArtifactRoot(async temporaryRoot => {
        const now = Date.now();
        const credential = new ManagedDouyinCookieCredential({
            managedRoot: join(temporaryRoot, "managed"),
            forbiddenRoots: [],
            browserSession: new FakeDouyinBrowserSession([
                {
                    domain: ".example.com",
                    path: "/",
                    expires: Math.floor(now / 1000) + 3600,
                    httpOnly: true,
                    secure: true,
                    name: "not_douyin",
                    value: "TEST_ONLY_NOT_A_SECRET"
                }
            ]),
            now: () => now
        });
        await assert.rejects(
            credential.prepare(DOUYIN, new AbortController().signal),
            error => error instanceof DownloaderError && error.code === "POPUP_CAPTURE_DOWNLOAD_FAILED"
        );
    });
});

test("managed Edge configuration enforces approved refresh and timeout maxima", () => {
    assert.throws(() => new ManagedDouyinCookieCredential({ refreshSeconds: 1801 }), /douyinManagedRefreshSeconds/u);
    assert.throws(
        () => new ManagedDouyinCookieCredential({ browserTimeoutMs: 120001 }),
        /douyinManagedBrowserTimeoutMs/u
    );
});

test("managed Edge never starts a browser for a non-Douyin URL", async () => {
    const browser = new FakeDouyinBrowserSession([]);
    const credential = new ManagedDouyinCookieCredential({
        managedRoot: "relative-path-that-must-not-be-used",
        forbiddenRoots: [],
        browserSession: browser
    });

    assert.equal(await credential.prepare(ONE, new AbortController().signal), undefined);
    assert.equal(browser.calls, 0);
});

test("cancelling the last managed Edge refresh waiter aborts the browser", async () => {
    await withArtifactRoot(async temporaryRoot => {
        const browser = new BlockingDouyinBrowserSession();
        const credential = new ManagedDouyinCookieCredential({
            managedRoot: join(temporaryRoot, "managed"),
            forbiddenRoots: [],
            browserSession: browser
        });
        const controller = new AbortController();

        const pending = credential.prepare(DOUYIN, controller.signal);
        await browser.started;
        controller.abort("cancelled");
        await assert.rejects(pending, error => error instanceof Error && error.name === "AbortError");
        await assertEventually(() => browser.signal?.aborted === true);
    });
});

test("managed Edge retries one yt-dlp non-zero exit after a forced refresh", async () => {
    const provider = new RecordingCookieProvider(true);
    let attempts = 0;
    const downloader = new YtDlpVideoDownloader({
        douyinCookieCredential: provider,
        processRunner: async request => {
            attempts += 1;
            if (attempts === 1) return { exitCode: 1, stdout: "" };
            const outputPath = requiredArgumentValue(request.arguments, "--output").replace("%(ext)s", "mp4");
            await writeFile(outputPath, Uint8Array.from([1]));
            return { exitCode: 0, stdout: outputPath };
        }
    });

    const download = await downloader.download({ sourceUrl: DOUYIN, signal: new AbortController().signal });
    await readStream(download.stream);
    assert.equal(attempts, 2);
    assert.deepEqual(provider.forceRefreshes, [false, true]);
});

test("managed Edge never retries yt-dlp more than once", async () => {
    const provider = new RecordingCookieProvider(true);
    let attempts = 0;
    const downloader = new YtDlpVideoDownloader({
        douyinCookieCredential: provider,
        processRunner: async () => {
            attempts += 1;
            return { exitCode: 1, stdout: "" };
        }
    });

    await assert.rejects(
        downloader.download({ sourceUrl: DOUYIN, signal: new AbortController().signal }),
        error => error instanceof DownloaderError && error.code === "POPUP_CAPTURE_DOWNLOAD_FAILED"
    );
    assert.equal(attempts, 2);
    assert.deepEqual(provider.forceRefreshes, [false, true]);
});

test("file credentials preserve the existing no-refresh retry behavior", async () => {
    const provider = new RecordingCookieProvider(false);
    let attempts = 0;
    const downloader = new YtDlpVideoDownloader({
        douyinCookieCredential: provider,
        processRunner: async () => {
            attempts += 1;
            return { exitCode: 1, stdout: "" };
        }
    });

    await assert.rejects(
        downloader.download({ sourceUrl: DOUYIN, signal: new AbortController().signal }),
        error => error instanceof DownloaderError && error.code === "POPUP_CAPTURE_DOWNLOAD_FAILED"
    );
    assert.equal(attempts, 1);
    assert.deepEqual(provider.forceRefreshes, [false]);
});

test("yt-dlp uses a temporary Cookie copy only for Douyin and removes it after process close", async () => {
    await withArtifactRoot(async vaultRoot => {
        const now = Date.now();
        const sourceFile = join(vaultRoot, "douyin-source.txt");
        const sourceContents = validCookieFile(now);
        await writeFreshFile(sourceFile, sourceContents, now);
        let temporaryCookiePath: string | undefined;
        const downloader = new YtDlpVideoDownloader({
            douyinCookieCredential: new DouyinCookieCredential({ sourceFile, forbiddenRoots: [], now: () => now }),
            processRunner: async request => {
                temporaryCookiePath = requiredArgumentValue(request.arguments, "--cookies");
                assert.notEqual(temporaryCookiePath, sourceFile);
                assert.equal(await readFile(temporaryCookiePath, "utf8"), sourceContents);
                const outputPath = requiredArgumentValue(request.arguments, "--output").replace("%(ext)s", "mp4");
                await writeFile(outputPath, Uint8Array.from([1]));
                return { exitCode: 0, stdout: outputPath };
            }
        });

        const download = await downloader.download({ sourceUrl: DOUYIN, signal: new AbortController().signal });
        assert.ok(temporaryCookiePath);
        await assertEventuallyMissing(temporaryCookiePath);
        await readStream(download.stream);
        assert.equal(await readFile(sourceFile, "utf8"), sourceContents);
    });
});

test("Douyin download without configured credentials fails before yt-dlp starts", async () => {
    let processStarted = false;
    const downloader = new YtDlpVideoDownloader({
        processRunner: async () => {
            processStarted = true;
            return { exitCode: 1, stdout: "" };
        }
    });

    await assert.rejects(
        downloader.download({ sourceUrl: DOUYIN, signal: new AbortController().signal }),
        error => error instanceof DownloaderError && error.code === "POPUP_CAPTURE_DOWNLOADER_UNAVAILABLE"
    );
    assert.equal(processStarted, false);
});

test("cancelling a Douyin download removes the temporary Cookie copy", async () => {
    await withArtifactRoot(async vaultRoot => {
        const now = Date.now();
        const sourceFile = join(vaultRoot, "douyin-source.txt");
        await writeFreshFile(sourceFile, validCookieFile(now), now);
        const controller = new AbortController();
        let temporaryCookiePath: string | undefined;
        let notifyStarted!: () => void;
        const started = new Promise<void>(resolveStarted => {
            notifyStarted = resolveStarted;
        });
        const downloader = new YtDlpVideoDownloader({
            douyinCookieCredential: new DouyinCookieCredential({ sourceFile, forbiddenRoots: [], now: () => now }),
            processRunner: request => {
                temporaryCookiePath = requiredArgumentValue(request.arguments, "--cookies");
                notifyStarted();
                return new Promise((_resolve, reject) => {
                    request.signal.addEventListener(
                        "abort",
                        () => {
                            const error = new Error("aborted");
                            error.name = "AbortError";
                            reject(error);
                        },
                        { once: true }
                    );
                });
            }
        });

        const pendingDownload = downloader.download({ sourceUrl: DOUYIN, signal: controller.signal });
        await started;
        controller.abort("revoked");
        await assert.rejects(pendingDownload, error => error instanceof Error && error.name === "AbortError");
        assert.ok(temporaryCookiePath);
        await assertEventuallyMissing(temporaryCookiePath);
    });
});

test("yt-dlp adapter maps a missing executable to downloader unavailable", async () => {
    let temporaryDirectory: string | undefined;
    const downloader = new YtDlpVideoDownloader({
        processRunner: request => {
            temporaryDirectory = request.cwd;
            return Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
        }
    });

    await assert.rejects(
        downloader.download({ sourceUrl: ONE, signal: new AbortController().signal }),
        error => error instanceof DownloaderError && error.code === "POPUP_CAPTURE_DOWNLOADER_UNAVAILABLE"
    );
    assert.ok(temporaryDirectory);
    await assertEventuallyMissing(temporaryDirectory);
});

test("yt-dlp adapter maps non-zero exit and empty output to download failed", async () => {
    const runners: ProcessRunner[] = [
        async () => ({ exitCode: 1, stdout: "" }),
        async request => {
            const outputPath = requiredArgumentValue(request.arguments, "--output").replace("%(ext)s", "mp4");
            await writeFile(outputPath, new Uint8Array());
            return { exitCode: 0, stdout: outputPath };
        }
    ];

    for (const processRunner of runners) {
        const downloader = new YtDlpVideoDownloader({ processRunner });
        await assert.rejects(
            downloader.download({ sourceUrl: ONE, signal: new AbortController().signal }),
            error => error instanceof DownloaderError && error.code === "POPUP_CAPTURE_DOWNLOAD_FAILED"
        );
    }
});

test("yt-dlp adapter rejects paths outside its private directory", async () => {
    await withArtifactRoot(async externalDirectory => {
        const externalPath = join(externalDirectory, "outside.mp4");
        await writeFile(externalPath, Uint8Array.from([1]));
        const downloader = new YtDlpVideoDownloader({
            processRunner: async () => ({ exitCode: 0, stdout: externalPath })
        });

        await assert.rejects(
            downloader.download({ sourceUrl: ONE, signal: new AbortController().signal }),
            error => error instanceof DownloaderError && error.code === "POPUP_CAPTURE_DOWNLOAD_FAILED"
        );
    });
});

test("yt-dlp adapter rejects unknown media extensions", async () => {
    const downloader = new YtDlpVideoDownloader({
        processRunner: async request => {
            const outputPath = requiredArgumentValue(request.arguments, "--output").replace("%(ext)s", "unknown");
            await writeFile(outputPath, Uint8Array.from([1]));
            return { exitCode: 0, stdout: outputPath };
        }
    });

    await assert.rejects(
        downloader.download({ sourceUrl: ONE, signal: new AbortController().signal }),
        error => error instanceof DownloaderError && error.code === "POPUP_CAPTURE_DOWNLOAD_FAILED"
    );
});

test("yt-dlp adapter relays cancellation and removes its private directory", async () => {
    const controller = new AbortController();
    let temporaryDirectory: string | undefined;
    const downloader = new YtDlpVideoDownloader({
        processRunner: request => {
            temporaryDirectory = request.cwd;
            return new Promise((_resolve, reject) => {
                const rejectAborted = () => {
                    const error = new Error("aborted");
                    error.name = "AbortError";
                    reject(error);
                };
                if (request.signal.aborted) {
                    rejectAborted();
                    return;
                }
                request.signal.addEventListener("abort", rejectAborted, { once: true });
            });
        }
    });

    const pendingDownload = downloader.download({ sourceUrl: ONE, signal: controller.signal });
    controller.abort("cancelled");
    await assert.rejects(pendingDownload, error => error instanceof Error && error.name === "AbortError");
    assert.ok(temporaryDirectory);
    await assertEventuallyMissing(temporaryDirectory);
});

test("successful capture materializes bytes, hash, and a file ArtifactRef", async () => {
    await withArtifactRoot(async artifactRoot => {
        const bytes = Uint8Array.from([1, 2, 3, 4]);
        const harness = new CaptureHarness();
        registerCapture(harness.context, { artifactRoot }, new FixtureDownloader(new Map([[ONE, { bytes }]])));

        const submission = asRecord(await harness.execute(validRequest([ONE])));
        assert.equal(submission.status, "queued");
        assert.equal(submission.job_id, "popup-capture-1");

        const outcome = await harness.lastJob.hooks.done;
        assert.equal(outcome.status, "completed");
        const result = parseVideoSet(outcome.output);
        assert.equal(result.status, "completed");
        assert.equal(result.videos.length, 1);
        assert.equal(result.failures.length, 0);

        const artifact = result.videos[0]?.artifact;
        assert.ok(artifact);
        assert.equal(artifact.byte_size, bytes.byteLength);
        assert.equal(artifact.sha256, createHash("sha256").update(bytes).digest("hex"));
        assert.deepEqual(new Uint8Array(await readFile(fileURLToPath(artifact.uri))), bytes);
    });
});

test("partial capture preserves per-result order and stable network failure", async () => {
    await withArtifactRoot(async artifactRoot => {
        const harness = new CaptureHarness();
        const downloader = new FixtureDownloader(
            new Map([
                [ONE, { bytes: Uint8Array.from([1]) }],
                [TWO, { error: "POPUP_CAPTURE_NETWORK_ERROR" }],
                [THREE, { bytes: Uint8Array.from([3]) }]
            ])
        );
        registerCapture(harness.context, { artifactRoot }, downloader);

        await harness.execute(validRequest([ONE, TWO, THREE]));
        const outcome = await harness.lastJob.hooks.done;
        const result = parseVideoSet(outcome.output);

        assert.equal(outcome.status, "completed");
        assert.equal(result.status, "partial");
        assert.deepEqual(
            result.videos.map(video => video.source_url),
            [ONE, THREE]
        );
        assert.deepEqual(
            result.failures.map(failure => failure.source_url),
            [TWO]
        );
        assert.equal(result.failures[0]?.code, "POPUP_CAPTURE_NETWORK_ERROR");
        assert.equal(result.error?.code, "POPUP_CAPTURE_PARTIAL_FAILURE");
        assert.equal(result.error?.retryable, true);
        assert.deepEqual(downloader.calls, [ONE, TWO, THREE]);
    });
});

test("artifact write failures remain stable", async () => {
    await withArtifactRoot(async temporaryDirectory => {
        const artifactRoot = join(temporaryDirectory, "not-a-directory");
        await writeFile(artifactRoot, "occupied");
        const harness = new CaptureHarness();
        registerCapture(
            harness.context,
            { artifactRoot },
            new FixtureDownloader(new Map([[ONE, { bytes: Uint8Array.from([1]) }]]))
        );

        await harness.execute(validRequest([ONE]));
        const result = parseVideoSet((await harness.lastJob.hooks.done).output);
        assert.equal(result.failures[0]?.code, "POPUP_CAPTURE_ARTIFACT_WRITE_FAILED");
    });
});

test("Job cancellation aborts the downloader and done never rejects", async () => {
    await withArtifactRoot(async artifactRoot => {
        const harness = new CaptureHarness();
        registerCapture(harness.context, { artifactRoot }, new BlockingDownloader());

        await harness.execute(validRequest([ONE]));
        harness.lastJob.hooks.cancel("no longer needed");
        const outcome = await harness.lastJob.hooks.done;

        assert.equal(outcome.status, "killed");
        const result = parseVideoSet(outcome.output);
        assert.equal(result.failures[0]?.code, "POPUP_CAPTURE_CANCELLED");
        assert.equal(result.error?.code, "POPUP_CAPTURE_CANCELLED");
    });
});

function validRequest(videoUrls: string[]): unknown {
    return { contract_version: CAPTURE_REQUEST_VERSION, video_urls: videoUrls };
}

function parseVideoSet(output: string | undefined): CapturedVideoSetV1 {
    assert.notEqual(output, undefined);
    return JSON.parse(output ?? "") as CapturedVideoSetV1;
}

function asRecord(value: unknown): Record<string, unknown> {
    assert.equal(typeof value, "object");
    assert.notEqual(value, null);
    return value as Record<string, unknown>;
}

async function withArtifactRoot(run: (artifactRoot: string) => Promise<void>): Promise<void> {
    const artifactRoot = await mkdtemp(join(tmpdir(), "popup-capture-test-"));
    try {
        await run(artifactRoot);
    } finally {
        await rm(artifactRoot, { recursive: true, force: true });
    }
}

function requiredArgumentValue(arguments_: readonly string[], name: string): string {
    const index = arguments_.indexOf(name);
    const value = arguments_[index + 1];
    assert.notEqual(index, -1, `${name} argument is missing`);
    assert.notEqual(value, undefined, `${name} value is missing`);
    return value as string;
}

async function readStream(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return new Uint8Array(Buffer.concat(chunks));
}

async function assertEventuallyMissing(path: string): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            await access(path);
        } catch (error) {
            assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
            return;
        }
        await delay(10);
    }
    assert.fail(`temporary path was not removed: ${path}`);
}

async function assertEventually(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (predicate()) return;
        await delay(10);
    }
    assert.fail("condition was not met");
}

class FakeDouyinBrowserSession implements DouyinBrowserSession {
    calls = 0;

    constructor(
        private readonly cookies: readonly BrowserCookieRecord[],
        private readonly waitUntil: Promise<void> = Promise.resolve()
    ) {}

    async collectCookies(
        request: Parameters<DouyinBrowserSession["collectCookies"]>[0]
    ): Promise<readonly BrowserCookieRecord[]> {
        this.calls += 1;
        await this.waitUntil;
        request.signal.throwIfAborted();
        return this.cookies;
    }
}

class BlockingDouyinBrowserSession implements DouyinBrowserSession {
    signal: AbortSignal | undefined;
    readonly started: Promise<void>;
    private readonly notifyStarted: () => void;

    constructor() {
        let notifyStarted!: () => void;
        this.started = new Promise<void>(resolve => {
            notifyStarted = resolve;
        });
        this.notifyStarted = notifyStarted;
    }

    async collectCookies(request: Parameters<DouyinBrowserSession["collectCookies"]>[0]): Promise<never> {
        this.signal = request.signal;
        this.notifyStarted();
        return await new Promise<never>((_resolve, reject) => {
            const rejectAborted = () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
            };
            if (request.signal.aborted) {
                rejectAborted();
                return;
            }
            request.signal.addEventListener("abort", rejectAborted, { once: true });
        });
    }
}

class RecordingCookieProvider implements DouyinCookieProvider {
    readonly forceRefreshes: boolean[] = [];

    constructor(readonly supportsRefresh: boolean) {}

    async prepare(
        _sourceUrl: string,
        signal: AbortSignal,
        options: CookieCredentialPrepareOptions = {}
    ): Promise<undefined> {
        signal.throwIfAborted();
        this.forceRefreshes.push(options.forceRefresh === true);
        return undefined;
    }
}

function validBrowserCookies(now: number): readonly BrowserCookieRecord[] {
    return [
        {
            domain: ".douyin.com",
            path: "/",
            expires: Math.floor(now / 1000) + 3600,
            httpOnly: true,
            secure: true,
            name: "test_cookie",
            value: "TEST_ONLY_NOT_A_SECRET"
        }
    ];
}

function validCookieFile(now: number, domain = ".douyin.com", expiry = Math.floor(now / 1000) + 3600): string {
    return cookieFileWithRecords([`${domain}\tTRUE\t/\tTRUE\t${expiry}\ttest_cookie\tTEST_ONLY_NOT_A_SECRET`]);
}

function cookieFileWithRecords(records: readonly string[]): string {
    return ["# Netscape HTTP Cookie File", ...records, ""].join(process.platform === "win32" ? "\r\n" : "\n");
}

async function writeFreshFile(path: string, contents: string, modifiedAt: number): Promise<void> {
    await writeFile(path, contents, "utf8");
    const modifiedDate = new Date(modifiedAt);
    await utimes(path, modifiedDate, modifiedDate);
}
