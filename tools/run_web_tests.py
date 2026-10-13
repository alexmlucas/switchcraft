"""Runs web/test.html in headless Chrome and prints the results.

Waits in real time until the page sets its title to PASSED or FAILED (the
synth tests render audio, which headless Chrome's --dump-dom doesn't wait
for). Exit code 0 if every test passed.

    python tools/run_web_tests.py [--chrome PATH]

Needs: pip install websocket-client
"""

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import websocket

ROOT = Path(__file__).resolve().parent.parent
TEST_PAGE = ROOT / "web" / "test.html"
CHROME_PATHS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "google-chrome",
    "chromium",
]


def default_chrome():
    return next((p for p in CHROME_PATHS if os.path.exists(p) or shutil.which(p)), "google-chrome")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def run_page(chrome, timeout=60):
    """Returns (summary title, results text, sample tables text)."""
    port = free_port()
    profile = tempfile.mkdtemp()
    proc = subprocess.Popen(
        [chrome, "--headless=new", "--disable-gpu", f"--remote-debugging-port={port}",
         f"--user-data-dir={profile}", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.time() + 15
        while True:
            try:
                targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json"))
                page = next(t for t in targets if t["type"] == "page")
                break
            except Exception:
                if time.time() > deadline:
                    raise RuntimeError("Chrome didn't start")
                time.sleep(0.2)
        ws = websocket.create_connection(page["webSocketDebuggerUrl"], suppress_origin=True)
        ids = iter(range(1, 1_000_000))

        def call(method, **params):
            msg_id = next(ids)
            ws.send(json.dumps({"id": msg_id, "method": method, "params": params}))
            while True:
                msg = json.loads(ws.recv())
                if msg.get("id") == msg_id:
                    return msg.get("result", {})

        def evaluate(expr):
            r = call("Runtime.evaluate", expression=expr, returnByValue=True)
            return r.get("result", {}).get("value")

        call("Page.navigate", url=TEST_PAGE.as_uri())
        deadline = time.time() + timeout
        while evaluate("document.title") not in ("PASSED", "FAILED"):
            if time.time() > deadline:
                break
            time.sleep(0.2)
        title = evaluate("document.title")
        out = evaluate("document.getElementById('out').textContent") or ""
        blobs = evaluate("(document.getElementById('blobs') || {}).textContent || ''") or ""
        ws.close()
        return title, out, blobs
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--chrome", default=default_chrome())
    args = ap.parse_args()
    title, out, _ = run_page(args.chrome)
    print(out.rstrip())
    if title != "PASSED":
        print(f"\nresult: {title or 'timed out'}")
        sys.exit(1)


if __name__ == "__main__":
    main()
