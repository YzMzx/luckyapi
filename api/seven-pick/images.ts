import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";

export const SEVEN_PICK_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const SEVEN_PICK_IMAGES_PATH = "/seven-pick-images";
// Compressed images may have a small file size but need a large decode buffer.
const MAX_INPUT_PIXELS = 4096 * 4096;
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/;
const IMAGE_FORMATS = {
  jpeg: { extension: "jpg", contentType: "image/jpeg" },
  png: { extension: "png", contentType: "image/png" },
  webp: { extension: "webp", contentType: "image/webp" },
} as const;
type Format = keyof typeof IMAGE_FORMATS;

export class SevenPickImageError extends Error {
  readonly status: 400 | 413 | 415;

  constructor(status: SevenPickImageError["status"], message: string) {
    super(message);
    this.name = "SevenPickImageError";
    this.status = status;
  }
}

export function sevenPickImagesDirectory() {
  return resolve(process.env.SEVEN_PICK_IMAGES_DIR?.trim() || "data/seven-pick-images");
}

function detectFormat(bytes: Buffer): Format | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)) return "png";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
}

async function normalizeImage(bytes: Buffer, format: Format) {
  try {
    // Read dimensions without decoding any pixels, then enforce the limit again in the decoder.
    const metadata = await sharp(bytes, { failOn: "warning", limitInputPixels: false }).metadata();
    if (metadata.format !== format || !metadata.width || !metadata.height) {
      throw new SevenPickImageError(415, "无法识别图片格式");
    }
    if ((metadata.pages ?? 1) !== 1) {
      throw new SevenPickImageError(415, "仅支持单帧 JPEG、PNG 和 WebP 图片");
    }
    if (metadata.width * metadata.height > MAX_INPUT_PIXELS) {
      throw new SevenPickImageError(413, "图片像素过多");
    }
    // Decode and re-encode; Sharp drops metadata by default. Apply orientation first.
    return await sharp(bytes, { failOn: "warning", limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .toFormat(format)
      .toBuffer();
  } catch (error) {
    if (error instanceof SevenPickImageError) throw error;
    throw new SevenPickImageError(400, "图片无法解码或尺寸过大");
  }
}

export async function saveSevenPickImage(bytes: Buffer, directory = sevenPickImagesDirectory()) {
  if (bytes.length > SEVEN_PICK_IMAGE_MAX_BYTES) throw new SevenPickImageError(413, "图片不得超过 2 MiB");
  const format = detectFormat(bytes);
  if (!format) throw new SevenPickImageError(415, "仅支持 JPEG、PNG 和 WebP 图片");
  const normalized = await normalizeImage(bytes, format);
  if (normalized.length > SEVEN_PICK_IMAGE_MAX_BYTES) {
    throw new SevenPickImageError(413, "重新编码后的图片超过 2 MiB");
  }

  await mkdir(directory, { recursive: true });
  const fileName = randomUUID() + "." + IMAGE_FORMATS[format].extension;
  const temporary = join(directory, "." + fileName + ".upload");
  // Publish the complete file atomically and fail rather than overwrite on a collision.
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(normalized);
      await file.sync();
    } finally {
      await file.close();
    }
    await link(temporary, join(directory, fileName));
  } finally {
    await unlink(temporary);
  }
  return { imageUrl: SEVEN_PICK_IMAGES_PATH + "/" + fileName };
}

export async function readSevenPickImage(fileName: string, directory = sevenPickImagesDirectory()) {
  const match = IMAGE_FILE_NAME.exec(fileName);
  if (!match || match[0] !== fileName) return null;
  const path = join(directory, fileName);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size < 1 || stat.size > SEVEN_PICK_IMAGE_MAX_BYTES) return null;
    const bytes = await readFile(path);
    const format = detectFormat(bytes);
    if (!format || IMAGE_FORMATS[format].extension !== match[1]) return null;
    return { bytes, contentType: IMAGE_FORMATS[format].contentType };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
