import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",

  // Keep the Okta SDK as a native Node require instead of bundling it. The SDK
  // does `const nodeFetch = require('node-fetch')` and calls it directly;
  // when bundled, CJS/ESM interop turns that into `{ default: fn }`, so the call
  // throws "nodeFetch is not a function". Externalizing preserves the raw
  // require so node-fetch resolves to the callable function.
  serverExternalPackages: ["@okta/okta-sdk-nodejs"],

  // No NEXT_PUBLIC_* env vars needed — config is served via GET /api/config
  // and consumed client-side through the ConfigProvider + useConfig() hook.

  typescript: {
    // Local Docker rebuilds can opt out of Next's duplicate typecheck for speed.
    // CI and production builds keep type errors fatal by leaving this unset.
    ignoreBuildErrors: process.env.CAIPE_UI_FAST_BUILD === "true",
  },

  // HTTP security headers — applied to all responses
  headers: async () => [
    {
      // External App responses arrive on their canonical /apps/* URLs after
      // an internal proxy rewrite. Keep every route outside that surface and
      // the private runtime gateway unframeable.
      source: '/((?!apps(?:/|$)|api/agentic-apps/runtime/).*)',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        // CSP in report-only mode — monitors violations without blocking.
        // Permissive starter policy; tighten after reviewing violation reports.
        {
          key: 'Content-Security-Policy-Report-Only',
          value: [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: https:",
            "font-src 'self' data:",
            "connect-src 'self' wss: https:",
            "frame-ancestors 'none'",
          ].join('; '),
        },
      ],
    },
    {
      source: '/apps/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        {
          key: 'Content-Security-Policy-Report-Only',
          value: [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: https:",
            "font-src 'self' data:",
            "connect-src 'self' wss: https:",
            "frame-ancestors 'self'",
          ].join('; '),
        },
      ],
    },
    {
      source: '/api/agentic-apps/runtime/(.*)',
      headers: [
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        {
          key: 'Content-Security-Policy-Report-Only',
          value: [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: https:",
            "font-src 'self' data:",
            "connect-src 'self' wss: https:",
            "frame-ancestors 'self'",
          ].join('; '),
        },
      ],
    },
  ],

  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },

  // Turbopack is default in Next.js 16 — set root to silence lockfile detection warning
  turbopack: {
    root: import.meta.dirname,
  },

  // Webpack configuration (fallback for non-Turbopack builds)
  webpack: (config) => {
    // Suppress warnings for optional peer dependencies
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
    };
    return config;
  },
};

export default nextConfig;
