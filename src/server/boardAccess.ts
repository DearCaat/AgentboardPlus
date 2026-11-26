import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { administrator, BoardGrants, type BoardAccess } from './boardGrants'

const COOKIE_NAME = 'agentboard_access'
const LOGIN_PATH = '/api/auth/login'
const SESSION_SECONDS = 7 * 24 * 60 * 60
const NO_STORE = { 'Cache-Control': 'no-store' }

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function loginPage(invalid = false): Response {
  return new Response('' +
    '<!doctype html><html lang="en"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>AgentBoard sign in</title><style>' +
    ':root{color-scheme:light dark}body{margin:0;min-height:100dvh;display:grid;place-items:center;font:16px system-ui}' +
    'main{width:min(24rem,calc(100% - 3rem))}label,input,button{display:block}input{box-sizing:border-box;width:100%;margin:.5rem 0 1rem}input,button{font:inherit;padding:.5rem}</style>' +
    '<main><h1>AgentBoard</h1><form method="post" action="' + LOGIN_PATH + '">' +
    '<label for="token">Access token</label><input id="token" name="token" type="password" autocomplete="current-password" required autofocus>' +
    (invalid ? '<p role="alert">Invalid access token</p>' : '') +
    '<button type="submit">Sign in</button></form></main></html>', {
    status: invalid ? 401 : 200,
    headers: { ...NO_STORE, 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'same-origin' },
  })
}

/** Protects the dashboard and the relay's WebSocket upgrade with the same credential. */
export function createBoardAccessGate(tokenFile: string | undefined, grantsFile?: string) {
  const grants = new BoardGrants(tokenFile ? grantsFile : undefined)
  if (!tokenFile) return { enabled: false, grants, identify: () => administrator as BoardAccess | undefined, respond: () => null as Response | Promise<Response> | null }
  const token = readFileSync(tokenFile, 'utf8').trim()
  if (token.length < 32 || token.length > 256 || !/^[!-~]+$/.test(token)) {
    throw new Error('AgentBoard access token must contain 32–256 printable ASCII characters without spaces')
  }
  const tokenHash = digest(token)
  const matchesToken = (candidate: string) => timingSafeEqual(digest(candidate), tokenHash)
  const forToken = (candidate: string): BoardAccess | undefined => matchesToken(candidate) ? administrator : grants.byToken(candidate)
  const sign = (value: string) => createHmac('sha256', tokenHash).update('agentboard-session:' + value).digest('base64url')

  function identify(req: Request): BoardAccess | undefined {
    const authorization = req.headers.get('authorization')
    if (authorization?.startsWith('Bearer ')) return forToken(authorization.slice(7))
    const entry = (req.headers.get('cookie') ?? '').split(';').map((part) => part.trim())
      .find((part) => part.startsWith(COOKIE_NAME + '='))
    if (!entry) return
    const match = /^(?:(?<id>[0-9a-f-]{36})\.)?(?<expiry>\d{1,12})\.(?<signature>[A-Za-z0-9_-]{43})$/.exec(entry.slice(COOKIE_NAME.length + 1))
    if (!match?.groups) return
    const { id, expiry, signature } = match.groups
    if (Number(expiry) <= Math.floor(Date.now() / 1000)) return
    const signedValue = id ? id + '.' + expiry : expiry
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(sign(signedValue)))) return
    return id ? grants.byId(id) : administrator
  }

  async function login(req: Request, url: URL): Promise<Response> {
    const length = Number(req.headers.get('content-length'))
    const validType = req.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')
    if (!validType || !Number.isInteger(length) || length < 1 || length > 2048) {
      await req.body?.cancel()
      return new Response('Invalid login request', { status: 400, headers: NO_STORE })
    }
    const submitted = new URLSearchParams(await req.text()).get('token') ?? ''
    const access = forToken(submitted)
    if (!access) return loginPage(true)
    const expiry = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS)
    const secure = url.protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https'
    const signedValue = access.role === 'shared' ? access.id + '.' + expiry : expiry
    const cookie = COOKIE_NAME + '=' + signedValue + '.' + sign(signedValue) +
      '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_SECONDS + (secure ? '; Secure' : '')
    return new Response(null, { status: 303, headers: { ...NO_STORE, Location: '/', 'Set-Cookie': cookie } })
  }

  function respond(req: Request, url: URL, access: BoardAccess | undefined): Response | Promise<Response> | null {
    const isLogin = url.pathname === '/login' || url.pathname === LOGIN_PATH
    if (access) {
      if (isLogin) return new Response(null, { status: 303, headers: { ...NO_STORE, Location: '/' } })
      return null
    }
    if (isLogin) {
      if (req.method === 'GET') return loginPage()
      if (req.method === 'POST') return login(req, url)
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/') && url.pathname !== '/ws') {
      return new Response(null, { status: 303, headers: { ...NO_STORE, Location: LOGIN_PATH } })
    }
    return Response.json({ error: 'Authentication required' }, { status: 401, headers: NO_STORE })
  }
  return { enabled: true, grants, identify, respond }
}
