import { shallowRef, type ShallowRef } from "reactivity";

export interface ModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoning?: boolean | string;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export class ModelSelectionService {
  readonly #current: ShallowRef<ModelSelection>;

  constructor(initial: ModelSelection = { provider: "", model: "" }) {
    this.#current = shallowRef(initial);
  }

  get current(): ModelSelection {
    return this.#current.value;
  }

  set current(selection: ModelSelection) {
    this.#current.value = selection;
  }

  select(selection: ModelSelection): void {
    this.#current.value = selection;
  }
}
