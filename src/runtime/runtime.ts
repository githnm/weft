import { SingleConnectionRuntime } from "@malloydata/malloy";
import type { Connection } from "@malloydata/malloy";

export function createRuntime<C extends Connection>(connection: C): SingleConnectionRuntime<C> {
  return new SingleConnectionRuntime({ connection });
}
