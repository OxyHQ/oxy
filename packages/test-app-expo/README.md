# Oxy Test App

This Expo project is used to develop and validate `@oxy.so/services` in an isolated playground.

## Get started

1. Install dependencies (links the local `packages/services` workspace via `file:` reference)

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

The Metro config automatically watches the monorepo root and resolves `@oxy.so/services` from `packages/services/src`, so changes to the services package will hot reload in the test app.

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

### Web bundler quirk

Metro expects web bundle requests to include a bundle path (for example `/index.bundle?platform=web`). Some tooling issues in Expo SDK 54 send `/?platform=web`, which causes Metro to throw an error about JSC-safe URLs. Our `metro.config.js` now rewrites those requests so you can run `npm run web` without tweaks.

## Develop `@oxy.so/services` locally

- Edit code in `packages/services/src/**`
- Keep the bundler running with `npm run start` inside `packages/test-app` to see updates instantly
- Rebuild the package (`npm run build` inside `packages/services`) when you need the generated `lib` output for consumers outside Metro

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.
