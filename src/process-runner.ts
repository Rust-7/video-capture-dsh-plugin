import { spawn } from "node:child_process";

const MAX_STDOUT_BYTES = 64 * 1024;

export interface ProcessRunRequest {
    executable: string;
    arguments: readonly string[];
    cwd: string;
    signal: AbortSignal;
}

export interface ProcessRunResult {
    exitCode: number | null;
    stdout: string;
}

export type ProcessRunner = (request: ProcessRunRequest) => Promise<ProcessRunResult>;

export const runProcess: ProcessRunner = request =>
    new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(request.executable, [...request.arguments], {
                cwd: request.cwd,
                shell: false,
                signal: request.signal,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true
            });
        } catch (error) {
            reject(error);
            return;
        }

        let settled = false;
        let stdout = "";
        let stdoutBytes = 0;
        let processError: Error | undefined;
        let outputError: Error | undefined;

        child.stdout.on("data", (chunk: Buffer) => {
            if (outputError !== undefined) return;
            stdoutBytes += chunk.byteLength;
            if (stdoutBytes > MAX_STDOUT_BYTES) {
                outputError = new Error("yt-dlp stdout exceeded the capture limit");
                child.kill();
                return;
            }
            stdout += chunk.toString("utf8");
        });
        child.stderr.resume();

        child.once("error", error => {
            processError = error;
        });
        child.once("close", exitCode => {
            if (settled) return;
            settled = true;
            if (processError !== undefined) {
                reject(processError);
                return;
            }
            if (outputError !== undefined) {
                reject(outputError);
                return;
            }
            resolve({ exitCode, stdout });
        });
    });
