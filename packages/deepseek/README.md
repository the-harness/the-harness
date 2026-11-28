```ts
useDeepSeekProvider(options?: DeepSeekProviderOptions): void // 在 ProviderManager 下创建完整的 DeepSeek Provider 子 Scope（集成 Auth、LlmProvider、FileService、Web、TTS、ASR、OCR），随当前 EffectScope 释放

class DeepSeekLlmProvider extends LlmProvider implements WebSearchProvider {
  readonly options: DeepSeekLlmProviderOptions;
  override readonly models: readonly LlmModelInfo[];
  constructor(options?: DeepSeekLlmProviderOptions);
  refreshCatalog(signal?: AbortSignal): Promise<readonly LlmModelInfo[]>; // 从 DeepSeek GET /models 动态拉取并响应式合并模型列表
  override stream(request: LlmRequest): LlmStream; // 支持 Messages 协议、思考档位与 Files API 自动上传与降级
  webSearch(request: WebSearchRequest): Promise<readonly WebSearchResultItem[]>; // 调用 DeepSeek POST /v1/tools/search
}

class DeepSeekFileService extends FileService {
  readonly options: DeepSeekFileServiceOptions;
  constructor(options?: DeepSeekFileServiceOptions);
  invalidate(fileId: string): void;
  override upload(request: FileUploadRequest, waitOptions?: WaitReadyOptions): Promise<RemoteFileHandle>; // 支持 user_data / text_recognition / rich_layout_recognition、SHA-256 缓存复用与配额回收
  override get(fileId: string, signal?: AbortSignal): Promise<RemoteFileHandle>;
  override delete(fileId: string, signal?: AbortSignal): Promise<void>;
}

class DeepSeekWebService {
  readonly options: DeepSeekWebServiceOptions;
  constructor(options?: DeepSeekWebServiceOptions);
  search(request: DeepSeekSearchRequest): Promise<readonly DeepSeekSearchResultItem[]>; // 支持 POST /v1/tools/search 与 Messages web_search_20250305 双模式搜索
  fetch(url: string, signal?: AbortSignal): Promise<DeepSeekFetchResult>; // 调用 POST /v1/tools/fetch 获取页面 Markdown
}

class DeepSeekTtsService {
  readonly options: DeepSeekToolsOptions;
  constructor(options?: DeepSeekToolsOptions);
  synthesize(request: DeepSeekTtsRequest): Promise<ReadableStream<Uint8Array>>; // 调用 POST /v1/tools/tts 流式语音合成
}

class DeepSeekAsrService {
  readonly options: DeepSeekToolsOptions;
  constructor(options?: DeepSeekToolsOptions);
  transcribe(request: DeepSeekAsrRequest): Promise<DeepSeekAsrResult>; // 调用 POST /v1/tools/asr 语音转写
}

class DeepSeekOcrService {
  readonly options: DeepSeekToolsOptions;
  constructor(options?: DeepSeekToolsOptions);
  recognize(request: DeepSeekOcrRequest): Promise<DeepSeekOcrResult>; // 调用 POST /v1/tools/ocr 文档识别
}
```
