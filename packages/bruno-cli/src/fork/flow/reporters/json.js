/**
 * JSON reporter — 001 §14.1, the loader's `ReporterFactory` contract (`@bruno-max/flow`'s
 * `reporter.ts`).
 *
 * The suite is exactly the engine's `SuiteResult`, pretty-printed, with a format marker in front
 * so a consumer can tell a `bruno-flow-suite` file from any other JSON on disk before parsing the
 * rest of it — and can evolve the shape later behind `formatVersion` without breaking readers that
 * check it first.
 */
const fs = require('fs');

const formatJson = (suite) => JSON.stringify({ format: 'bruno-flow-suite', formatVersion: 1, ...suite }, null, 2);

module.exports = (context) => ({
  onSuiteEnd: async (suite) => {
    fs.writeFileSync(context.outputPath, formatJson(suite));
  }
});

module.exports.formatJson = formatJson;
