import { expect, it } from "vite-plus/test";
import { createIdempotentArbiter } from "../../packages/gateway/src/index.ts";

it("preserves a replacement claim when the previous attempt rejects", async () => {
  const arbiter = createIdempotentArbiter();
  const releasedWork = Promise.withResolvers<string>();
  const replacementWork = Promise.withResolvers<string>();
  const first = arbiter.claim("approval", () => releasedWork.promise);
  arbiter.release("approval");
  const replacement = arbiter.claim("approval", () => replacementWork.promise);

  try {
    const error = new Error("the released attempt failed");
    releasedWork.reject(error);
    await expect(first).rejects.toBe(error);

    await expect(arbiter.claim("approval", () => "duplicate")).resolves.toEqual({ claimed: false });
  } finally {
    replacementWork.resolve("current");
    await replacement;
  }
  await expect(replacement).resolves.toEqual({ claimed: true, result: "current" });
});
