import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            AUTH_SECRET: 'test-secret-at-least-16-chars',
            ALLOWED_EMAILS: 'me@example.com',
            MAILER: 'memory',
          },
        },
      }),
    ],
    test: { setupFiles: ['./test/apply-migrations.js'] },
  };
});
