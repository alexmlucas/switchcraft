"""Checks that tables built by the web page are accepted by a real board.

Runs web/test.html in headless Chrome, takes the sample tables it prints,
writes each one to the connected board (without saving), reads it back, and
finally restores the board's working table.

    python tools/check_page_tables.py [--chrome PATH]

Needs a board, Chrome, and: pip install mido python-rtmidi
"""

import argparse
import html
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import sc  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CHROME_PATHS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "google-chrome",
    "chromium",
]


def page_tables(chrome):
    with tempfile.TemporaryDirectory() as profile:
        dom = subprocess.run(
            [chrome, "--headless=new", "--disable-gpu", f"--user-data-dir={profile}",
             "--virtual-time-budget=5000", "--dump-dom", (ROOT / "web" / "test.html").as_uri()],
            capture_output=True, text=True, encoding="utf8", check=True).stdout
    summary = re.search(r"(\d+) passed, (\d+) failed", dom)
    if not summary or summary.group(2) != "0":
        sys.exit(f"page unit tests failed: {summary.group(0) if summary else 'no result'}")
    block = re.search(r'<pre id="blobs"[^>]*>(.*?)</pre>', dom, re.S)
    for line in html.unescape(block.group(1)).strip().splitlines():
        name, hexdata = line.split()
        yield name, bytes.fromhex(hexdata)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--chrome", default=next((p for p in CHROME_PATHS if os.path.exists(p)), "google-chrome"))
    args = ap.parse_args()

    tables = list(page_tables(args.chrome))
    board = sc.Board()
    original = board.read_table(sc.SOURCE_WORKING)
    failed = 0
    try:
        for name, blob in tables:
            try:
                board.write_table(blob)
                ok = board.read_table(sc.SOURCE_WORKING) == blob
                print(f"{'PASS' if ok else 'FAIL'} {name} ({len(blob)} bytes)"
                      + ("" if ok else ": read back differs"))
                failed += not ok
            except sc.BoardError as e:
                print(f"FAIL {name} ({len(blob)} bytes): {e}")
                failed += 1
    finally:
        board.write_table(original)
        board.request("ALL_NOTES_OFF")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
