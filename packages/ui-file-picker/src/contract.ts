import { defineRpcContract, rpc } from "@harness/rpc";
import { z } from "zod";

export const FilePickerEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "directory"]),
  hidden: z.boolean().optional(),
});

export type FilePickerEntry = z.infer<typeof FilePickerEntrySchema>;

export const FilePickerListingSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  home: z.string(),
  separator: z.string(),
  entries: z.array(FilePickerEntrySchema),
  truncated: z.boolean(),
});

export type FilePickerListing = z.infer<typeof FilePickerListingSchema>;

export const FilePickerRpcContract = defineRpcContract("file-picker", {
  list: rpc.call(
    z.object({
      path: z.string().optional(),
      includeFiles: z.boolean().optional(),
      includeHidden: z.boolean().optional(),
    }),
    FilePickerListingSchema,
  ),
  createDirectory: rpc.call(
    z.object({
      parentPath: z.string(),
      name: z.string(),
    }),
    z.object({ path: z.string() }),
  ),
  resolveSavePath: rpc.call(
    z.object({ directory: z.string().min(1), name: z.string().min(1) }),
    z.object({ path: z.string(), exists: z.boolean() }),
  ),
});
