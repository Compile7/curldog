import { DurableObject } from "cloudflare:workers";
import { runCheck, type Checkable } from "./check.ts";

// Runs a check from wherever this object lives. One object per region, placed with a location hint.
export class Prober extends DurableObject {
  check(m: Checkable) {
    return runCheck(m);
  }
}
