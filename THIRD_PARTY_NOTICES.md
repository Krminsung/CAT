# Third-party notices

`cat-agent-cli` 자체 코드는 공개 license가 부여되지 않은 `UNLICENSED` 상태다. 이 문서는 독립적인
권리 허가가 아니라 standalone 설치본에 포함되는 고정 third-party 구성요소의 package metadata와
license 위치를 기록한다. 실제 설치본은 npm package가 제공한 `LICENSE` 파일을 있는 그대로
`node_modules` 안에 포함하고, 별도 파일이 없는 package의 MIT metadata/notice는 이 문서에 보존한다.
공식 Node.js 배포본의 `LICENSE`도 `.runtime/node/LICENSE`에 포함한다.

## Production npm dependency

| package | version | license | attribution / upstream |
|---|---:|---|---|
| `@earendil-works/pi-tui` | 0.85.1 | MIT | Mario Zechner; `github.com/earendil-works/pi` |
| `get-east-asian-width` | 1.6.0 | MIT | Sindre Sorhus; `github.com/sindresorhus/get-east-asian-width` |
| `marked` | 18.0.5 | MIT 및 포함된 Markdown license | MarkedJS, Christopher Jeffrey; `github.com/markedjs/marked` |
| `ajv` | 8.20.0 | MIT | Copyright 2015–2021 Evgeny Poberezkin; `github.com/ajv-validator/ajv` |
| `fast-deep-equal` | 3.1.3 | MIT | Copyright 2017 Evgeny Poberezkin; `github.com/epoberezkin/fast-deep-equal` |
| `fast-uri` | 3.1.7 | BSD-3-Clause | Gary Court 및 Fastify team; `github.com/fastify/fast-uri` |
| `json-schema-traverse` | 1.0.0 | MIT | Copyright 2017 Evgeny Poberezkin; `github.com/epoberezkin/json-schema-traverse` |
| `require-from-string` | 2.0.2 | MIT | Copyright Vsevolod Strukchinsky; `github.com/floatdrop/require-from-string` |
| `undici` | 7.29.1 | MIT | Matteo Collina 및 Undici contributors; `github.com/nodejs/undici` |

위 목록은 `package-lock.json`에서 `dev: true`가 아닌 정확한 dependency closure다. TypeScript,
`@types/node`, `undici-types`는 build용 dev dependency이며 standalone payload에는 넣지 않는다.

## Bundled runtime

- Node.js v24.21.0 (Krypton LTS)
- Linux x64 / arm64 공식 `tar.xz` 배포 파일
- upstream: `https://nodejs.org/download/release/v24.21.0/`
- license: 공식 archive 안의 `LICENSE`와 그 파일에서 열거한 third-party notices

정확한 archive 이름과 SHA-256은 `packaging/runtime-manifest.json`에 고정되어 있다.

## MIT permission notice

아래 문구는 위 표에서 MIT로 표시된 구성요소에 적용되며, 각 copyright/author 표시는 위 표와 package
자체 자료에 보존된다.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of
the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

`fast-uri`의 전체 BSD-3-Clause 문구와 `marked`가 포함하는 Markdown license 등 추가 문구는 각
package의 `LICENSE`에 들어 있으며 standalone payload가 그 파일들을 보존한다.
