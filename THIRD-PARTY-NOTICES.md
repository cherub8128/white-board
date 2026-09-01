# 서드파티 라이선스 고지

이 프로젝트(Pi Pen)는 MIT 라이선스로 배포됩니다. 아래는 함께 배포되거나 빌드에 사용되는
구성요소의 라이선스 현황입니다.

## 배포물에 포함되는 런타임

| 구성요소 | 라이선스 | 비고 |
|---|---|---|
| Electron | MIT | 앱 런타임 |
| Chromium | BSD-3-Clause | Electron에 포함. `LICENSES.chromium.html`이 설치 폴더에 동봉됨 |
| Node.js | MIT | Electron에 포함 |
| FFmpeg (Electron 기본 빌드) | LGPL-2.1 | 동적 링크 형태로 포함되어 재배포 가능 |

앱 자체 소스(main.js, preload.js, renderer/)는 외부 런타임 의존성이 없습니다.
번들되는 npm 런타임 패키지는 없습니다(`dependencies` 비어 있음).

## 빌드 전용 의존성 (배포물에 포함되지 않음)

`devDependencies`(electron, electron-builder) 및 그 전이 의존성 404개를 스캔한 결과:

| 라이선스 | 패키지 수 |
|---|---|
| MIT | 297 |
| ISC | 73 |
| Apache-2.0 | 10 |
| BlueOak-1.0.0 | 8 |
| BSD-2-Clause | 6 |
| BSD-3-Clause | 5 |
| Python-2.0 | 1 |
| WTFPL 계열 / CC0 듀얼 | 4 |

**GPL·AGPL·LGPL·SSPL·BUSL 등 카피레프트 또는 상업적 제한이 있는 라이선스는 발견되지 않았습니다.**
전부 허용적(permissive) 라이선스이므로 MIT로 공개 배포하는 데 충돌이 없습니다.

재검증:

```bash
npm ls --all --json > /dev/null && npm run license-check
```
