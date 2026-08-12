const { nodeResolve } = require('@rollup/plugin-node-resolve');
const commonjs = require('@rollup/plugin-commonjs');
const typescript = require('@rollup/plugin-typescript');
const terser = require('@rollup/plugin-terser').default;
const peerDepsExternal = require('rollup-plugin-peer-deps-external');
const json = require('@rollup/plugin-json');
const { isBuiltin } = require('module');
const packageJson = require('./package.json');

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
      terser()
    ],
    external: (id) =>
      isBuiltin(id) || id.startsWith('@usebruno/') || ['ajv', 'ajv-formats', 'js-yaml', 'lodash'].includes(id)
  }
];
