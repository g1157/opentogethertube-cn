# Grafana data source plugin template

This template is a starting point for building a Data Source Plugin for Grafana.

## What are Grafana data source plugins?

Grafana supports a wide range of data sources, including Prometheus, MySQL, and even Datadog. There’s a good chance you can already visualize metrics from the systems you have set up. In some cases, though, you already have an in-house metrics solution that you’d like to add to your Grafana dashboards. Grafana Data Source Plugins enables integrating such solutions with Grafana.

## Getting started

### Frontend

1. Install dependencies

    ```bash
    yarn install --immutable
    ```

2. Build plugin in development mode and run in watch mode

    ```bash
    yarn workspace ott-vis-datasource dev
    ```

3. Build plugin in production mode

    ```bash
    yarn workspace ott-vis-datasource build
    ```

4. Run the tests (using Jest)

    ```bash
    # Runs the tests and watches for changes, requires git init first
    yarn workspace ott-vis-datasource test
    ```

5. Spin up a Grafana instance and run the plugin inside it (using Docker)

    ```bash
    yarn workspace ott-vis-datasource server
    ```

6. Run the E2E tests (using Cypress)

    ```bash
    # Spins up a Grafana instance first that we tests against
    yarn workspace ott-vis-datasource server

    # Starts the tests
    yarn workspace ott-vis-datasource e2e
    ```

7. Run the linter

    ```bash
    yarn workspace ott-vis-datasource lint
    ```

## Distribution

The commands above build the plugin locally. Plugin publishing is not automated in this fork.
For signing and catalog distribution, follow the current Grafana [signing documentation](https://grafana.com/developers/plugin-tools/publish-a-plugin/sign-a-plugin) and [publishing criteria](https://grafana.com/legal/plugins/#plugin-publishing-and-signing-criteria).

## Learn more

Below you can find source code for existing app plugins and other related documentation.

-   [Basic data source plugin example](https://github.com/grafana/grafana-plugin-examples/tree/master/examples/datasource-basic#readme)
-   [`plugin.json` documentation](https://grafana.com/developers/plugin-tools/reference-plugin-json)
-   [How to sign a plugin?](https://grafana.com/developers/plugin-tools/publish-a-plugin/sign-a-plugin)
