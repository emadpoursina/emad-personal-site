// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  // Phase 1 local hosts (dev/preview/container on localhost or 127.0.0.1 at any port).
  // A production hostname must be added here when the site is deployed to a real domain,
  // otherwise the native form's same-origin POST will be rejected by Astro's origin check.
  security: {
    allowedDomains: [{ hostname: 'localhost' }, { hostname: '127.0.0.1' }],
  },
});
