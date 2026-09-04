/**
 * Registered automatically by `yargs.commandDir('commands')`, so the flow feature needs no edit to
 * an upstream file to reach the CLI. Everything below the command's declaration is fork-owned
 * (`src/fork/flow/`), which keeps this file a delegation rather than a place feature logic lands.
 */
const { builder, handler } = require('../fork/flow');

const command = 'flow <action> [paths...]';
const desc = 'Run, validate or list API flows';

module.exports = { command, desc, builder, handler };
