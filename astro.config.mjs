// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

// Phase 1 local hosts (dev/preview/container on localhost or 127.0.0.1 at any port).
const LOCAL_DOMAINS = [{ hostname: 'localhost' }, { hostname: '127.0.0.1' }];

/**
 * Builds the trusted-domain list Astro uses to validate forwarded headers.
 *
 * The production hostname comes from SITE_URL (e.g. `https://example.com`) so a deployed
 * image honors the reverse proxy's X-Forwarded-Host for its real host without editing
 * this file. The www/apex counterpart is trusted too, so a canonical redirect never
 * trips the check. An absent or malformed SITE_URL leaves localhost/127.0.0.1 only,
 * which keeps local dev, preview and container checks working exactly as before.
 *
 * @param {string | undefined} siteUrl
 * @returns {{ hostname: string }[]}
 */
function trustedDomains(siteUrl) {
  const domains = [...LOCAL_DOMAINS];
  const raw = (siteUrl ?? '').trim();
  if (raw === '') return domains;

  let hostname;
  try {
    ({ hostname } = new URL(raw));
  } catch {
    return domains;
  }
  if (!hostname) return domains;

  const add = (host) => {
    if (host && !domains.some((entry) => entry.hostname === host)) {
      domains.push({ hostname: host });
    }
  };

  add(hostname);

  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
  if (!isIpv4) {
    add(hostname.startsWith('www.') ? hostname.slice(4) : `www.${hostname}`);
  }

  return domains;
}

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  security: {
    allowedDomains: trustedDomains(process.env.SITE_URL),
  },
});
