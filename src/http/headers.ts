export function csp(supabaseOrigin: string | null): string {
  const connect = ["'self'", 'https://tiles.openfreemap.org', supabaseOrigin].filter(Boolean).join(' ');
  return [
    "default-src 'self'",
    "script-src 'self'",
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

export function securityHeaders(production: boolean, supabaseOrigin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': csp(supabaseOrigin),
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
