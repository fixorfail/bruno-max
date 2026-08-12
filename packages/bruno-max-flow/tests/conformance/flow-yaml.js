/**
 * Loading a `.flow.yml` the way §5.4 says it resolves.
 *
 * The local tags become values with identity — a class instance and a symbol — never marker
 * objects: a body may legitimately contain any key, so shape cannot be what distinguishes a tag
 * from data. `stringify` round-trips the projected model for the mutation helpers in `harness.js`,
 * and deliberately has no representer for either tag, so a variant that tried to carry one fails
 * loudly rather than emitting a document that no longer means what it did.
 */
const fs = require('fs');
const yaml = require('js-yaml');

const DROP = Symbol('bruno.flow.drop');

class FileRef {
  constructor(data) {
    Object.assign(this, typeof data === 'string' ? { path: data } : data);
  }
}

const SCHEMA = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('!file', { kind: 'scalar', construct: (data) => new FileRef(data) }),
  new yaml.Type('!file', { kind: 'mapping', construct: (data) => new FileRef(data) }),
  new yaml.Type('!...', { kind: 'scalar', construct: () => DROP })
]);

const parse = (text) => yaml.load(text, { schema: SCHEMA });

const load = (file) => parse(fs.readFileSync(file, 'utf8'));

const stringify = (doc) => yaml.dump(doc, { lineWidth: 100, noRefs: true });

module.exports = { DROP, FileRef, SCHEMA, parse, load, stringify };
