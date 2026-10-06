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

STUB_UI = base64.urlsafe_b64encode(b"export default () => {};").decode().rstrip("=")
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


def assert_token_only_in_memory(page: Page) -> None:
    assert stored(page) == NOTHING_STORED, stored(page)
    assert TOKEN not in page.content(), "the token is in the DOM"
    assert TOKEN not in page.url, "the token is in the address bar"
    assert page.input_value("#token") == ""


def wait_connected(page: Page) -> None:
    page.wait_for_function("document.getElementById('status').textContent === 'connected'")


def test_saved_token_is_erased(page: Page, base: str) -> None:
    page.goto(base)
    page.evaluate(f"localStorage.setItem({json.dumps(STORAGE_KEY)}, {json.dumps(TOKEN)})")
    page.reload()
    page.wait_for_load_state("networkidle")
    assert stored(page) == NOTHING_STORED, "a token saved by an earlier version survives a load"


def test_pasted_token_is_not_stored(page: Page, base: str) -> None:
    page.goto(base)
    page.fill("#token", TOKEN)
    page.click("#connect")
    wait_connected(page)
    page.wait_for_timeout(500)
    assert_token_only_in_memory(page)


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
    assert_token_only_in_memory(page)


def test_fragment_on_an_open_page_connects(page: Page, base: str) -> None:
    page.goto(base)
    page.evaluate(f"location.hash = {json.dumps(TOKEN)}")
    wait_connected(page)
    assert_token_only_in_memory(page)
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


def test_old_shell_cache_is_erased(page: Page, base: str) -> None:
    page.goto(base + "manifest.webmanifest")
    page.evaluate(
        "async () => (await caches.open('botq-shell-v1')).put('index.html', new Response('old page'))"
    )
    page.goto(base)
    page.wait_for_load_state("networkidle")
    assert page.evaluate("caches.keys()") == []


TESTS: list[tuple[Callable[[Page, str], None], bool]] = [
    (test_saved_token_is_erased, False),
    (test_pasted_token_is_not_stored, False),
    (test_rejected_token_is_not_kept, False),
    (test_fragment_token_connects, False),
    (test_fragment_on_an_open_page_connects, False),
    (test_fragment_while_connected_is_ignored, False),
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
