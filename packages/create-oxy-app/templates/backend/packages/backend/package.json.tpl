{
  "name": "@{{APP_SLUG}}/backend",
  "version": "0.1.0",
  "private": true,
  "type": "commonjs",
  "main": "dist/server.js",
  "scripts": {
    "dev": "bun --watch server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "bun dist/server.js",
    "clean": "rm -rf dist",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "bun run src/db/migrate.ts"
  },
  "dependencies": {
    "@{{APP_SLUG}}/shared-types": "workspace:*",
    "@oxyhq/core": "{{v.oxyCore}}",
    "@oxyhq/db": "{{v.oxyDb}}",
    "dotenv": "{{v.dotenv}}",
    "drizzle-orm": "{{v.drizzleOrm}}",
    "express": "{{v.express}}",
    "postgres": "{{v.postgres}}",
    "socket.io": "{{v.socketIo}}"
  },
  "devDependencies": {
    "@types/express": "{{v.expressTypes}}",
    "@types/node": "{{v.nodeTypes}}",
    "drizzle-kit": "{{v.drizzleKit}}",
    "typescript": "{{v.typescript}}"
  }
}
