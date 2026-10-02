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
            DEV_BYPASS_AUTH: 'true',
            TEAM_DOMAIN: 'https://test.cloudflareaccess.com',
            POLICY_AUD: 'test-aud',
          },
        },
      }),
    ],
    test: { setupFiles: ['./test/apply-migrations.js'] },
  };
});
