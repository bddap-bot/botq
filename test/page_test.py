import base64
import functools
import http.server
import json
import threading
from pathlib import Path
from typing import Callable

from playwright.sync_api import Page, sync_playwright

DOCS = Path(__file__).resolve().parent.parent / "docs"
STORAGE_KEY = "botq.token"

STUB_UI = base64.urlsafe_b64encode(b"""
export default (_, root) => {
  for (const route of ['history', 'queue', 'job/42']) {
    const link = document.createElement('a');
    link.textContent = route;
    link.href = '#/' + route;
    link.onclick = event => {
      event.preventDefault();
      location.hash = '#/' + route;
      location.reload();
    };
    root.append(link);
  }
};
""").decode().rstrip("=")
STUB_WASM_JS = """
const dec = new TextDecoder();
const enc = new TextEncoder();
export default async function () {}
export function init() {}
export async function connect() {}
export async function send(bytes) {
  const req = JSON.parse(dec.decode(bytes));
  if ('auth' in req) globalThis.auths = (globalThis.auths || 0) + 1;
  if ('auth' in req) return enc.encode(JSON.stringify({ ok: req.auth === 'stub-secret' }));
  if (req.op === 'get_ui') return enc.encode(JSON.stringify({ ui_b64: '%s' }));
  throw new Error('unexpected request');
}
export function recv() { return new Promise(() => {}); }
export async function send_only() {}
""" % STUB_UI



def make_token(secret: str) -> str:
    body = json.dumps({"endpoint_id": "stub", "secret": secret}).encode()
    return base64.urlsafe_b64encode(body).decode().rstrip("=")


TOKEN = make_token("stub-secret")
WRONG_TOKEN = make_token("wrong-secret")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass


def serve_docs() -> tuple[http.server.ThreadingHTTPServer, str]:
    handler = functools.partial(QuietHandler, directory=str(DOCS))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/"


def stored(page: Page) -> dict[str, object]:
    return page.evaluate(
        """async () => ({
            local: Object.keys(localStorage),
            session: Object.keys(sessionStorage),
            cookie: document.cookie,
            indexedDB: (await indexedDB.databases()).map(d => d.name),
            caches: await caches.keys(),
        })"""
    )


NOTHING_STORED = {"local": [], "session": [], "cookie": "", "indexedDB": [], "caches": []}


def assert_saved_token_is_not_exposed(page: Page) -> None:
    assert stored(page) == {**NOTHING_STORED, "local": [STORAGE_KEY]}, stored(page)
    assert page.evaluate("localStorage.getItem('botq.token')") == TOKEN
    assert TOKEN not in page.content(), "the token is in the DOM"
    assert TOKEN not in page.url, "the token is in the address bar"
    assert page.input_value("#token") == ""


def wait_connected(page: Page) -> None:
    page.wait_for_function("document.getElementById('status').textContent === 'connected'")


def test_saved_token_reconnects(page: Page, base: str) -> None:
    page.goto(base)
    page.evaluate(f"localStorage.setItem({json.dumps(STORAGE_KEY)}, {json.dumps(TOKEN)})")
    page.reload()
    page.wait_for_load_state("networkidle")
    wait_connected(page)
    assert_saved_token_is_not_exposed(page)


def test_pasted_token_is_saved(page: Page, base: str) -> None:
    page.goto(base)
    page.fill("#token", TOKEN)
    page.click("#connect")
    wait_connected(page)
    page.wait_for_timeout(500)
    assert_saved_token_is_not_exposed(page)


def test_pasted_token_survives_reload(page: Page, base: str) -> None:
    page.goto(base)
    page.fill("#token", TOKEN)
    page.click("#connect")
    wait_connected(page)
    page.reload()
    page.wait_for_function("document.getElementById('status').textContent === 'connected'", timeout=5000)
    assert_saved_token_is_not_exposed(page)


def test_rejected_token_is_not_kept(page: Page, base: str) -> None:
    page.goto(base)
    page.fill("#token", WRONG_TOKEN)
    page.click("#connect")
    page.wait_for_function("document.getElementById('status').textContent.startsWith('auth rejected')")
    assert stored(page) == NOTHING_STORED
    assert WRONG_TOKEN not in page.content()
    assert page.input_value("#token") == ""


def test_fragment_token_connects(page: Page, base: str) -> None:
    page.goto(base + "#" + TOKEN)
    wait_connected(page)
    page.wait_for_timeout(500)
    assert_saved_token_is_not_exposed(page)


def test_fragment_on_an_open_page_connects(page: Page, base: str) -> None:
    page.goto(base)
    page.evaluate(f"location.hash = {json.dumps(TOKEN)}")
    wait_connected(page)
    assert_saved_token_is_not_exposed(page)
    page.go_back()
    assert page.url == base, "the token URL stays in session history"


def test_fragment_while_connected_is_ignored(page: Page, base: str) -> None:
    page.goto(base + "#" + TOKEN)
    wait_connected(page)
    page.evaluate(f"location.hash = {json.dumps(WRONG_TOKEN)}")
    page.wait_for_function("location.hash === ''")
    page.wait_for_timeout(300)
    assert page.text_content("#status") == "connected"
    assert page.evaluate("globalThis.auths") == 1
    assert WRONG_TOKEN not in page.url


def test_navigation_keeps_token_and_route(page: Page, base: str) -> None:
    page.goto(base + "#" + TOKEN)
    wait_connected(page)
    for route in ("history", "queue", "job/42"):
        page.locator(f'a[href="#/{route}"]').click()
        page.wait_for_load_state("networkidle")
        wait_connected(page)
        assert page.url == base + "#/" + route, page.url
        assert_saved_token_is_not_exposed(page)
        page.reload()
        wait_connected(page)
        assert page.url == base + "#/" + route, page.url
        assert_saved_token_is_not_exposed(page)


def test_forget_token_stops_reconnecting(page: Page, base: str) -> None:
    page.goto(base + "#" + TOKEN)
    wait_connected(page)
    page.click("#forget")
    page.wait_for_load_state("networkidle")
    assert stored(page) == NOTHING_STORED
    assert page.locator("#gate").is_visible()
    assert page.locator("#forget").is_hidden()
    page.reload()
    page.wait_for_load_state("networkidle")
    assert page.locator("#gate").is_visible()
    assert page.evaluate("globalThis.auths || 0") == 0


def test_bad_fragment_keeps_saved_token(page: Page, base: str) -> None:
    page.goto(base + "#" + TOKEN)
    wait_connected(page)
    page.goto(base + "?retry#" + WRONG_TOKEN)
    page.wait_for_function("document.getElementById('status').textContent.startsWith('auth rejected')")
    assert_saved_token_is_not_exposed(page)
    page.reload()
    wait_connected(page)
    assert_saved_token_is_not_exposed(page)


def test_old_shell_cache_is_erased(page: Page, base: str) -> None:
    page.goto(base + "manifest.webmanifest")
    page.evaluate(
        "async () => (await caches.open('botq-shell-v1')).put('index.html', new Response('old page'))"
    )
    page.goto(base)
    page.wait_for_load_state("networkidle")
    assert page.evaluate("caches.keys()") == []


TESTS: list[tuple[Callable[[Page, str], None], bool]] = [
    (test_pasted_token_survives_reload, False),
    (test_saved_token_reconnects, False),
    (test_pasted_token_is_saved, False),
    (test_rejected_token_is_not_kept, False),
    (test_fragment_token_connects, False),
    (test_fragment_on_an_open_page_connects, False),
    (test_fragment_while_connected_is_ignored, False),
    (test_navigation_keeps_token_and_route, False),
    (test_forget_token_stops_reconnecting, False),
    (test_bad_fragment_keeps_saved_token, False),
    (test_old_shell_cache_is_erased, True),
]


def main() -> None:
    server, base = serve_docs()
    failed = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for test, service_worker in TESTS:
            context = browser.new_context(service_workers="allow" if service_worker else "block")
            context.route(
                "**/botq_dash_wasm.js",
                lambda route: route.fulfill(content_type="text/javascript", body=STUB_WASM_JS),
            )
            page = context.new_page()
            try:
                test(page, base)
                print(f"ok   {test.__name__}")
            except Exception as e:
                failed += 1
                print(f"FAIL {test.__name__}: {e}")
            context.close()
        browser.close()
    server.shutdown()
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
