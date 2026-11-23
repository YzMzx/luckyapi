import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { isAdminRequest } from "../auth";
import {
  readSevenPickImage,
  saveSevenPickImage,
  SevenPickImageError,
  SEVEN_PICK_IMAGE_MAX_BYTES,
} from "../seven-pick/images";

// Reserve bounded space for the multipart envelope separately from the file cap.
const MAX_REQUEST_BYTES = SEVEN_PICK_IMAGE_MAX_BYTES + 16 * 1024;

export function createSevenPickImagesApp(options: { directory?: string } = {}) {
  const app = new Hono();

  app.post(
    "/upload",
    async (c, next) => {
      if (!(await isAdminRequest(c.req.raw))) {
        return c.json({ error: "需要管理员登录" }, 401);
      }
      await next();
    },
    csrf(),
    bodyLimit({
      maxSize: MAX_REQUEST_BYTES,
      onError: (c) => c.json({ error: "图片不得超过 2 MiB" }, 413),
    }),
    async (c) => {
      if (!/^multipart\/form-data(?:\s*;|$)/i.test(c.req.header("Content-Type") ?? "")) {
        return c.json({ error: "请通过表单上传图片" }, 415);
      }
      let fields: FormData;
      try {
        fields = await c.req.formData();
      } catch {
        return c.json({ error: "无法读取图片表单" }, 400);
      }
      const files = fields.getAll("file");
      if (files.length !== 1 || !(files[0] instanceof File) || !files[0].size) {
        return c.json({ error: "请选择一张图片" }, 400);
      }
      const file = files[0];
      if (file.size > SEVEN_PICK_IMAGE_MAX_BYTES) {
        return c.json({ error: "图片不得超过 2 MiB" }, 413);
      }
      try {
        const saved = await saveSevenPickImage(Buffer.from(await file.arrayBuffer()), options.directory);
        return c.json(saved, 201);
      } catch (error) {
        if (error instanceof SevenPickImageError) return c.json({ error: error.message }, error.status);
        throw error;
      }
    },
  );

  app.get("/:fileName", async (c) => {
    const image = await readSevenPickImage(c.req.param("fileName"), options.directory);
    if (!image) return c.json({ error: "图片不存在" }, 404);
    return c.body(new Uint8Array(image.bytes), 200, {
      "Content-Type": image.contentType,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  });

  app.onError((error, c) => {
    if (error instanceof HTTPException && error.status === 403) {
      return c.json({ error: "仅允许从本站管理后台上传" }, 403);
    }
    console.error("Seven Pick image route failed", error);
    return c.json({ error: "图片服务暂不可用" }, 500);
  });
  return app;
}

export const sevenPickImagesApp = createSevenPickImagesApp();
