import { HmrCircle } from "./shape.ts";

// Uses the class other than as a DI identity, so replacing it re-evaluates this module.
(globalThis as { __hmrClientCircle?: typeof HmrCircle }).__hmrClientCircle = HmrCircle;

export const published = true;
