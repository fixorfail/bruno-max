const { nodeResolve } = require('@rollup/plugin-node-resolve');
const commonjs = require('@rollup/plugin-commonjs');
const typescript = require('@rollup/plugin-typescript');
const terser = require('@rollup/plugin-terser').default;
const peerDepsExternal = require('rollup-plugin-peer-deps-external');
const json = require('@rollup/plugin-json');
const { isBuiltin } = require('module');
const packageJson = require('./package.json');

// @rollup/plugin-typescript can leave TypeScript fs watchers open after a one-shot build, so the
// process ghosts `npm run setup` instead of exiting. rollup 3 has no `--forceExit`. The unref'd
// timer fires only if something still holds the event loop, and it keeps `process.exitCode`.
const exitAfterBuild = () => ({
  name: 'exit-after-build',
  closeBundle() {
    if (!this.meta.watchMode) {
      setTimeout(() => process.exit(), 1000).unref();
    }
  }
});

module.exports = [
  {
    input: 'src/index.ts',
    output: [
      {
        file: packageJson.main,
        format: 'cjs',
        sourcemap: true,
        exports: 'named'
      },
      {
        file: packageJson.module,
        format: 'esm',
        sourcemap: true,
        exports: 'named'
      }
    ],
    plugins: [
      peerDepsExternal(),
      nodeResolve({
        extensions: ['.js', '.ts', '.json'],
        preferBuiltins: true
      }),
      json(),
      commonjs({ transformMixedEsModules: true }),
      typescript({ tsconfig: './tsconfig.json' }),
      terser(),
      exitAfterBuild()
    ],
    external: (id) =>
      isBuiltin(id) || id.startsWith('@usebruno/') || ['ajv', 'ajv-formats', 'lodash', 'yaml'].includes(id)
  }
];
