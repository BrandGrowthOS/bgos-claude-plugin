// A small real website for proving normal browsing: a shop with a CSRF field, a search form,
// a login page, a slow embed and an alert. Loopback, made up values. No em or en dashes in this file.
import { createServer } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

export const CSRF = 'c5rfMadeUpToken000000000000000000000000'
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`
const HOME = page('Corner Shop', `
  <header><nav><a href="/products?page=1">Products</a> <a href="/login">Sign in</a></nav></header>
  <main>
    <h1>Corner Shop</h1>
    <h2>Orders 2021 for 100 items</h2>
    <form id="cart" method="post" action="/cart" onsubmit="return false">
      <input type="hidden" name="authenticity_token" value="${CSRF}">
      <input type="hidden" name="page" value="1">
      <input type="hidden" name="kind" value="text">
      <input type="hidden" name="lang" value="e">
      <label>First name <input name="first"></label>
      <label>Last name <input name="last"></label>
    </form>
    <form method="get" action="/search"><input type="hidden" name="commit" value="Delete account"><label>Search <input name="q" type="search"></label><button>Search</button></form>
    <button id="report" onclick="document.getElementById('out').textContent='report shown'">Show the report</button>
    <button id="chart" onclick="document.getElementById('out').textContent='chart shown'">Show the chart</button>
    <button aria-label="Pin message" onclick="document.getElementById('out').textContent='pinned'">Pin</button>
    <button id="forgot-password">Log in</button>
    <button id="later" onclick="setTimeout(()=>{document.getElementById('late').textContent='Delivery booked'},800)">Book delivery</button>
    <button id="hello" onclick="setTimeout(()=>alert('Welcome back'),0)">Say hello</button>
    <p id="out">idle</p><p id="late">pending</p>
    <p>Log in to your account. Pin it. Call 100 or 2021.</p>
  </main>`)
const LOGIN = page('Sign in', `<h1>Sign in</h1><form method="get" action="/session"><label>Email <input name="email"></label>
  <label>Password <input id="pw" name="pw" type="password"></label>
  <button type="button" id="show" onclick="document.getElementById('pw').type='text'">Show</button><button>Continue</button></form>`)

export function serveSite(html?: (path: string, query: URLSearchParams) => string | undefined) {
  const sockets = new Set<Socket>()
  const clicks: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(String(req.url), 'http://fixture')
    if (url.pathname.startsWith('/clicked/')) { clicks.push(url.pathname.slice(9)); res.end('ok'); return }
    if (url.pathname === '/hang') return
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
    const custom = html?.(url.pathname, url.searchParams)
    if (custom !== undefined) { res.end(custom); return }
    if (url.pathname === '/') { res.end(HOME); return }
    if (url.pathname === '/login') { res.end(LOGIN); return }
    if (url.pathname === '/session') { res.end(page('Signed in', '<h1>Welcome</h1>')); return }
    if (url.pathname === '/products') { res.end(page('Products', `<h1>Products page ${url.searchParams.get('page')}</h1><a href="/">Home</a>`)); return }
    if (url.pathname === '/search') { res.end(page('Search', `<h1>Results for ${url.searchParams.get('q')}</h1>`)); return }
    if (url.pathname === '/slow') { res.end(page('Article', '<h1>Article with a slow embed</h1><iframe src="/hang" title="slow embed"></iframe><button onclick="document.getElementById(\'o\').textContent=\'read\'">Mark read</button><p id="o">unread</p>')); return }
    if (url.pathname === '/plain') { res.end(page('Plain', '<h1>A plain public page</h1>')); return }
    res.end(page('Empty', '<p>empty</p>'))
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  return new Promise<{ origin: string, clicks: string[], close: () => Promise<void> }>((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    clicks,
    close: () => { for (const socket of sockets) socket.destroy(); return new Promise((done) => server.close(() => done())) },
  })))
}
