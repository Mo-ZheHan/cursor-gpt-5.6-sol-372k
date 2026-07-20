# Cursor for GPT-5.6 Sol 372K

[![CI](https://github.com/Mo-ZheHan/cursor-gpt-5.6-sol-372k/actions/workflows/ci.yml/badge.svg)](https://github.com/Mo-ZheHan/cursor-gpt-5.6-sol-372k/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An unofficial macOS patcher that turns GPT-5.6 Sol's built-in `272K` option
into a working `372K` context window. It creates a separately signed
`/Applications/Cursor 372K.app`, shares your existing Cursor profile, and
leaves the official application untouched.

## How it works

For GPT-5.6 Sol with the built-in `272K` option selected, the patch:

1. displays the option as `372K`;
2. submits it through Cursor's recognized `1M` context route;
3. accounts for checkpoints against a `372K` limit; and
4. invokes Cursor's native summarizer at 90% before submissions and background
   resumes.

The stored selection remains native to Cursor. Explicit `1M` selections, Max
Mode, other models, prompts, tools, and reasoning settings are unchanged. No
proxy, custom summarizer, or separate user data directory is introduced.

## Install

Requires macOS, Node.js 20 or newer, and `/Applications/Cursor.app`.

```sh
git clone https://github.com/Mo-ZheHan/cursor-gpt-5.6-sol-372k.git
cd cursor-gpt-5.6-sol-372k
npm ci
npm run verify
npm run patch:install
open -na "/Applications/Cursor 372K.app"
```

Check an installed copy with `npm run patch:status`.

## Updating

After Cursor updates, quit `Cursor 372K`, update this repository, and run:

```sh
git pull --ff-only
npm ci
npm run patch:install
```

The installer requires every patch point to match exactly once. It validates,
patches, and signs a staging copy before atomically replacing the installed
copy.

## Compatibility

Tested with Cursor `3.12.17` on Apple silicon. Cursor internals are not a public
API, so compatibility is verified again during each rebuild. This project does
not grant model access or bypass upstream limits, and is not affiliated with
Cursor or Anysphere.

To uninstall, quit `Cursor 372K` and move it to the Trash. The official Cursor
installation requires no restoration.

## License

[MIT](LICENSE)
