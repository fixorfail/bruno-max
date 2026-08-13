/**
 * Loading a `.flow.yml` the way §5.4 says it resolves.
 *
 * The local tags become values with identity — a class instance and a symbol — never marker
 * objects: a body may legitimately contain any key, so shape cannot be what distinguishes a tag
 * from data. `stringify` round-trips the projected model for the mutation helpers in `harness.js`,
 * and deliberately has no representer for either tag, so a variant that tried to carry one fails
 * loudly rather than emitting a document that no longer means what it did.
 *
 * This is a second reader of the format on purpose — it is what the fixture corpus is checked
 * *against* — so it stays a plain parse with no positions rather than sharing `document.ts`.
 */
const fs = require('fs');
const YAML = require('yaml');

const DROP = Symbol('bruno.flow.drop');

class FileRef {
  constructor(data) {
    Object.assign(this, typeof data === 'string' ? { path: data } : data);
  }
}

const TAGS = [
  { tag: '!file', collection: 'map', resolve: (map) => new FileRef(map.toJSON()) },
  { tag: '!file', resolve: (value) => new FileRef(value) },
  { tag: '!...', resolve: () => DROP }
];

const parse = (text) => YAML.parse(text, { merge: true, customTags: TAGS });

const load = (file) => parse(fs.readFileSync(file, 'utf8'));

const stringify = (doc) => YAML.stringify(doc, { lineWidth: 100, aliasDuplicateObjects: false });

module.exports = { DROP, FileRef, TAGS, parse, load, stringify };
