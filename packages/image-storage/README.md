```ts
class ImageStorageService {
  save(buffer: Buffer, mimeType: string, filename?: string): UploadedImageMeta; // 同步受理按 SHA-256 去重的图片附件
  read(id: string): Promise<{ readonly data: Buffer; readonly mimeType: string } | null>; // 读取图片二进制与 MIME
  readBase64(id: string): Promise<{ readonly data: string; readonly mimeType: string } | null>; // 读取 base64 编码图片
}

function useImageHandlers(): void; // 注册 ImageRpcContract 的服务端 handler

// @harness/image-storage/contract
const ImageRpcContract: RpcContract<{
  upload: (input: { data: string; mimeType: string; filename?: string }) => UploadedImageMeta; // data 为 base64
  read: (input: { id: string }) => { data: string; mimeType: string } | null; // data 为 base64
}>;
```
