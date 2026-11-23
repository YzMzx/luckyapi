import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ADMIN_COOKIE, createAdminSession } from "../auth";
import { SEVEN_PICK_IMAGE_MAX_BYTES, SEVEN_PICK_IMAGES_PATH } from "../seven-pick/images";
import { createSevenPickImagesApp } from "./sevenPickImages";

const SITE_ORIGIN = "https://lucky.test";
const UPLOAD_URL = SITE_ORIGIN + SEVEN_PICK_IMAGES_PATH + "/upload";
const source = () => sharp({ create: { width: 2, height: 3, channels: 3, background: "#e69a4e" } });
const mount = () => new Hono().route(SEVEN_PICK_IMAGES_PATH, createSevenPickImagesApp());
let directory: string;
let adminToken: string;
let app: ReturnType<typeof mount>;

beforeAll(async () => {
  vi.stubEnv("SQLITE_PATH", ":memory:");
  directory = await mkdtemp(join(tmpdir(), "seven-pick-images-"));
  vi.stubEnv("SEVEN_PICK_IMAGES_DIR", directory);
  adminToken = await createAdminSession();
  app = mount();
});

afterAll(async () => {
  if (directory) await rm(directory, { force: true, recursive: true });
  vi.unstubAllEnvs();
});

function formFor(bytes: Buffer, mime = "application/octet-stream") {
  const fields = new FormData();
  fields.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), "untrusted-name.svg");
  return fields;
}

function upload(fields: FormData, options: { cookie?: string; origin?: string } = {}) {
  return app.request(UPLOAD_URL, {
    method: "POST",
    body: fields,
    headers: {
      cookie: options.cookie ?? ADMIN_COOKIE + "=" + adminToken,
      origin: options.origin ?? SITE_ORIGIN,
    },
  });
}

it("enforces the existing admin session and rejects uploads from other origins", async () => {
  const input = await source().png().toBuffer();
  expect((await upload(formFor(input), { cookie: "" })).status).toBe(401);
  expect((await upload(formFor(input), { cookie: "ld_session=unknown" })).status).toBe(401);
  expect((await upload(formFor(input), { origin: "https://evil.lucky.test" })).status).toBe(403);
  expect(await readdir(directory)).toEqual([]);
});

it.each([
  ["jpeg", "jpg"], ["png", "png"], ["webp", "webp"],
] as const)("normalizes actual %s bytes, ignores spoofed filename and MIME, and persists immutable output", async (format, ext) => {
  const input = await source().withMetadata({ orientation: 6 }).toFormat(format).toBuffer();
  const metadata = await sharp(input).metadata();
  expect(metadata.exif).toBeDefined();
  const first = await upload(formFor(input, "image/svg+xml"));
  const second = await upload(formFor(input));
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  const firstUrl = (await first.json() as { imageUrl: string }).imageUrl;
  const secondUrl = (await second.json() as { imageUrl: string }).imageUrl;
  expect(firstUrl).toMatch(/^\/seven-pick-images\/[a-f0-9-]{36}\./);
  expect(firstUrl.endsWith("." + ext)).toBe(true);
  expect(secondUrl).not.toBe(firstUrl);

  // Public retrieval survives reconstructing the app from its persistent folder.
  const fetched = await mount().request(SITE_ORIGIN + firstUrl);
  expect(fetched.status).toBe(200);
  expect(fetched.headers.get("Content-Type")).toBe("image/" + format);
  expect(fetched.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(fetched.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  const clean = await sharp(Buffer.from(await fetched.arrayBuffer())).metadata();
  expect(clean).toMatchObject({ format, width: 3, height: 2 });
  expect(clean.exif).toBeUndefined();
  expect(clean.orientation).toBeUndefined();
  expect(clean.icc).toBeUndefined();
  expect((await readdir(directory)).some((name) => name.endsWith(".upload"))).toBe(false);
});

it("rejects unsupported, malformed, oversized, and excessive-pixel images without writing files", async () => {
  const before = await readdir(directory);
  expect((await upload(formFor(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/png"))).status).toBe(415);
  expect((await upload(formFor(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 10]), "image/jpeg"))).status).toBe(400);
  expect((await upload(formFor(Buffer.alloc(SEVEN_PICK_IMAGE_MAX_BYTES + 1)))).status).toBe(413);
  expect((await upload(formFor(Buffer.alloc(SEVEN_PICK_IMAGE_MAX_BYTES + 32 * 1024)))).status).toBe(413);
  const manyPixels = await sharp({ create: { width: 4097, height: 4096, channels: 3, background: "#000" } }).png().toBuffer();
  expect(manyPixels.length).toBeLessThan(SEVEN_PICK_IMAGE_MAX_BYTES);
  expect((await upload(formFor(manyPixels))).status).toBe(413);
  expect(await readdir(directory)).toEqual(before);
});

it("rejects remote URL and ambiguous multipart values, and contains public file paths", async () => {
  const fields = new FormData();
  fields.append("file", "https://example.test/remote.png");
  expect((await upload(fields)).status).toBe(400);
  fields.append("file", new Blob([new Uint8Array(await source().png().toBuffer())]), "real.png");
  expect((await upload(fields)).status).toBe(400);
  expect((await app.request(SITE_ORIGIN + SEVEN_PICK_IMAGES_PATH + "/" + encodeURIComponent("../secret.png"))).status).toBe(404);
  const namedDirectory = randomUUID() + ".png";
  await mkdir(join(directory, namedDirectory));
  expect((await app.request(SITE_ORIGIN + SEVEN_PICK_IMAGES_PATH + "/" + namedDirectory)).status).toBe(404);
  const hidden = randomUUID() + "x.png";
  await writeFile(join(directory, hidden), await source().png().toBuffer());
  expect((await app.request(SITE_ORIGIN + SEVEN_PICK_IMAGES_PATH + "/" + hidden)).status).toBe(404);
  const servedHtml = randomUUID() + ".png";
  await writeFile(join(directory, servedHtml), "<b>unexpected</b>");
  expect((await app.request(SITE_ORIGIN + SEVEN_PICK_IMAGES_PATH + "/" + servedHtml)).status).toBe(404);
});
