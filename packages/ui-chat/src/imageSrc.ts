import type { MediaBlock } from "@harness/llm";
import { ImageRpcContract } from "@harness/image-storage/contract";
import { RpcClientService } from "@harness/rpc";
import { useService } from "@harness/ui-di";
import { onScopeDispose, reactive } from "vue";

export function useImageSrc(
  onUnavailable?: (id: string) => void,
): (image: MediaBlock) => string | undefined {
  const images = useService(RpcClientService).use(ImageRpcContract);
  const urls = reactive(new Map<string, string>());
  const pendingReads = new Set<string>();
  const lifetime = new AbortController();
  const { signal } = lifetime;
  onScopeDispose(() => {
    lifetime.abort();
    for (const url of urls.values()) URL.revokeObjectURL(url);
  });

  async function load(id: string): Promise<void> {
    const image = await images.read({ id }, signal);
    if (signal.aborted) return;
    if (!image) {
      onUnavailable?.(id);
      return;
    }
    const response = await fetch(`data:${image.mimeType};base64,${image.data}`, { signal });
    const blob = await response.blob();
    if (!signal.aborted) urls.set(id, URL.createObjectURL(blob));
  }

  return (image) => {
    if (signal.aborted) return undefined;
    if (image.data) return `data:${image.mimeType};base64,${image.data}`;
    const id = image.fileId;
    if (!id) return undefined;
    const cached = urls.get(id);
    if (cached !== undefined) return cached;
    if (!pendingReads.has(id)) {
      pendingReads.add(id);
      void load(id)
        .catch(() => {
          if (!signal.aborted) onUnavailable?.(id);
        })
        .finally(() => pendingReads.delete(id));
    }
    return undefined;
  };
}

export function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve((reader.result as string).slice((reader.result as string).indexOf(",") + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
