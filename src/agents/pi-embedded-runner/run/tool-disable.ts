import { supportsModelTools } from "../../model-tool-support.js";

export function shouldDisableToolsForAttempt(params: {
  requestedDisableTools?: boolean;
  retryDisableTools?: boolean;
  model: { compat?: unknown };
}): boolean {
  return (
    params.requestedDisableTools === true ||
    params.retryDisableTools === true ||
    !supportsModelTools(params.model)
  );
}
