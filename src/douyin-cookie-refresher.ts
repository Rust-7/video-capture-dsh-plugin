import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { EOL, tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import {
    BrowserRefreshError,
    BrowserUnavailableError,
    PlaywrightDouyinBrowserSession,
    type BrowserCookieRecord,
    type DouyinBrowserSession
} from "./douyin-browser-session.js";
import {
    DouyinCookieCredential,
    type CookieCredentialLease,
    type CookieCredentialPrepareOptions,
    type DouyinCookieProvider,
    isDouyinUrl
} from "./douyin-cookie-credential.js";
import { DownloaderError, isAbortError } from "./errors.js";

const DEFAULT_REFRESH_SECONDS = 1200;
const MAX_REFRESH_SECONDS = 1800;
const DEFAULT_BROWSER_TIMEOUT_MS = 45_000;
const MAX_BROWSER_TIMEOUT_MS = 120_000;
const PROFILE_DIRECTORY_NAME = "edge-profile";
const COOKIE_CACHE_NAME = "managed-cookies.txt";
const HTTP_ONLY_PREFIX = "#HttpOnly_";

export interface ManagedDouyinCookieCredentialOptions {
    managedRoot?: string;
    refreshSeconds?: number;
    browserTimeoutMs?: number;
    forbiddenRoots?: readonly string[];
    browserSession?: DouyinBrowserSession;
    now?: () => number;
}

interface ManagedPaths {
    root: string;
    profile: string;
    cookieCache: string;
}

interface RefreshFlight {
    controller: AbortController;
    promise: Promise<void>;
    settled: boolean;
    waiters: number;
}

export class ManagedDouyinCookieCredential implements DouyinCookieProvider {
    readonly supportsRefresh = true;

    private readonly managedRoot: string | undefined;
    private readonly refreshSeconds: number;
    private readonly browserTimeoutMs: number;
    private readonly forbiddenRoots: readonly string[];
    private readonly browserSession: DouyinBrowserSession;
    private readonly now: () => number;
    private readonly cacheCredential: DouyinCookieCredential;
    private refreshFlight: RefreshFlight | undefined;

    constructor(options: ManagedDouyinCookieCredentialOptions = {}) {
        this.managedRoot = normalizedPath(options.managedRoot);
        this.refreshSeconds = boundedInteger(
            options.refreshSeconds ?? DEFAULT_REFRESH_SECONDS,
            MAX_REFRESH_SECONDS,
            "douyinManagedRefreshSeconds"
        );
        this.browserTimeoutMs = boundedInteger(
            options.browserTimeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS,
            MAX_BROWSER_TIMEOUT_MS,
            "douyinManagedBrowserTimeoutMs"
        );
        this.forbiddenRoots = [
            ...(options.forbiddenRoots ?? [process.cwd(), tmpdir()]),
            ...synchronizedRoots(),
            ...personalBrowserRoots()
        ];
        this.browserSession = options.browserSession ?? new PlaywrightDouyinBrowserSession();
        this.now = options.now ?? Date.now;
        this.cacheCredential = new DouyinCookieCredential({
            sourceFile: this.managedRoot === undefined ? undefined : join(this.managedRoot, COOKIE_CACHE_NAME),
            maxAgeSeconds: this.refreshSeconds,
            forbiddenRoots: this.forbiddenRoots,
            now: this.now
        });
    }

    async prepare(
        sourceUrl: string,
        signal: AbortSignal,
        options: CookieCredentialPrepareOptions = {}
    ): Promise<CookieCredentialLease | undefined> {
        if (!isDouyinUrl(sourceUrl)) return undefined;
        signal.throwIfAborted();

        const paths = await this.ensureManagedPaths(signal);
        if (!options.forceRefresh) {
            try {
                return await this.cacheCredential.prepare(sourceUrl, signal);
            } catch (error) {
                if (signal.aborted || isAbortError(error)) throw error;
                if (!(error instanceof DownloaderError)) throw error;
            }
        }

        await this.joinRefresh(sourceUrl, paths, signal);
        return await this.cacheCredential.prepare(sourceUrl, signal);
    }

    private async joinRefresh(sourceUrl: string, paths: ManagedPaths, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        let flight = this.refreshFlight;
        if (flight === undefined) {
            const controller = new AbortController();
            flight = { controller, promise: Promise.resolve(), settled: false, waiters: 0 };
            this.refreshFlight = flight;
            flight.promise = this.refresh(sourceUrl, paths, controller.signal).finally(() => {
                flight!.settled = true;
                if (this.refreshFlight === flight) this.refreshFlight = undefined;
            });
        }

        flight.waiters += 1;
        try {
            await waitForRefresh(flight.promise, signal);
        } finally {
            flight.waiters -= 1;
            if (!flight.settled && flight.waiters === 0) {
                flight.controller.abort("all refresh waiters cancelled");
            }
        }
    }

    private async refresh(sourceUrl: string, paths: ManagedPaths, signal: AbortSignal): Promise<void> {
        try {
            const cookies = await this.browserSession.collectCookies({
                sourceUrl,
                profileDirectory: paths.profile,
                timeoutMs: this.browserTimeoutMs,
                signal
            });
            signal.throwIfAborted();
            const serialized = serializeDouyinCookies(cookies, this.now());
            await replaceCookieCache(paths.cookieCache, serialized, signal);
        } catch (error) {
            if (signal.aborted || isAbortError(error)) throw error;
            if (error instanceof BrowserUnavailableError) {
                throw unavailableCredential(error);
            }
            if (error instanceof BrowserRefreshError || error instanceof DownloaderError) {
                throw downloadFailed(error);
            }
            throw downloadFailed(error);
        }
    }

    private async ensureManagedPaths(signal: AbortSignal): Promise<ManagedPaths> {
        try {
            signal.throwIfAborted();
            if (this.managedRoot === undefined || !isAbsolute(this.managedRoot) || isNetworkPath(this.managedRoot)) {
                throw unavailableCredential();
            }

            const requestedRoot = resolve(this.managedRoot);
            rejectBroadRoot(requestedRoot);
            await rejectForbiddenPath(requestedRoot, this.forbiddenRoots);
            await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
            const root = await safeRealDirectory(requestedRoot);
            if (!samePath(root, requestedRoot)) throw unavailableCredential();
            await rejectForbiddenPath(root, this.forbiddenRoots);

            const requestedProfile = join(root, PROFILE_DIRECTORY_NAME);
            await mkdir(requestedProfile, { recursive: true, mode: 0o700 });
            const profile = await safeRealDirectory(requestedProfile);
            if (!isPathWithin(profile, root) || !samePath(profile, requestedProfile)) throw unavailableCredential();

            return { root, profile, cookieCache: join(root, COOKIE_CACHE_NAME) };
        } catch (error) {
            if (signal.aborted || isAbortError(error)) throw error;
            if (error instanceof DownloaderError) throw error;
            throw unavailableCredential(error);
        }
    }
}

function serializeDouyinCookies(cookies: readonly BrowserCookieRecord[], nowMilliseconds: number): string {
    const nowSeconds = Math.floor(nowMilliseconds / 1000);
    const records: string[] = [];

    for (const cookie of cookies) {
        const domain = normalizedCookieDomain(cookie.domain);
        const expires = cookie.expires <= 0 ? 0 : Math.floor(cookie.expires);
        if (
            !isDouyinCookieDomain(domain)
            || cookie.name.length === 0
            || containsRecordSeparator(cookie.name)
            || containsRecordSeparator(cookie.value)
            || containsRecordSeparator(cookie.domain)
            || containsRecordSeparator(cookie.path)
            || !cookie.path.startsWith("/")
            || !Number.isSafeInteger(expires)
            || (expires !== 0 && expires <= nowSeconds)
        ) {
            continue;
        }

        const rawDomain = `${cookie.httpOnly ? HTTP_ONLY_PREFIX : ""}${cookie.domain}`;
        records.push(
            [
                rawDomain,
                cookie.domain.startsWith(".") ? "TRUE" : "FALSE",
                cookie.path,
                cookie.secure ? "TRUE" : "FALSE",
                String(expires),
                cookie.name,
                cookie.value
            ].join("\t")
        );
    }

    if (records.length === 0) throw downloadFailed();
    return ["# Netscape HTTP Cookie File", ...records, ""].join(EOL);
}

async function replaceCookieCache(cookieCache: string, contents: string, signal: AbortSignal): Promise<void> {
    const temporaryPath = join(dirname(cookieCache), `.managed-cookies-${randomUUID()}.tmp`);
    const bytes = Buffer.from(contents, "utf8");
    try {
        await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600, signal });
        signal.throwIfAborted();
        await rename(temporaryPath, cookieCache);
        const cacheStats = await lstat(cookieCache);
        if (!cacheStats.isFile() || cacheStats.isSymbolicLink()) throw downloadFailed();
    } finally {
        bytes.fill(0);
        await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
}

async function waitForRefresh(refresh: Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError(signal.reason);
    let rejectAborted!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
        rejectAborted = reject;
    });
    const onAbort = () => rejectAborted(abortError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
        await Promise.race([refresh, aborted]);
    } finally {
        signal.removeEventListener("abort", onAbort);
    }
}

async function safeRealDirectory(path: string): Promise<string> {
    const pathStats = await lstat(path);
    if (!pathStats.isDirectory() || pathStats.isSymbolicLink()) throw unavailableCredential();
    return await realpath(path);
}

async function rejectForbiddenPath(candidate: string, forbiddenRoots: readonly string[]): Promise<void> {
    for (const forbiddenRoot of forbiddenRoots) {
        const normalizedRoot = resolve(forbiddenRoot);
        let root = normalizedRoot;
        try {
            root = await realpath(normalizedRoot);
        } catch {
            // A missing forbidden root still reserves its resolved location.
        }
        if (isPathWithin(candidate, root)) throw unavailableCredential();
    }
}

function isPathWithin(candidate: string, root: string): boolean {
    const pathFromRoot = relative(root, candidate);
    return (
        pathFromRoot === ""
        || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
    );
}

function samePath(left: string, right: string): boolean {
    return process.platform === "win32" ?
            resolve(left).toLowerCase() === resolve(right).toLowerCase()
        :   resolve(left) === resolve(right);
}

function isNetworkPath(path: string): boolean {
    return path.startsWith("\\\\") || path.startsWith("//");
}

function synchronizedRoots(): string[] {
    return [process.env.OneDrive, process.env.OneDriveCommercial, process.env.OneDriveConsumer].filter(
        (value): value is string => typeof value === "string" && value.trim() !== ""
    );
}

function personalBrowserRoots(): string[] {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData === undefined || localAppData === "") return [];
    return [join(localAppData, "Microsoft", "Edge", "User Data"), join(localAppData, "Google", "Chrome", "User Data")];
}

function rejectBroadRoot(candidate: string): void {
    const broadRoots = [
        parse(candidate).root,
        process.env.USERPROFILE,
        process.env.LOCALAPPDATA,
        process.env.APPDATA
    ].filter((value): value is string => typeof value === "string" && value.trim() !== "");
    if (broadRoots.some(root => samePath(candidate, root))) throw unavailableCredential();
}

function normalizedPath(path: string | undefined): string | undefined {
    const normalized = path?.trim();
    return normalized === "" ? undefined : normalized;
}

function boundedInteger(value: number, maximum: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
        throw new RangeError(`${name} must be a positive integer no greater than ${maximum}`);
    }
    return value;
}

function normalizedCookieDomain(domain: string): string {
    return domain.replace(/^\./u, "").toLowerCase();
}

function isDouyinCookieDomain(domain: string): boolean {
    return domain === "douyin.com" || domain.endsWith(".douyin.com");
}

function containsRecordSeparator(value: string): boolean {
    return /[\t\r\n]/u.test(value);
}

function abortError(reason: unknown): Error {
    if (reason instanceof Error && reason.name === "AbortError") return reason;
    const error = new Error("The operation was aborted.", { cause: reason });
    error.name = "AbortError";
    return error;
}

function unavailableCredential(cause?: unknown): DownloaderError {
    return new DownloaderError("POPUP_CAPTURE_DOWNLOADER_UNAVAILABLE", cause === undefined ? undefined : { cause });
}

function downloadFailed(cause?: unknown): DownloaderError {
    return new DownloaderError("POPUP_CAPTURE_DOWNLOAD_FAILED", cause === undefined ? undefined : { cause });
}
