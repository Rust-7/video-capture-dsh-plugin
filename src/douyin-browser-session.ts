import { chromium } from "playwright-core";

import { isDouyinUrl } from "./douyin-cookie-credential.js";
import { isAbortError } from "./errors.js";

export interface BrowserCookieRecord {
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    name: string;
    value: string;
}

export interface DouyinBrowserSessionRequest {
    sourceUrl: string;
    profileDirectory: string;
    timeoutMs: number;
    signal: AbortSignal;
}

export interface DouyinBrowserSession {
    collectCookies(request: DouyinBrowserSessionRequest): Promise<readonly BrowserCookieRecord[]>;
}

export interface ManagedBrowserPage {
    goto(url: string, options: { timeout: number; waitUntil: "load" }): Promise<unknown>;
    url(): string;
    waitForTimeout(milliseconds: number): Promise<void>;
}

export interface ManagedBrowserContext {
    pages(): readonly ManagedBrowserPage[];
    newPage(): Promise<ManagedBrowserPage>;
    cookies(urls: readonly string[]): Promise<readonly BrowserCookieRecord[]>;
    close(): Promise<void>;
}

export type ManagedBrowserLauncher = (profileDirectory: string, timeoutMs: number) => Promise<ManagedBrowserContext>;

export class BrowserUnavailableError extends Error {
    constructor(options?: ErrorOptions) {
        super("The managed Edge browser is unavailable.", options);
        this.name = "BrowserUnavailableError";
    }
}

export class BrowserRefreshError extends Error {
    constructor(options?: ErrorOptions) {
        super("The managed Edge refresh failed.", options);
        this.name = "BrowserRefreshError";
    }
}

export class PlaywrightDouyinBrowserSession implements DouyinBrowserSession {
    constructor(private readonly launchBrowser: ManagedBrowserLauncher = launchManagedEdge) {}

    async collectCookies(request: DouyinBrowserSessionRequest): Promise<readonly BrowserCookieRecord[]> {
        if (!isDouyinUrl(request.sourceUrl)) throw new BrowserRefreshError();
        request.signal.throwIfAborted();

        let context: ManagedBrowserContext | undefined;
        try {
            const launch = this.launchBrowser(request.profileDirectory, request.timeoutMs);
            try {
                context = await waitForOperation(launch, request.signal, async lateContext => {
                    await lateContext.close().catch(() => undefined);
                });
            } catch (error) {
                if (request.signal.aborted || isAbortError(error)) throw error;
                throw new BrowserUnavailableError({ cause: error });
            }

            const closeOnAbort = () => void context?.close().catch(() => undefined);
            request.signal.addEventListener("abort", closeOnAbort, { once: true });
            try {
                request.signal.throwIfAborted();
                const pages = context.pages();
                const page = pages[0] ?? (await context.newPage());
                await page.goto(request.sourceUrl, { timeout: request.timeoutMs, waitUntil: "load" });
                request.signal.throwIfAborted();

                const finalUrl = page.url();
                if (!isDouyinUrl(finalUrl)) throw new BrowserRefreshError();
                await page.waitForTimeout(Math.min(8_000, request.timeoutMs));
                request.signal.throwIfAborted();
                const settledUrl = page.url();
                if (!isDouyinUrl(settledUrl)) throw new BrowserRefreshError();
                return await context.cookies(["https://www.douyin.com/", settledUrl]);
            } catch (error) {
                if (request.signal.aborted || isAbortError(error)) throw abortError(request.signal.reason);
                if (error instanceof BrowserRefreshError) throw error;
                throw new BrowserRefreshError({ cause: error });
            } finally {
                request.signal.removeEventListener("abort", closeOnAbort);
            }
        } finally {
            await context?.close().catch(() => undefined);
        }
    }
}

async function launchManagedEdge(profileDirectory: string, timeoutMs: number): Promise<ManagedBrowserContext> {
    return await chromium.launchPersistentContext(profileDirectory, {
        acceptDownloads: false,
        channel: "msedge",
        chromiumSandbox: true,
        headless: true,
        timeout: timeoutMs
    });
}

async function waitForOperation<T>(
    operation: Promise<T>,
    signal: AbortSignal,
    disposeLateResult: (result: T) => Promise<void>
): Promise<T> {
    if (signal.aborted) throw abortError(signal.reason);

    let rejectAborted!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
        rejectAborted = reject;
    });
    const onAbort = () => rejectAborted(abortError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });

    try {
        return await Promise.race([operation, aborted]);
    } catch (error) {
        if (signal.aborted) {
            void operation.then(disposeLateResult).catch(() => undefined);
        }
        throw error;
    } finally {
        signal.removeEventListener("abort", onAbort);
    }
}

function abortError(reason: unknown): Error {
    if (reason instanceof Error && reason.name === "AbortError") return reason;
    const error = new Error("The operation was aborted.", { cause: reason });
    error.name = "AbortError";
    return error;
}
