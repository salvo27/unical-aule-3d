// Cloudflare Web Analytics: the beacon script and the address it reports to, only where a page allows it.
export const ANALYTICS_SCRIPT = 'https://static.cloudflareinsights.com';
export const ANALYTICS_REPORT = 'https://cloudflareinsights.com';

export function csp(supabaseOrigin: string | null, analytics = false): string {
  const connect = ["'self'", 'https://tiles.openfreemap.org', supabaseOrigin, analytics ? ANALYTICS_REPORT : null].filter(Boolean).join(' ');
  const script = ["'self'", analytics ? ANALYTICS_SCRIPT : null].filter(Boolean).join(' ');
  return [
    "default-src 'self'",
    `script-src ${script}`,
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
}

export function securityHeaders(production: boolean, supabaseOrigin: string | null, analytics = false): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': csp(supabaseOrigin, analytics),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // Location only for our own pages (the "my position" button); it never leaves the browser.
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self), payment=()',
  };
  if (production) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}
