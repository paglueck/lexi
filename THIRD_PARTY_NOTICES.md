# Third-party notices

Lexi's own code is licensed under the GNU General Public License v3.0 or later (see
[LICENSE](LICENSE) and [NOTICE.txt](NOTICE.txt)). Third-party components retain their own
licenses; Lexi's license does not replace them. The code dependencies are under permissive
licenses (MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, Apache-2.0, BlueOak-1.0.0, Python-2.0) that
are compatible with the GPLv3. The fonts are under the SIL Open Font License and ship as separate
files alongside the program. The license texts that have to travel with the software are in
[`licenses/`](licenses/) and are copied into every build (web, CLI and desktop).

Inventory as of 2026-11-16, taken from `package-lock.json` (production dependencies only). A
generated inventory is a starting point, not a complete license-compatibility assessment —
re-check it whenever dependencies change.

## Fonts

Bundled into the web UI (`apps/web/public/fonts/`, generated from the `@fontsource` packages).
All are licensed under the SIL Open Font License 1.1; the full texts with their copyright lines
are in [`licenses/fonts/`](licenses/fonts/).

| Font | Package | Copyright | License |
|---|---|---|---|
| Public Sans | `@fontsource-variable/public-sans` 5.3.0 | The Public Sans Project Authors | OFL-1.1 |
| IBM Plex Mono | `@fontsource/ibm-plex-mono` 5.3.0 | IBM Corp. | OFL-1.1 |
| Noto Sans | `@fontsource-variable/noto-sans` 5.3.0 | The Noto Project Authors | OFL-1.1 |
| Noto Sans Arabic | `@fontsource-variable/noto-sans-arabic` 5.3.0 | The Noto Project Authors | OFL-1.1 |
| Noto Sans Hebrew | `@fontsource-variable/noto-sans-hebrew` 5.3.0 | The Noto Project Authors | OFL-1.1 |
| Noto Sans Mono | `@fontsource-variable/noto-sans-mono` 5.3.0 | The Noto Project Authors | OFL-1.1 |

## Icons

| Component | Source | Rights holder | License | Used in |
|---|---|---|---|---|
| Lucide icon path data | https://lucide.dev | Lucide Icons and Contributors; Feather-derived icons Cole Bemis | ISC; Feather-derived icons MIT | `apps/web/src/app/ui/icon.ts` — [`licenses/lucide.txt`](licenses/lucide.txt) (upstream LICENSE, verbatim) |

## GitHub Copilot SDK (desktop builds)

`@github/copilot-sdk` and its dependencies declare MIT. The desktop installers also ship the
platform package for their target (`@github/copilot-sdk-<os>-<arch>`), which declares MIT in its
`package.json` and contains a native runtime and a ripgrep binary but no license files of its
own. Lexi talks to that runtime as a separate program. Source and npm-based use install the SDK
from the registry.

## npm production dependencies

Bundled into the web UI or the server (`apps/server/dist/main.js`), installed alongside it, or
shipped in the desktop app (`electron-updater` and its dependencies).
`npm run build` collects the license text of every package below into
`third-party-licenses.txt` (`scripts/collect-licenses.mjs`), which the CLI serves and the desktop
app ships; Angular additionally writes `3rdpartylicenses.txt` for the browser bundle. The
Apache-2.0 text for `rxjs` is also in [`licenses/rxjs-Apache-2.0.txt`](licenses/rxjs-Apache-2.0.txt).

| Package | Version | License |
|---|---|---|
| `@angular/cdk` | 22.2.7 | MIT |
| `@angular/common` | 22.2.6 | MIT |
| `@angular/compiler` | 22.2.6 | MIT |
| `@angular/core` | 22.2.6 | MIT |
| `@angular/forms` | 22.2.6 | MIT |
| `@angular/platform-browser` | 22.2.6 | MIT |
| `@angular/router` | 22.2.6 | MIT |
| `@fastify/accept-negotiator` | 2.1.2 | MIT |
| `@fastify/ajv-compiler` | 4.0.7 | MIT |
| `@fastify/deepmerge` | 3.2.4 | MIT |
| `@fastify/error` | 4.2.1 | MIT |
| `@fastify/fast-json-stringify-compiler` | 5.2.0 | MIT |
| `@fastify/forwarded` | 3.1.2 | MIT |
| `@fastify/merge-json-schemas` | 0.2.2 | MIT |
| `@fastify/proxy-addr` | 5.1.3 | MIT |
| `@fastify/send` | 4.2.1 | MIT |
| `@fastify/static` | 10.1.11 | MIT |
| `@fontsource-variable/noto-sans` | 5.3.0 | OFL-1.1 |
| `@fontsource-variable/noto-sans-arabic` | 5.3.0 | OFL-1.1 |
| `@fontsource-variable/noto-sans-hebrew` | 5.3.0 | OFL-1.1 |
| `@fontsource-variable/noto-sans-mono` | 5.3.0 | OFL-1.1 |
| `@fontsource-variable/public-sans` | 5.3.0 | OFL-1.1 |
| `@fontsource/ibm-plex-mono` | 5.3.0 | OFL-1.1 |
| `@github/copilot-sdk` | 1.0.34 | MIT |
| `@github/copilot-sdk-darwin-arm64` | 1.0.34 | MIT |
| `@github/copilot-sdk-darwin-x64` | 1.0.34 | MIT |
| `@github/copilot-sdk-linux-arm64` | 1.0.34 | MIT |
| `@github/copilot-sdk-linux-x64` | 1.0.34 | MIT |
| `@github/copilot-sdk-linuxmusl-arm64` | 1.0.34 | MIT |
| `@github/copilot-sdk-linuxmusl-x64` | 1.0.34 | MIT |
| `@github/copilot-sdk-win32-arm64` | 1.0.34 | MIT |
| `@github/copilot-sdk-win32-x64` | 1.0.34 | MIT |
| `@isaacs/nonrecursive-glob-match` | 1.1.0 | BlueOak-1.0.0 |
| `@koromix/koffi-android-arm64` | 3.3.6 | MIT |
| `@koromix/koffi-android-x64` | 3.3.6 | MIT |
| `@koromix/koffi-darwin-arm64` | 3.3.6 | MIT |
| `@koromix/koffi-darwin-x64` | 3.3.6 | MIT |
| `@koromix/koffi-freebsd-arm64` | 3.3.6 | MIT |
| `@koromix/koffi-freebsd-ia32` | 3.3.6 | MIT |
| `@koromix/koffi-freebsd-x64` | 3.3.6 | MIT |
| `@koromix/koffi-linux-arm` | 3.3.6 | MIT |
| `@koromix/koffi-linux-arm64` | 3.3.6 | MIT |
| `@koromix/koffi-linux-ia32` | 3.3.6 | MIT |
| `@koromix/koffi-linux-loong64` | 3.3.6 | MIT |
| `@koromix/koffi-linux-ppc64` | 3.3.6 | MIT |
| `@koromix/koffi-linux-riscv64` | 3.3.6 | MIT |
| `@koromix/koffi-linux-x64` | 3.3.6 | MIT |
| `@koromix/koffi-openbsd-arm64` | 3.3.6 | MIT |
| `@koromix/koffi-openbsd-ia32` | 3.3.6 | MIT |
| `@koromix/koffi-openbsd-x64` | 3.3.6 | MIT |
| `@koromix/koffi-win32-arm64` | 3.3.6 | MIT |
| `@koromix/koffi-win32-ia32` | 3.3.6 | MIT |
| `@koromix/koffi-win32-x64` | 3.3.6 | MIT |
| `@lukeed/ms` | 2.0.2 | MIT |
| `@pinojs/redact` | 0.4.0 | MIT |
| `@standard-schema/spec` | 1.1.0 | MIT |
| `abstract-logging` | 2.0.1 | MIT |
| `ajv` | 8.20.0 | MIT |
| `ajv-formats` | 3.0.1 | MIT |
| `argparse` | 2.0.1 | Python-2.0 |
| `atomic-sleep` | 1.0.0 | MIT |
| `avvio` | 9.3.1 | MIT |
| `balanced-match` | 4.0.4 | MIT |
| `brace-expansion` | 5.0.13 | MIT |
| `builder-util-runtime` | 9.7.0 | MIT |
| `content-disposition` | 3.0.0 | MIT |
| `cookie` | 2.0.2 | MIT |
| `debug` | 4.4.3 | MIT |
| `depd` | 2.0.0 | MIT |
| `dequal` | 2.0.3 | MIT |
| `dom-serializer` | 3.1.1 | MIT |
| `domelementtype` | 3.0.0 | BSD-2-Clause |
| `domhandler` | 6.0.1 | BSD-2-Clause |
| `domutils` | 4.0.2 | BSD-2-Clause |
| `electron-updater` | 6.8.11 | MIT |
| `entities` | 8.1.0 | BSD-2-Clause |
| `entities` | 9.0.0 | BSD-2-Clause |
| `escape-html` | 1.0.3 | MIT |
| `fast-decode-uri-component` | 1.0.1 | MIT |
| `fast-deep-equal` | 3.1.3 | MIT |
| `fast-json-stringify` | 7.3.6 | MIT |
| `fast-querystring` | 1.1.2 | MIT |
| `fast-uri` | 3.1.9 | BSD-3-Clause |
| `fast-uri` | 4.2.3 | BSD-3-Clause |
| `fastify` | 5.12.8 | MIT |
| `fastify-plugin` | 6.0.1 | MIT |
| `fastq` | 1.20.3 | ISC |
| `find-my-way` | 9.10.1 | MIT |
| `fs-extra` | 10.1.0 | MIT |
| `glob` | 14.0.6 | BlueOak-1.0.0 |
| `graceful-fs` | 4.2.12 | BlueOak-1.0.0 |
| `htmlparser2` | 12.0.0 | MIT |
| `http-errors` | 2.0.1 | MIT |
| `inherits` | 2.0.4 | ISC |
| `ipaddr.js` | 2.5.0 | MIT |
| `js-yaml` | 4.3.2 | MIT |
| `json-schema-ref-resolver` | 3.0.1 | MIT |
| `json-schema-traverse` | 1.0.0 | MIT |
| `jsonfile` | 6.2.1 | MIT |
| `koffi` | 3.3.6 | MIT |
| `lazy-val` | 1.0.5 | MIT |
| `light-my-request` | 6.8.1 | BSD-3-Clause |
| `lodash.escaperegexp` | 4.1.2 | MIT |
| `lodash.isequal` | 4.5.0 | MIT |
| `lossless-json` | 4.3.3 | MIT |
| `lru-cache` | 11.5.3 | BlueOak-1.0.0 |
| `mime` | 3.0.0 | MIT |
| `minimatch` | 11.0.8 | BlueOak-1.0.0 |
| `minipass` | 7.1.3 | BlueOak-1.0.0 |
| `ms` | 2.1.3 | MIT |
| `on-exit-leak-free` | 2.1.2 | MIT |
| `parse5` | 8.1.1 | MIT |
| `path-scurry` | 3.0.0 | BlueOak-1.0.0 |
| `pino` | 10.4.0 | MIT |
| `pino-abstract-transport` | 3.0.0 | MIT |
| `pino-std-serializers` | 7.1.0 | MIT |
| `process-warning` | 5.1.1 | MIT |
| `quick-format-unescaped` | 4.0.4 | MIT |
| `real-require` | 1.0.0 | MIT |
| `require-from-string` | 2.0.2 | MIT |
| `ret` | 0.5.1 | MIT |
| `reusify` | 1.1.0 | MIT |
| `rfdc` | 1.4.1 | MIT |
| `rxjs` | 7.8.2 | Apache-2.0 |
| `safe-regex2` | 5.1.2 | MIT |
| `safe-stable-stringify` | 2.5.0 | MIT |
| `sax` | 1.6.1 | BlueOak-1.0.0 |
| `secure-json-parse` | 4.1.1 | BSD-3-Clause |
| `semver` | 7.7.4 | ISC |
| `semver` | 7.8.6 | ISC |
| `set-cookie-parser` | 3.2.3 | MIT |
| `setprototypeof` | 1.2.0 | ISC |
| `sonic-boom` | 4.2.1 | MIT |
| `split2` | 4.2.0 | ISC |
| `statuses` | 2.0.2 | MIT |
| `thread-stream` | 4.2.1 | MIT |
| `tiny-typed-emitter` | 2.1.0 | MIT |
| `toad-cache` | 3.7.4 | MIT |
| `toidentifier` | 1.0.1 | MIT |
| `tslib` | 2.9.1 | 0BSD |
| `universalify` | 2.0.1 | MIT |
| `vscode-jsonrpc` | 10.0.0 | MIT |
| `yaml` | 2.9.1 | ISC |
| `zod` | 4.6.7 | MIT |

No GPL, LGPL, AGPL, MPL, EPL or CC-BY-SA licensed production dependency was found.
