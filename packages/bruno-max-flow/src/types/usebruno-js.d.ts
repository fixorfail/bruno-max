/**
 * `@usebruno/js` ships no declarations, and the engine reaches past its index deliberately: the
 * package entry loads the QuickJS runtime at import time, while these two helpers compile a plain
 * function and are what §10.2 names as the operand rule. Declaring the deep path here keeps the
 * import typed without adding a runtime dependency on a sandbox the engine must not choose (§8.2).
 */
declare module '@usebruno/js/src/utils' {
  export function evaluateJsExpression(expression: string, context: Record<string, unknown>): unknown;
  export function evaluateJsTemplateLiteral(literal: string, context: Record<string, unknown>): unknown;
}
