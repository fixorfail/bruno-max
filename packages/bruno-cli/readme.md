# Bruno CLI

With Bruno CLI, you can now run your API collections with ease using simple command line commands.

This makes it easier to test your APIs in different environments, automate your testing process, and integrate your API tests with your continuous integration and deployment workflows.

For detailed documentation, visit [Bruno CLI Documentation](https://docs.usebruno.com/bru-cli/overview).

## Installation

To install the Bruno CLI, use the node package manager of your choice, such as NPM:

```bash
npm install -g @usebruno/cli
```

## Getting started

Navigate to the directory where your API collection resides, and then run:

```bash
bru run
```

This command will run all the requests in your collection. You can also run a single request by specifying its filename:

```bash
bru run request.bru
```

Or run all requests in a collection's subfolder:

```bash
bru run folder
```

If you need to use an environment, you can specify it with the `--env` option:

```bash
bru run folder --env Local
```

If you need to collect the results of your API tests, you can specify the `--output` option:

```bash
bru run folder --output results.json
```

If you need to run a set of requests that connect to peers with both publicly and privately signed certificates respectively, you can add private CA certificates via the `--cacert` option. By default, these certificates will be used in addition to the default truststore:

```bash
bru run folder --cacert myCustomCA.pem
```

If you need to limit the trusted CA to a specified set when validating the request peer, provide them via `--cacert` and in addition use `--ignore-truststore` to disable the default truststore:

```bash
bru run request.bru --cacert myCustomCA.pem --ignore-truststore
```

## Importing Collections

You can import collections from other formats, such as OpenAPI, using the import command:

```bash
bru import openapi --source api.yml --output ~/Desktop/my-collection --collection-name "My API"
```

You can also use the shorter form with aliases:

```bash
bru import openapi -s api.yml -o ~/Desktop/my-collection -n "My API"
```

This creates a Bruno collection directory that can be opened in Bruno.

You can also import directly from a URL:

```bash
bru import openapi --source https://example.com/api-spec.json --output ~/Desktop --collection-name "Remote API"
```

You can also export the collection as a JSON file:

```bash
bru import openapi --source api.yml --output-file ~/Desktop/my-collection.json --collection-name "My API"
```

Import Options:

| Option                    | Details                                            |
| ------------------------- | -------------------------------------------------- |
| --source, -s              | Path to the source file or URL (required)          |
| --output, -o              | Path to the output directory                       |
| --output-file, -f         | Path to the output JSON file                       |
| --collection-name, -n     | Name for the imported collection                   |
| --insecure                | Skip SSL certificate validation when fetching from URLs |

## Command Line Options

| Option                       | Details                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------- |
| -h, --help                   | Show help                                                                     |
| --version                    | Show version number                                                           |
| -r                           | Indicates a recursive run (default: false)                                    |
| --cacert [string]            | CA certificate to verify peer against                                         |
| --env [string]               | Specify environment to run with                                               |
| --env-var [string]           | Overwrite a single environment variable, multiple usages possible             |
| -o, --output [string]        | Path to write file results to                                                 |
| -f, --format [string]        | Format of the file results; available formats are "json" (default) or "junit" |
| --reporter-json [string]     | Path to generate a JSON report                                                |
| --reporter-junit [string]    | Path to generate a JUnit report                                               |
| --reporter-html [string]     | Path to generate an HTML report                                               |
| --insecure                   | Allow insecure server connections                                             |
| --tests-only                 | Only run requests that have tests                                             |
| --bail                       | Stop execution after a failure of a request, test, or assertion               |
| --csv-file-path              | CSV file to run the collection with                                           |
| --reporter--skip-all-headers | Skip all headers in the report                                                |
| --reporter-skip-headers      | Skip specific headers in the report                                           |
| --client-cert-config         | Client certificate configuration by passing a JSON file                       |
| --delay [number]             | Add delay to each request                                                     |

## API Flows

Flows are multi-step, spec-driven API test sequences defined in `.flow.yml` files. Run, validate or list them with `bru flow`:

```bash
bru flow run flows/checkout.flow.yml       # run one flow
bru flow run flows/                        # run every flow in a directory
bru flow run a.flow.yml,b.flow.yml         # name several in one argument
bru flow validate flows/                   # validate without sending requests
bru flow list flows/                       # print what a run of those paths would execute
```

Paths may be separated by spaces or by commas, so a whole selection fits in one shell word.

Flow Options:

| Option                        | Details                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| --global-env [string]          | Workspace environment to run with, by name                                             |
| --env-var [string]             | Override a single variable, multiple usages possible                                   |
| --param [string]               | Supply a declared params value, multiple usages possible                               |
| --grep [string]                | Run only the selected flows this case-insensitive regular expression matches           |
| --grep-invert [string]         | Drop the selected flows it matches; excluding wins over including                      |
| --concurrency [number]         | Override `config.concurrency`                                                          |
| --max-run-duration [number]    | Bound the whole run in ms                                                              |
| --bail                         | Stop after the first failing flow                                                      |
| --retry-failed [string]        | Re-run the flows of a past suite that did not pass; defaults to the newest suite       |
| --retries [number]             | Re-run flows that did not pass, up to n more times, before the command finishes        |
| --no-capture                   | Do not write `.bruno-runs/` artifacts                                                  |
| --capture-dir [string]         | Write captures somewhere other than `<scope>/.bruno-runs`                              |
| --reporter [string]            | Write a report with `<module>[=<path>]`, multiple usages possible                       |
| --reporter-junit [string]      | Write a JUnit XML report, one testcase per step; the path is optional                  |
| --reporter-junit-flows [string]| Write a JUnit XML report counting flows rather than steps; the path is optional        |
| --reporter-json [string]       | Write a JSON suite report; the path is optional                                        |
| --reporter-html [string]       | Write a self-contained HTML report; the path is optional                               |
| --reporter-option [string]     | Pass `key=value` to every reporter, multiple usages possible                            |
| --verbose, --quiet, --silent   | Control how much the reporter prints                                                    |
| --no-color                     | Disable colourized output                                                              |
| --no-unicode                   | Use ASCII rather than box-drawing status markers                                        |

A `--grep` pattern is tried against the flow's path-relative id, `meta.name`, each `meta.tags` entry and `meta.testId`, and against every step's `id`, `name` and `meta:` values. It narrows the flows the paths already selected and never searches the disk.

Reports and the run directories they describe land together in one `suite-<timestamp>-<id>/` folder under the capture root, so a CI job collects a single directory. A built-in reporter needs no path; give one only to write somewhere of your own choosing.

`bru flow run` exits `0` on success, `1` if a flow failed, `2` if a flow did not run (it failed validation, or was refused for a missing required param), `3` on a usage error, and `4` if the run was cancelled (for example, `--max-run-duration` elapsing). A `--grep` that matches nothing exits `0` — the paths were valid and nothing matched. `bru flow validate` never exits `1`, since it sends no requests.

### Listing what would run

`bru flow list` prints the flows a `bru flow run` with the same arguments would execute, and sends nothing — it is how you check a `--grep` pattern before spending a CI job on it.

```bash
bru flow list flows/                          # what a run of this directory would do
bru flow list flows/ --grep 'smoke|checkout'  # what the pattern actually selects
bru flow list                                 # the whole collection or workspace
```

```
id        kind     steps  tags             file
checkout  flow         6  checkout, smoke  flows/checkout.flow.yml
refunds   flow         4  refunds          flows/refunds.flow.yml
login     library      1  —                flows/shared/login.flow.yml

3 flows · 1 library
```

The selection is the run's — the same paths, spaced or comma-separated, the same default of the current directory, the same `--grep` and `--grep-invert`. It takes `--grep`, `--grep-invert`, `--silent`, `--no-color` and `--no-unicode`, and nothing about running: no environments, no reporters, and nothing written to `.bruno-runs/`. A library flow is listed and marked `library` when you name it and absent when you name only the directory holding it, which is exactly how a run treats it. The `id` column is the last segment of the flow's path, widened to as much of the path as tells two flows apart.

`bru flow list` exits `0`, or `3` for the up-front mistakes a run refuses — a path that does not exist, a `--grep` that will not compile. A pattern that matched nothing exits `0`.

For the full `.flow.yml` authoring guide — steps, scripts, `functions:`, `pre:`, and diagnostics — see [Writing Flows](../../docs/writing-flows.md).

## Scripting

Bruno cli returns the following exit status codes:

- `0` -- execution successful
- `1` -- an assertion, test, or request in the executed collection failed
- `2` -- the specified output directory does not exist
- `3` -- the request chain seems to loop endlessly
- `4` -- bru was called outside of a collection root directory
- `5` -- the specified input file does not exist
- `6` -- the specified environment does not exist
- `7` -- the environment override was not a string or object
- `8` -- an environment override is malformed
- `9` -- an invalid output format was requested
- `255` -- another error occurred

## Demo

![demo](assets/images/cli-demo.png)

## Support

If you encounter any issues or have any feedback or suggestions, please raise them on our [GitHub repository](https://github.com/usebruno/bruno)

Thank you for using Bruno CLI!

## Changelog

<!-- An absolute link is used here because npm treats links differently -->

See [https://github.com/usebruno/bruno/releases](https://github.com/usebruno/bruno/releases)

## License

[MIT](license.md)
