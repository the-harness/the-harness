const canonicalVersions = new WeakMap<Function, Function>();
const latestVersions = new WeakMap<Function, Function>();
let evaluating: ModuleEvaluation | undefined;
// Registry writes made while a hot update evaluates, applied only together with that update.
const stagedEffects = new Map<
  string,
  { readonly evaluation: ModuleEvaluation; readonly effects: Array<() => () => void> }
>();
const moduleUpdateEffects = new Map<string, (evaluation: ModuleEvaluation) => () => void>();
// The latest evaluation of each module, unless it threw.
const liveEvaluations = new Map<string, ModuleEvaluation>();

export function relateClassVersions(prev: Function, next: Function): void {
  if (prev === next) return;
  const canonical = canonicalClass(prev);
  if (canonicalClass(next) !== canonical) canonicalVersions.set(next, canonical);
}

export function registerClassVersion(prev: Function, next: Function): void {
  if (prev === next) return;
  relateClassVersions(prev, next);
  latestVersions.set(canonicalClass(prev), next);
}

export function canonicalClass<T extends Function>(ctor: T): T {
  return (canonicalVersions.get(ctor) as T | undefined) ?? ctor;
}

// The applied version of a class family; versions that were evaluated but never applied (e.g. a
// class kept as is, or an update that failed) resolve to it as well.
export function latestClass<T extends Function>(ctor: T): T {
  const canonical = canonicalClass(ctor);
  return (latestVersions.get(canonical) as T | undefined) ?? canonical;
}

/** One evaluation of a module body; each evaluation is a distinct object. */
export interface ModuleEvaluation {
  readonly module: string;
}

export function beginModuleEvaluation(id: string, update = false): void {
  const evaluation: ModuleEvaluation = { module: id };
  evaluating = evaluation;
  liveEvaluations.set(id, evaluation);
  if (update) stagedEffects.set(id, { evaluation, effects: [] });
  else stagedEffects.delete(id);
  // Instrumented modules have no top-level await: this runs once the body finished or threw.
  queueMicrotask(() => {
    if (evaluating !== evaluation) return;
    // The body threw before reaching endModuleEvaluation.
    evaluating = undefined;
    if (liveEvaluations.get(id) === evaluation) liveEvaluations.delete(id);
  });
}

export function endModuleEvaluation(id: string): void {
  if (evaluating?.module === id) evaluating = undefined;
}

export function currentModuleEvaluation(): ModuleEvaluation | undefined {
  return evaluating;
}

/** Whether `evaluation` is the latest evaluation of its module and did not throw. */
export function isLiveModuleEvaluation(evaluation: ModuleEvaluation): boolean {
  return liveEvaluations.get(evaluation.module) === evaluation;
}

/** Runs `apply` now, or stages it until the hot update being evaluated is applied; `apply` returns its undo. */
export function applyWithModuleUpdate(apply: () => () => void): void {
  const staged = evaluating === undefined ? undefined : stagedEffects.get(evaluating.module);
  if (staged === undefined) apply();
  else staged.effects.push(apply);
}

/** Adds `effect` to the staged effects of every module evaluation; a later effect with the same key replaces it. */
export function registerModuleUpdateEffect(
  key: string,
  effect: (evaluation: ModuleEvaluation) => () => void,
): void {
  moduleUpdateEffects.set(key, effect);
}

/** The effects staged by the evaluation of `id` that just completed; each returns its undo. */
export function takeModuleUpdateEffects(id: string): Array<() => () => void> {
  const staged = stagedEffects.get(id);
  if (staged === undefined) return [];
  stagedEffects.delete(id);
  const { evaluation, effects } = staged;
  return [...effects, ...[...moduleUpdateEffects.values()].map((effect) => () => effect(evaluation))];
}
