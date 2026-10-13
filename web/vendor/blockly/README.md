# Blockly (vendored)

[Blockly](https://github.com/RaspberryPiFoundation/blockly) 13.3.0, Apache
License 2.0 (see `LICENSE`). Copied here so the page works offline and from
`file://`.

| File | Source |
|---|---|
| `blockly_compressed.js` | `https://cdn.jsdelivr.net/npm/blockly@13.3.0/blockly_compressed.js` |
| `en.js` | `https://cdn.jsdelivr.net/npm/blockly@13.3.0/msg/en.js` |
| `LICENSE` | `https://cdn.jsdelivr.net/npm/blockly@13.3.0/LICENSE` |

Both scripts are plain (UMD) scripts that set the global `Blockly`. Keyboard
navigation is built into Blockly 13, so the `@blockly/keyboard-navigation`
plugin is not used.

To update: download the same three files for the new version, update this
table, and run `python tools/run_web_tests.py`.
