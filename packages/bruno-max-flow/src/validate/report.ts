/**
 * Where a diagnostic lands — 001 §14.3, 002 §6.
 *
 * Every check in this directory reports through one of these, so a diagnostic is anchored the same
 * way whoever raised it: to the step it names, or to an explicit node for the checks no step owns.
 * 002 §6 puts them in the gutter of the document view, so one without a line has nowhere to land.
 */
import type { NormalizedFlow } from '../document';
import type { Diagnostic } from '../types/result';

export type Report = {
  error: (code: string, message: string, stepId?: string, node?: (string | number)[]) => void;
  warn: (code: string, message: string, stepId?: string, node?: (string | number)[]) => void;
  /** What has been reported so far, in the order it was raised. */
  diagnostics: Diagnostic[];
};

export const createReport = (flow: NormalizedFlow): Report => {
  const diagnostics: Diagnostic[] = [];

  const at = (stepId?: string, node?: (string | number)[]) => {
    if (node) return flow.positions.at(node);
    return stepId === undefined ? undefined : flow.steps.find((step) => step.id === stepId)?.position;
  };

  const report = (
    severity: Diagnostic['severity'],
    code: string,
    message: string,
    stepId?: string,
    node?: (string | number)[]
  ) => {
    diagnostics.push({ severity, code, message, file: flow.file, stepId, ...at(stepId, node) });
  };

  return {
    diagnostics,
    error: (code, message, stepId, node) => report('error', code, message, stepId, node),
    warn: (code, message, stepId, node) => report('warning', code, message, stepId, node)
  };
};

/**
 * The nearest candidate to a name that missed, for the did-you-mean §14.3 asks every naming check to
 * carry.
 *
 * The bound is a third of the longer name — proportional rather than fixed, because two characters
 * out of `id` is a different claim from two out of `secretAccessKey`. Beyond it a suggestion names
 * something the author was not trying to write, which is worse than none: it sends them to check a
 * field that was never involved.
 */
export const nearest = (name: string, candidates: string[]): string | undefined => {
  const distance = (from: string, to: string): number => {
    const previous = Array.from({ length: to.length + 1 }, (unused, index) => index);
    for (let row = 1; row <= from.length; row += 1) {
      let diagonal = previous[0];
      previous[0] = row;
      for (let column = 1; column <= to.length; column += 1) {
        const carried = previous[column];
        previous[column] = Math.min(
          previous[column] + 1,
          previous[column - 1] + 1,
          diagonal + (from[row - 1] === to[column - 1] ? 0 : 1)
        );
        diagonal = carried;
      }
    }
    return previous[to.length];
  };

  const lowered = name.toLowerCase();
  const scored = candidates
    .map((candidate) => ({ candidate, score: distance(lowered, candidate.toLowerCase()) }))
    .filter(({ candidate, score }) => score <= Math.max(2, Math.ceil(Math.max(name.length, candidate.length) / 3)))
    .sort((left, right) => left.score - right.score);

  return scored.length ? scored[0].candidate : undefined;
};

/** `x is not a field — did you mean y?`, with the suggestion left off when there is no near miss. */
export const suggest = (name: string, candidates: string[]): string => {
  const found = nearest(name, candidates);
  return found ? ` — did you mean ${found}?` : '';
};
