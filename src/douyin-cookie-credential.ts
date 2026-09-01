import { lstat, mkdir, mkdtemp, readFile, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { EOL, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { DownloaderError, isAbortError } from "./errors.js";

const DEFAULT_MAX_AGE_SECONDS = 1800;
const MAX_COOKIE_FILE_BYTES = 1024 * 1024;
const WORK_DIRECTORY_NAME = ".popup-capture-cookie-work";
const HTTP_ONLY_PREFIX = "#HttpOnly_";

export interface DouyinCookieCredentialOptions {
    sourceFile?: string;
    maxAgeSeconds?: number;
    forbiddenRoots?: readonly string[];
    now?: () => number;
}

export interface CookieCredentialLease {
    filePath: string;
    dispose(): Promise<void>;
}

export interface CookieCredentialPrepareOptions {
    forceRefresh?: boolean;
}

export interface DouyinCookieProvider {
    readonly supportsRefresh: boolean;
    prepare(
        sourceUrl: string,
        signal: AbortSignal,
        options?: CookieCredentialPrepareOptions
    ): Promise<CookieCredentialLease | undefined>;
}

export class DouyinCookieCredential implements DouyinCookieProvider {
    readonly supportsRefresh = false;
    private readonly sourceFile: string | undefined;
    private readonly maxAgeSeconds: number;
    private readonly forbiddenRoots: readonly string[];
    private readonly now: () => number;

    constructor(options: DouyinCookieCredentialOptions = {}) {
        const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
        if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
            throw new RangeError("douyinCookieMaxAgeSeconds must be a positive integer");
        }
        this.sourceFile = normalizedSourceFile(options.sourceFile);
        this.maxAgeSeconds = maxAgeSeconds;
        this.forbiddenRoots = options.forbiddenRoots ?? [process.cwd(), tmpdir()];
        this.now = options.now ?? Date.now;
    }

    async prepare(sourceUrl: string, signal: AbortSignal): Promise<CookieCredentialLease | undefined> {
        if (!isDouyinUrl(sourceUrl)) return undefined;
        if (this.sourceFile === undefined || !isAbsolute(this.sourceFile)) {
            throw unavailableCredential();
        }

        let jobDirectory: string | undefined;
        let workRootRealPath: string | undefined;
        try {
            signal.throwIfAborted();
            const sourcePath = resolve(this.sourceFile);
            const sourceLinkStats = await lstat(sourcePath);
            if (sourceLinkStats.isSymbolicLink()) {
                throw unavailableCredential();
            }

            const sourceRealPath = await realpath(sourcePath);
            await rejectForbiddenPath(sourceRealPath, this.forbiddenRoots);

            const sourceStats = await stat(sourceRealPath);
            if (!sourceStats.isFile() || sourceStats.size === 0 || sourceStats.size > MAX_COOKIE_FILE_BYTES) {
                throw invalidCredential();
            }
            const ageMilliseconds = this.now() - Math.floor(sourceStats.mtimeMs);
            if (ageMilliseconds < 0 || ageMilliseconds > this.maxAgeSeconds * 1000) {
                throw invalidCredential();
            }

            const sourceBytes = await readFile(sourceRealPath, { signal });
            let cookieFileContents: string;
            try {
                cookieFileContents = validDouyinCookieFile(sourceBytes.toString("utf8"), this.now());
            } finally {
                sourceBytes.fill(0);
            }

            const sourceDirectoryRealPath = await realpath(dirname(sourceRealPath));
            const workRoot = join(sourceDirectoryRealPath, WORK_DIRECTORY_NAME);
            await mkdir(workRoot, { recursive: true, mode: 0o700 });
            const workRootStats = await lstat(workRoot);
            if (workRootStats.isSymbolicLink()) {
                throw unavailableCredential();
            }
            workRootRealPath = await realpath(workRoot);
            if (!isPathWithin(workRootRealPath, sourceDirectoryRealPath)) {
                throw unavailableCredential();
            }

            jobDirectory = await mkdtemp(join(workRootRealPath, "job-"));
            const temporaryCookiePath = join(jobDirectory, "cookies.txt");
            await writeFile(temporaryCookiePath, cookieFileContents, {
                encoding: "utf8",
                flag: "wx",
                mode: 0o600,
                signal
            });

            const dispose = cleanupOnce(jobDirectory, workRootRealPath);
            jobDirectory = undefined;
            return { filePath: temporaryCookiePath, dispose };
        } catch (error) {
            if (signal.aborted || isAbortError(error)) throw error;
            if (error instanceof DownloaderError) throw error;
            if (isCredentialAccessError(error)) {
                throw unavailableCredential(error);
            }
            throw invalidCredential(error);
        } finally {
            if (jobDirectory !== undefined) {
                await rm(jobDirectory, { recursive: true, force: true }).catch(() => undefined);
            }
            if (workRootRealPath !== undefined) {
                await rmdir(workRootRealPath).catch(() => undefined);
            }
        }
    }
}

export function isDouyinUrl(sourceUrl: string): boolean {
    try {
        const hostname = new URL(sourceUrl).hostname.toLowerCase();
        return hostname === "douyin.com" || hostname.endsWith(".douyin.com");
    } catch {
        return false;
    }
}

function normalizedSourceFile(sourceFile: string | undefined): string | undefined {
    const normalized = sourceFile?.trim();
    return normalized === "" ? undefined : normalized;
}

async function rejectForbiddenPath(sourcePath: string, forbiddenRoots: readonly string[]): Promise<void> {
    for (const forbiddenRoot of forbiddenRoots) {
        const rootPath = await realPathOrResolved(forbiddenRoot);
        if (isPathWithin(sourcePath, rootPath)) {
            throw unavailableCredential();
        }
    }
}

async function realPathOrResolved(path: string): Promise<string> {
    try {
        return await realpath(resolve(path));
    } catch {
        return resolve(path);
    }
}

function isPathWithin(candidate: string, root: string): boolean {
    const pathFromRoot = relative(root, candidate);
    return (
        pathFromRoot === ""
        || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
    );
}

function validDouyinCookieFile(contents: string, nowMilliseconds: number): string {
    const lines = contents.split(/\r\n|\n|\r/u);
    const header = lines[0]?.trim();
    if (header !== "# HTTP Cookie File" && header !== "# Netscape HTTP Cookie File") {
        throw invalidCredential();
    }

    const nowSeconds = Math.floor(nowMilliseconds / 1000);
    const validRecords: string[] = [];
    for (const line of lines.slice(1)) {
        if (line.trim() === "") continue;
        if (line.startsWith("#") && !line.startsWith(HTTP_ONLY_PREFIX)) continue;

        const fields = line.split("\t");
        if (fields.length !== 7) {
            throw invalidCredential();
        }
        const [rawDomain, includeSubdomains, cookiePath, secure, rawExpiry, name] = fields;
        const domain = normalizedCookieDomain(rawDomain ?? "");
        const expiry = Number(rawExpiry);
        if (
            !isDouyinCookieDomain(domain)
            || (includeSubdomains !== "TRUE" && includeSubdomains !== "FALSE")
            || !cookiePath?.startsWith("/")
            || (secure !== "TRUE" && secure !== "FALSE")
            || !Number.isSafeInteger(expiry)
            || expiry < 0
            || name === undefined
        ) {
            throw invalidCredential();
        }
        if (expiry !== 0 && expiry <= nowSeconds) continue;
        if (name.length === 0) continue;
        validRecords.push(line);
    }

    if (validRecords.length === 0) {
        throw invalidCredential();
    }
    return ["# Netscape HTTP Cookie File", ...validRecords, ""].join(EOL);
}

function normalizedCookieDomain(rawDomain: string): string {
    const withoutHttpOnly =
        rawDomain.startsWith(HTTP_ONLY_PREFIX) ? rawDomain.slice(HTTP_ONLY_PREFIX.length) : rawDomain;
    return withoutHttpOnly.replace(/^\./u, "").toLowerCase();
}

function isDouyinCookieDomain(domain: string): boolean {
    return domain === "douyin.com" || domain.endsWith(".douyin.com");
}

function cleanupOnce(jobDirectory: string, workRoot: string): () => Promise<void> {
    let cleanup: Promise<void> | undefined;
    return () => {
        cleanup ??= (async () => {
            await rm(jobDirectory, { recursive: true, force: true }).catch(() => undefined);
            await rmdir(workRoot).catch(() => undefined);
        })();
        return cleanup;
    };
}

function isCredentialAccessError(error: unknown): boolean {
    if (!(error instanceof Error) || !("code" in error)) return false;
    return (
        error.code === "EACCES"
        || error.code === "EEXIST"
        || error.code === "ENOENT"
        || error.code === "ENOTDIR"
        || error.code === "EPERM"
        || error.code === "EROFS"
    );
}

function unavailableCredential(cause?: unknown): DownloaderError {
    return new DownloaderError("POPUP_CAPTURE_DOWNLOADER_UNAVAILABLE", cause === undefined ? undefined : { cause });
}

function invalidCredential(cause?: unknown): DownloaderError {
    return new DownloaderError("POPUP_CAPTURE_DOWNLOAD_FAILED", cause === undefined ? undefined : { cause });
}
