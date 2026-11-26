import { test } from 'vitest';

// FOLLOW-UP: put `@gemies/sdk` back in this fixture when `@gemies/sdk` 10 is on npm.
//
// `@gemies/sdk` 9 declares `@oxy.so/services >=14.19.1 <15`, so it cannot compose with
// Services 15, and `@gemies/sdk` 10 (OxyHQ/Gemies#155) can only be published once
// Services 15 is. Until then the published Gemies SDK is out of this fixture
// (`@gemies/server` stays). To restore: add `"@gemies/sdk": "10.0.0"` to package.json and
// bring back this file's test from c146818bb
// (`git show c146818bb:packages/core/test-consumers/product-sdks/session-composition.test.ts`):
// the Gemies SDK session REST replays JSON once with packed Core refresh and fences
// account switches.
test.todo('published Gemies SDK session REST: restore when @gemies/sdk 10 is on npm');
