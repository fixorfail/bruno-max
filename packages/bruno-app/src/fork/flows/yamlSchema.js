import yaml from 'js-yaml';

/**
 * 001 §5.4's local tags, taught to the renderer's own YAML parser.
 *
 * **This is a second reader of the format, and it exists because the first one cannot run here.**
 * The engine parses `.flow.yml` for every other purpose, but it is a Node package (001 §13.1) and
 * the renderer cannot import it — so §4.3's editor, which only ever asks *is this a document at
 * all*, answers that question with `js-yaml` instead.
 *
 * Without the tags the answer is wrong in the one direction that matters: a plain parser rejects
 * `!file` as an unknown tag, so a flow using 001 §7.4's fixtures reads as invalid YAML, the graph
 * stops following the draft, and auto-save is disarmed on a document the CLI validates happily.
 *
 * The constructors are deliberately identity-ish. Nothing here interprets a tag — `!file` resolves
 * to whatever was written and `!...` to nothing — because the value never leaves this check. What
 * a tag *means* stays in `document.ts`, which is the only place that has to know.
 */
const fileTag = (kind) => new yaml.Type('!file', { kind, resolve: () => true, construct: (data) => data });

export const FLOW_YAML_SCHEMA = yaml.DEFAULT_SCHEMA.extend([
  // Both spellings §5.4 gives it: a path on its own, and the mapping form carrying a filename and
  // content type.
  fileTag('scalar'),
  fileTag('mapping'),
  new yaml.Type('!...', { kind: 'scalar', resolve: () => true, construct: () => undefined })
]);
