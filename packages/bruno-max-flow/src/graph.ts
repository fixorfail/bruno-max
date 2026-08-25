/**
 * What the resolved DAG looks like, for the two readers that must agree about it.
 *
 * `describe.ts` places a node by its rank and `validate.ts` decides whether a stage rule (§5.5) can
 * be drawn at a rank at all. A drawing that showed a boundary the validator did not warn about — or
 * the reverse — would be worse than either alone, so each rule is implemented once, here.
 */
import type { NormalizedFlow, NormalizedStep } from './document';

/**
 * Longest path from a root (002 §5.2), which is what places a step below *every* one of its
 * dependencies rather than just the first — the property that makes the drawing readable as
 * execution order. A cycle cannot deepen a rank forever because a step already on the path is
 * skipped; `validateFlow` reports the cycle separately.
 */
export const ranksOf = (steps: NormalizedStep[]): Map<string, number> => {
  const parents = new Map(steps.map((step) => [step.id, step.depends.entries.map((entry) => entry.on)]));
  const ranks = new Map<string, number>();

  const rankOf = (id: string, seen: Set<string>): number => {
    const cached = ranks.get(id);
    if (cached !== undefined) return cached;

    const above = (parents.get(id) || [])
      .filter((parent) => !seen.has(parent) && parents.has(parent))
      .map((parent) => rankOf(parent, new Set([...seen, parent])) + 1);
    const rank = above.length ? Math.max(...above) : 0;
    ranks.set(id, rank);
    return rank;
  };

  for (const step of steps) rankOf(step.id, new Set([step.id]));
  return ranks;
};

/** A boundary that can be drawn, at the rank whose column the rule goes in front of. */
export type ResolvedStage = { name: string; from: string; rank: number };

export type StageProblem = { code: string; message: string; stage: string };

/**
 * §5.5's boundaries, split into the ones a graph can draw and the ones it cannot.
 *
 * A stage names only its first step, so it covers the run of the step list up to the next boundary.
 * That draws as a vertical rule exactly when everything the file lists above the boundary also
 * *runs* before it: a step declared earlier but ranked level with the boundary shares its column,
 * and no line can pass between them. Where that fails the rule is dropped rather than drawn through
 * the middle of a column — a tidy picture of an order the run does not have is worse than no
 * picture — and the same pass produces the warning saying which step crossed it (§14.3).
 *
 * Every problem here is a warning, never an error, for §6.2's reason: this decides how a graph is
 * drawn and never what a flow does.
 */
export const resolveStages = (
  flow: NormalizedFlow,
  ranks: Map<string, number>
): { stages: ResolvedStage[]; problems: StageProblem[] } => {
  const order = new Map(flow.steps.map((step, index) => [step.id, index]));
  const stages: ResolvedStage[] = [];
  const problems: StageProblem[] = [];
  let previous: { name: string; from: string; index: number } | undefined;

  for (const stage of flow.stages) {
    const index = order.get(stage.from);
    if (index === undefined) {
      problems.push({
        code: 'unknown-stage-step',
        message: `${stage.name} begins at ${stage.from}, which is not a step`,
        stage: stage.name
      });
      continue;
    }

    // Boundaries carve one list into consecutive runs, so a stage beginning at or above the one
    // before it describes no run of steps at all — including the case of two stages naming the
    // same step, where the earlier of them would cover nothing.
    if (previous && index <= previous.index) {
      problems.push({
        code: 'stage-boundary-order',
        message: `${stage.name} begins at ${stage.from}, which does not come after ${previous.from}, where ${previous.name} begins`,
        stage: stage.name
      });
      continue;
    }

    const rank = ranks.get(stage.from) as number;
    const crossing = flow.steps.slice(0, index).find((step) => (ranks.get(step.id) as number) >= rank);
    if (crossing) {
      problems.push({
        code: 'stage-out-of-order',
        message: `${stage.name} cannot be drawn at ${stage.from}, because ${crossing.id} is listed above it but does not run before it`,
        stage: stage.name
      });
      continue;
    }

    stages.push({ name: stage.name, from: stage.from, rank });
    previous = { name: stage.name, from: stage.from, index };
  }

  return { stages, problems };
};
