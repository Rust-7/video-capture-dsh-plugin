import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Ajv2020, type AnySchema, type ValidateFunction } from "ajv/dist/2020.js";

import { CAPTURE_ERROR_CODES, type CapturedVideoSetV1 } from "../src/contracts.js";
import { registerCapture } from "../src/plugin.js";
import { CaptureHarness, FixtureDownloader } from "./helpers.js";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

test("all shipped fixtures validate against their v1 schemas", async () => {
    const validators = await loadValidators();
    const errorSchema = asRecord(await readJson("contracts/capture/v1/capture-error.schema.json"));
    const errorProperties = asRecord(errorSchema.properties);
    const errorCode = asRecord(errorProperties.code);
    assert.deepEqual(errorCode.enum, [...CAPTURE_ERROR_CODES]);

    const validOne = await readJson("fixtures/requests/valid-one.json");
    const validThree = await readJson("fixtures/requests/valid-three.json");
    const invalidHttp = await readJson("fixtures/requests/invalid-http.json");

    assertValid(validators.request, validOne);
    assertValid(validators.request, validThree);
    assert.equal(validators.request(invalidHttp), false);

    const resultFixtures = [
        { file: "completed.json", urls: ["https://videos.example.test/one.mp4"] },
        { file: "partial.json", urls: ["https://videos.example.test/one.mp4", "https://videos.example.test/two.mp4"] },
        { file: "failed.json", urls: ["https://videos.example.test/one.mp4"] }
    ];
    for (const fixture of resultFixtures) {
        const value = await readJson(`fixtures/results/${fixture.file}`);
        assertValid(validators.videoSet, value);
        assertVideoSetSemantics(value as CapturedVideoSetV1, fixture.urls);
    }
});

test("fixture-backed Tool to Job flow produces schema-valid CapturedVideoSet v1", async () => {
    const validators = await loadValidators();
    const request = await readJson("fixtures/requests/valid-one.json");
    assertValid(validators.request, request);

    const sourceUrl = asRecord(request).video_urls;
    assert.ok(Array.isArray(sourceUrl));
    assert.equal(typeof sourceUrl[0], "string");

    const harness = new CaptureHarness();
    registerCapture(
        harness.context,
        { artifactRoot: fileURLToPath(new URL("../../.test-dist/artifacts", import.meta.url)) },
        new FixtureDownloader(new Map([[sourceUrl[0], { bytes: Uint8Array.from([1, 2, 3, 4]) }]]))
    );

    const submission = await harness.execute(request);
    assertValid(validators.submission, submission);
    assert.equal(asRecord(submission).status, "queued");

    const outcome = await harness.lastJob.hooks.done;
    assert.equal(outcome.status, "completed");
    assert.notEqual(outcome.output, undefined);
    const videoSet = JSON.parse(outcome.output ?? "") as CapturedVideoSetV1;
    assertValid(validators.videoSet, videoSet);
    assertVideoSetSemantics(videoSet, sourceUrl as string[]);
});

async function loadValidators(): Promise<{
    request: ValidateFunction;
    submission: ValidateFunction;
    videoSet: ValidateFunction;
}> {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const schemas = await Promise.all([
        readJson("contracts/common/v1/artifact-ref.schema.json"),
        readJson("contracts/capture/v1/capture-error.schema.json"),
        readJson("contracts/capture/v1/capture-request.schema.json"),
        readJson("contracts/capture/v1/capture-submission.schema.json"),
        readJson("contracts/capture/v1/captured-video-set.schema.json")
    ]);
    for (const schema of schemas) {
        ajv.addSchema(schema as AnySchema);
    }
    return {
        request: requiredValidator(ajv.getSchema("urn:poppincn:popup:capture-request:v1")),
        submission: requiredValidator(ajv.getSchema("urn:poppincn:popup:capture-submission:v1")),
        videoSet: requiredValidator(ajv.getSchema("urn:poppincn:popup:captured-video-set:v1"))
    };
}

function assertVideoSetSemantics(result: CapturedVideoSetV1, expectedUrls: string[]): void {
    const successes = result.videos.map(video => video.source_url);
    const failures = result.failures.map(failure => failure.source_url);
    assert.ok(failures.every((sourceUrl): sourceUrl is string => sourceUrl !== undefined));
    assert.equal(new Set([...successes, ...failures]).size, expectedUrls.length);
    for (const sourceUrl of expectedUrls) {
        assert.equal(
            successes.filter(value => value === sourceUrl).length
                + failures.filter(value => value === sourceUrl).length,
            1
        );
    }
    assert.deepEqual(
        successes.map(sourceUrl => expectedUrls.indexOf(sourceUrl)),
        [...successes.map(sourceUrl => expectedUrls.indexOf(sourceUrl))].sort((left, right) => left - right)
    );
    assert.deepEqual(
        failures.map(sourceUrl => expectedUrls.indexOf(sourceUrl)),
        [...failures.map(sourceUrl => expectedUrls.indexOf(sourceUrl))].sort((left, right) => left - right)
    );
    assert.equal(
        result.status,
        failures.length === 0 ? "completed"
        : successes.length === 0 ? "failed"
        : "partial"
    );
}

async function readJson(relativePath: string): Promise<unknown> {
    return JSON.parse(await readFile(join(packageRoot, relativePath), "utf8"));
}

function requiredValidator(validator: ValidateFunction | undefined): ValidateFunction {
    assert.notEqual(validator, undefined);
    return validator as ValidateFunction;
}

function assertValid(validator: ValidateFunction, value: unknown): void {
    assert.equal(validator(value), true, JSON.stringify(validator.errors));
}

function asRecord(value: unknown): Record<string, unknown> {
    assert.equal(typeof value, "object");
    assert.notEqual(value, null);
    return value as Record<string, unknown>;
}
