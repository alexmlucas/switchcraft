"""Checks that tables built by the web page are accepted by a real board.

Runs web/test.html in headless Chrome, takes the sample tables it prints,
writes each one to the connected board (without saving), reads it back, and
finally restores the board's working table.

    python tools/check_page_tables.py [--chrome PATH]

Needs a board, Chrome, and: pip install mido python-rtmidi websocket-client
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import sc  # noqa: E402
from run_web_tests import default_chrome, run_page  # noqa: E402


def page_tables(chrome):
    title, out, blobs = run_page(chrome)
    if title != "PASSED":
        sys.exit(f"page unit tests failed:\n{out}")
    for line in blobs.strip().splitlines():
        name, hexdata = line.split()
        yield name, bytes.fromhex(hexdata)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--chrome", default=default_chrome())
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
