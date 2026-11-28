import { effectScope, type EffectScope } from "vue";

export class ForegroundRegistrations {
  private readonly entries = new Set<{ mount(): void; scope?: EffectScope }>();
  private visible = false;

  constructor(private readonly report: (error: unknown) => void) {}

  use(mount: () => void): () => void {
    const entry: { mount(): void; scope?: EffectScope } = { mount };
    this.entries.add(entry);
    try {
      this.update(entry);
    } catch (error) {
      this.entries.delete(entry);
      throw error;
    }
    return () => {
      this.entries.delete(entry);
      entry.scope?.stop();
    };
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    for (const entry of this.entries) {
      try {
        this.update(entry);
      } catch (error) {
        this.report(error);
      }
    }
  }

  private update(entry: { mount(): void; scope?: EffectScope }): void {
    if (this.visible) {
      const scope = effectScope(true);
      try {
        scope.run(entry.mount);
        entry.scope = scope;
      } catch (error) {
        scope.stop();
        throw error;
      }
    } else {
      entry.scope?.stop();
      entry.scope = undefined;
    }
  }
}
