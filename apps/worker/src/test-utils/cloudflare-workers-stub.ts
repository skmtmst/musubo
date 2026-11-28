// Node-based Worker tests can supply bindings without loading the Workers runtime.
export const env: Record<string, string | undefined> = {};

export abstract class WorkflowEntrypoint<Bindings = unknown> {
  constructor(protected ctx: ExecutionContext, protected env: Bindings) {}
}
