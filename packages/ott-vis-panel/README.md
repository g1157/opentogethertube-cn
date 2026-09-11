# Grafana panel plugin template

This template is a starting point for building a panel plugin for Grafana.

## What are Grafana panel plugins?

Panel plugins allow you to add new types of visualizations to your dashboard, such as maps, clocks, pie charts, lists, and more.

Use panel plugins when you want to do things like visualize data returned by data source queries, navigate between dashboards, or control external systems (such as smart home devices).

## Getting started

### Frontend

1. Install dependencies

    ```bash
    yarn install --immutable
    ```

2. Build plugin in development mode and run in watch mode

    ```bash
    yarn workspace ott-vis-panel dev
    ```

3. Build plugin in production mode

    ```bash
    yarn workspace ott-vis-panel build
    ```

4. Run the tests (using Jest)

    ```bash
    # Exits after running all the tests
    yarn workspace ott-vis-panel test
    ```

5. Spin up a Grafana instance and run the plugin inside it (using Docker)

    ```bash
    yarn workspace ott-vis-panel server
    ```

6. Run the E2E tests (using Cypress)

    ```bash
    # Spins up a Grafana instance first that we tests against
    yarn workspace ott-vis-panel server

    # Starts the tests
    yarn workspace ott-vis-panel e2e
    ```

7. Run the linter

    ```bash
    yarn workspace ott-vis-panel lint
    ```

## Distribution

The commands above build the plugin locally. Plugin publishing is not automated in this fork.
For signing and catalog distribution, follow the current Grafana [signing documentation](https://grafana.com/developers/plugin-tools/publish-a-plugin/sign-a-plugin) and [publishing criteria](https://grafana.com/legal/plugins/#plugin-publishing-and-signing-criteria).

## Learn more

Below you can find source code for existing app plugins and other related documentation.

-   [Basic panel plugin example](https://github.com/grafana/grafana-plugin-examples/tree/master/examples/panel-basic#readme)
-   [`plugin.json` documentation](https://grafana.com/developers/plugin-tools/reference-plugin-json)
-   [How to sign a plugin?](https://grafana.com/developers/plugin-tools/publish-a-plugin/sign-a-plugin)
