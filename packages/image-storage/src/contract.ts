import { defineRpcContract, rpc } from "@harness/rpc";
import { z } from "zod";

export const UploadedImageMeta = z.object({
  id: z.string(),
  mimeType: z.string(),
  filename: z.string().optional(),
  bytes: z.number(),
});
export type UploadedImageMeta = z.infer<typeof UploadedImageMeta>;

export const ImageRpcContract = defineRpcContract("images", {
  upload: rpc.call(
    z.object({ data: z.string(), mimeType: z.string(), filename: z.string().optional() }),
    UploadedImageMeta,
  ),
  read: rpc.call(
    z.object({ id: z.string() }),
    z.object({ data: z.string(), mimeType: z.string() }).nullable(),
  ),
});
