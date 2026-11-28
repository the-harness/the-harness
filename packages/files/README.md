```ts
abstract class FileService {
  abstract upload(
    request: FileUploadRequest,
    waitOptions?: WaitReadyOptions,
  ): Promise<RemoteFileHandle>;
  abstract get(fileId: string, signal?: AbortSignal): Promise<RemoteFileHandle>;
  abstract delete(fileId: string, signal?: AbortSignal): Promise<void>;
}

class HttpFileService extends FileService {
  readonly options: HttpFileServiceOptions;
  constructor(options: HttpFileServiceOptions);
  override upload(
    request: FileUploadRequest,
    waitOptions?: WaitReadyOptions,
  ): Promise<RemoteFileHandle>; // 通过当前 Scope 的 AuthService 鉴权上传文件，并在处于 processing 状态时自动轮询至 ready
  override get(fileId: string, signal?: AbortSignal): Promise<RemoteFileHandle>;
  override delete(fileId: string, signal?: AbortSignal): Promise<void>;
}
```
