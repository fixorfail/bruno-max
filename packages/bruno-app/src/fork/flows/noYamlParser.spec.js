const fs = require('fs');
const path = require('path');

/**
 * 002-C R4 — **the renderer computes no semantics**, and its structural half: no module under
 * `fork/flows/` imports a YAML parser.
 *
 * A renderer that read `.flow.yml` for itself would be a second reader of a format 001 §5.1 bought
 * exactly one of, and drift between it and the engine is drift between what the app draws and what
 * the CLI runs. It also has to be *taught* the format: 001 §5.4's local tags are part of it, so a
 * plain parser calls every flow carrying a `!file` fixture a syntax error — a failure with no error
 * anywhere and no sign but a graph that stopped following the file.
 *
 * The writing half is the same rule from the other side. `writeFlowProperties` is the format's only
 * writer (001 §5.2), and §4.1c's created document and §4.7's duplicate both go through it, main-side.
 *
 * A structural assertion rather than a behavioural one, because behaviour cannot see this: a
 * renderer-side parser produces correct output for every flow that does not use a tag, right up to
 * the one that does.
 */

const FLOWS_ROOT = path.join(process.cwd(), 'src', 'fork', 'flows');

/**
 * Anything that reads or writes YAML. Named rather than pattern-matched, so adding a parser to
 * `package.json` and importing it here is a decision somebody makes rather than one that slips.
 */
const YAML_PACKAGES = ['js-yaml', 'yaml', 'yaml-js', 'yamljs'];

const modulesUnder = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const pathname = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return modulesUnder(pathname);
    }
    return entry.isFile() && /\.jsx?$/.test(entry.name) ? [pathname] : [];
  });

const importsOf = (pathname) => {
  const source = fs.readFileSync(pathname, 'utf8');
  return [
    ...[...source.matchAll(/^import\s+[^;]*?from\s+'([^']+)';/gm)].map((match) => match[1]),
    ...[...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1])
  ];
};

describe('the renderer has no parser of its own', () => {
  it('imports no YAML library anywhere under fork/flows', () => {
    const offenders = modulesUnder(FLOWS_ROOT)
      .flatMap((pathname) => importsOf(pathname).map((specifier) => ({ pathname, specifier })))
      .filter((entry) => YAML_PACKAGES.includes(entry.specifier));

    expect(offenders).toEqual([]);
  });

  /**
   * The engine is not importable here either, and for a reason of its own: its entry reaches
   * `runFlow` and `@usebruno/js`'s Node sandbox, which has no business in a browser bundle — 002
   * §12.1 records the same refusal about the sidebar's search predicate. Everything the renderer
   * needs from it arrives over §11.3's channels.
   */
  it('reaches the engine over IPC rather than by importing it', () => {
    const bundled = modulesUnder(FLOWS_ROOT).filter((pathname) =>
      importsOf(pathname).includes('@bruno-max/flow')
    );

    expect(bundled).toEqual([]);
  });
});
