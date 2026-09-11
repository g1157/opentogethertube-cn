# Contributing

## Setting up your dev environment

Set up the development environment on your local machine. For a self-hosted production instance, use [DEPLOYMENT.md](DEPLOYMENT.md).

### Prerequisites

Use a Node.js version supported by `package.json`; Node.js 24 is recommended. Use the repository's pinned Yarn 4.1.0 rather than replacing it with a different release.

I also recommend using the github cli (note this is different from git) to make PRs.

### Linux/WSL Dependencies

#### Ubuntu

```bash
sudo apt-get install --no-install-recommends build-essential ca-certificates apt-utils libsqlite3-dev libpq-dev libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libdbus-1-3 libatspi2.0-0 libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 libxcb1 libxkbcommon0 libpango-1.0-0 libcairo2 libasound2 libsodium-dev libtool-bin libtool pkg-config autoconf
```

### Setting up the Monolith on your local machine or WSL

The Monolith refers to the node.js server that serves the client and handles all the business logic. It is located in the `server` folder. The client is located in the `client` folder, which should also work after you set up the Monolith.

1. Clone this repo.
2. In a terminal, navigate to the repository root and install dependencies:

    ```sh
    corepack enable
    yarn install --immutable
    ```

3. Copy the example configuration to `env/development.toml`:

    ```sh
    cp env/example.toml env/development.toml
    ```

    Set `session_secret` in this file to a unique random value of at least 80 characters. Keep local configuration out of Git.

4. To use optional Google integrations, create a project on [Google Cloud](https://console.cloud.google.com), enable the required YouTube Data API v3 or Google Drive API, and add the corresponding keys to `env/development.toml`.
5. Initialize your local databases:

    ```sh
    yarn workspace ott-server run sequelize-cli db:migrate
    ```

6. Install [Redis](https://redis.io) and make sure it is running. Redis stores room state and user sessions across server restarts.

## Testing

Make sure your test sqlite database is up to date by running this command. You should only need to do this once, or if you change the database schema with a migration.

```
NODE_ENV=test yarn workspace ott-server run sequelize-cli db:migrate
```

To run the linter, run

```
yarn lint
```

To run the unit test suite, run

```
yarn test
```

To run the client component test suite, run

```
yarn workspace ott-client run test:component
```

To run the e2e test suite, run

```
yarn run cy:run
```

However, while you're developing, you'll probably want to run the tests in headed mode. To do this, run

```
yarn run cy:open
```

This opens the browser end-to-end tests; component tests use Vitest.

The Cypress sources are retained for local development. They still include upstream English UI selectors and external-media assumptions, so adapt those cases to this branch before using them for release acceptance. The upstream Cypress Cloud and PR reporting workflows are not included; CI runs the workspace tests, Rust checks, and CodeQL analysis without third-party service keys.

## How to run

This project has 2 main components: the client and the server. You can run
both of them simultaneously using the command

#### Linux / Mac

```
yarn run dev
```

#### Windows

```
yarn run dev-windows
```

You can also start the server and client separately when debugging.

To start the server with its inspector: `yarn workspace ott-server debug`

To start the client: `yarn workspace ott-client serve`
