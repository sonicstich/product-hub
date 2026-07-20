// Vercel Edge Middleware — gates the whole app behind Slack sign-in (Gate B).
// Runs before every request. Fail-open: if auth isn't configured
// (SESSION_SECRET / SLACK_CLIENT_ID missing) it lets everything through, so
// deploying this never locks anyone out. Verifies the same HS256 session
// token that lib/auth.js signs, using Web Crypto.
import { next } from '@vercel/edge';

export const config = {
  // Gate everything except the auth endpoints, the health check, and favicon.
  matcher: ['/((?!api/auth|api/status|favicon.ico).*)'],
};

function b64urlToBytes(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToString(s) { return new TextDecoder().decode(b64urlToBytes(s)); }

async function verify(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('HMAC', key, b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const payload = JSON.parse(b64urlToString(parts[1]));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (_) { return null; }
}

export default async function middleware(req) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || !process.env.SLACK_CLIENT_ID) return next(); // auth off → open

  const cookie = req.headers.get('cookie') || '';
  const m = ('; ' + cookie).match(/; ph_session=([^;]+)/);
  const token = m ? decodeURIComponent(m[1]) : null;
  const session = token ? await verify(token, secret) : null;
  if (session) return next();

  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: { 'content-type': 'application/json' } });
  }
  return Response.redirect(new URL('/api/auth/login', req.url), 302);
}
