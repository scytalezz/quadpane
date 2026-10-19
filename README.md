# Quadpane

여러 폴더를 한 화면에 나란히 열고, 패널 사이에서 파일을 복사·이동하는 Windows 멀티패널 파일 탐색기입니다. [Q-Dir](https://www.softwareok.com/?seite=Freeware/Q-Dir)의 멀티패널 개념을 현대적인 UI와 안전한 파일 작업으로 개선하는 것을 목표로 합니다.

- 현재 버전: `0.9.1` (Windows x64 포터블 · 소스 기준 2026-10-19)
- [GitHub 릴리스](https://github.com/scytalezz/quadpane/releases/tag/v0.9.1) · [v0.9.1 릴리스 노트](docs/releases/v0.9.1.md)
- 설치·관리자 권한·별도 Node.js 불필요 — 실행 파일 하나로 동작

> **English** — *Quadpane* is a multi-pane file explorer for Windows, inspired by Q-Dir. It opens up to four folder panes side by side with copy/move between panes, favorites, two workspaces, drag & drop with Windows Explorer, and full session restore. Ships as a single portable x64 executable built on Electron. Built-in transfers skip conflicts and the Delete key uses the Recycle Bin. Windows shell commands follow Windows and extension behavior. Detailed docs below are in Korean.

## 화면

| 라이트 | 다크 |
| --- | --- |
| ![Quadpane 라이트 테마](docs/quadpane-desktop.png) | ![Quadpane 다크 테마](docs/quadpane-dark-desktop.png) |

## 주요 기능

- 1·2·4분할 패널, 현재 패널 확대, 두 작업 공간 전환과 재실행 후 상태 복원
- 드라이브·홈·바탕 화면·다운로드·문서·사진 폴더 탐색, UNC 공유 폴더 경로 지원
- 패널별 뒤로·앞으로 가기 버튼, 마우스 측면 버튼과 `Alt+←/→` 지원
- 한글(청록색 `한`)·Word(파란색 `W`)·PowerPoint(주황색 `P`) 등 확장자별 아이콘, 목록 아이콘 20px와 라이트·다크 테마별 색상
- 즐겨찾기·최근 경로, 주소창 펼침 목록, 열린 폴더의 항목 이름 검색과 정렬
- 패널 간 복사·이동: `Ctrl+C/X/V`, **다른 창으로** 대화상자, 드래그 앤 드롭(`Ctrl` 복사 / `Shift` 이동)
- Windows 탐색기와의 실제 파일 드래그 앤 드롭 (Alt 없이 파일·폴더 내보내기, OLE Copy/Move 지원)
- Windows Explorer 셸 우클릭 메뉴: 파일·폴더·다중 선택·빈 공간, 설치된 셸 확장, Windows 클립보드와 `Ctrl+C/X/V` 연동
- 포커스 복귀 시 클립보드 읽기와 메뉴·드래그 요청의 충돌 수정, 셸 오류를 폴더 읽기 오류(`READ_FAILED`)와 구분해 안내
- 앱 내장 파일 작업: 같은 이름은 건너뜀(덮어쓰기·병합 없음), 삭제는 확인 후 휴지통으로만 이동, 영구 삭제 미제공, NTFS 추가 데이터 스트림 보존

## 포터블 실행

기존 Quadpane를 완전히 종료한 뒤 `quadpane-0.9.1-portable-x64.exe`를 쓰기 가능한 폴더에 두고 실행합니다. 직접 빌드하면 `dist-portable/`에 생성됩니다. 열린 폴더·작업 공간·즐겨찾기·테마와 표시 설정은 실행 파일 옆 `quadpane-data/`에 저장되며, 기존 설정 폴더를 그대로 재사용할 수 있습니다. EXE와 함께 옮기면 설정이 유지됩니다. 자세한 사용법과 저장 구조는 [PORTABLE.md](PORTABLE.md)를 참고합니다.

## 앱 내 업데이트 (v0.9.1부터)

왼쪽 아래에 현재 버전을 표시합니다. 포터블 실행 후 최신 정식 GitHub 릴리스를 백그라운드에서 한 번 확인하며, 버전 버튼으로 다시 확인할 수 있습니다. 새 버전이 있으면 **다운로드 → 업데이트하고 다시 시작** 순서로 진행합니다. 파일 작업 중에는 재시작하지 않으며 작업 공간과 표시 설정을 저장합니다.

새 EXE는 기존 EXE 옆에 저장하고 `quadpane-data`를 그대로 사용합니다. 다운로드한 파일의 SHA-256을 검증하며 기존 EXE는 보관합니다. 인터넷은 업데이트 확인·다운로드에만 필요합니다. 연결되지 않아도 파일 탐색은 계속 사용할 수 있습니다. 기존 v0.9.0 배포 파일에는 이 기능이 없으므로, 기능을 포함한 첫 버전은 직접 내려받아야 합니다.

## v0.9.1 주요 변경

- 외부 드래그 취소·오류 후 이전 셸 도우미의 실제 종료를 확인하고 다음 요청을 받습니다. 새 도우미가 겹쳐 실행되는 문제를 막습니다.
- 마우스를 놓은 뒤 응답이 끊기거나 앱이 강제 종료되어도 도우미가 남지 않도록 종료 감시를 보강합니다. 이미 시작한 외부 파일 전송은 시간만으로 중단하거나 자동 재실행하지 않습니다.
- 드래그 중 포커스 복귀 새로고침 충돌과 취소 후 남는 화면 상태를 수정합니다.
- 왼쪽 아래에 버전을 표시하고 GitHub 정식 릴리스를 확인·다운로드·재시작하는 업데이트 기능을 추가합니다.

자세한 동작과 검증 범위는 [v0.9.1 릴리스 노트](docs/releases/v0.9.1.md)를 참고하세요.

## v0.9.0 주요 변경

- 폴더 목록과 파일 속성을 한 번에 읽고, 조회 도우미와 같은 경로의 동시 요청을 공유해 탐색 부하를 줄입니다. 도우미는 10초 동안 요청이 없으면 종료합니다.
- 폴더를 열거나 뒤로·앞으로 이동할 때 나타나던 “경로 불러오는 중…” 안내를 제거합니다. 기존 목록을 유지하고 새로고침 아이콘으로 로딩 상태를 표시합니다.
- F5와 새로고침 버튼은 최신 메타데이터를 다시 확인합니다. 일반 탐색은 Windows 열거 정보를 사용하므로 다른 하드 링크를 통해 변경한 파일의 크기·날짜가 늦게 반영되면 새로고침을 사용하세요.
- Delete 확인창을 취소한 뒤 다시 열리는 문제를 수정하고, 패널별 새 폴더·이름 변경·휴지통 아이콘과 드래그 선택 여백을 추가합니다.
- 포터블 종료 후 작업표시줄 아이콘이 사라지지 않도록 원본 EXE와 지속되는 아이콘 경로를 사용합니다.

자세한 변경 사항과 검증 범위는 [v0.9.0 릴리스 노트](docs/releases/v0.9.0.md)를 참고하세요.

## v0.8.1 주요 변경

- v0.8.0에서 마우스 버튼을 놓은 뒤에도 네이티브 도우미가 마우스 입력을 붙잡아 Windows 탐색기 드래그까지 막는 문제를 수정합니다.
- 드래그 시작 전 실제 버튼 상태를 확인하고, 버튼 해제 입력이 누락되면 드롭 확정 전에 취소합니다. 앱과 연결이 끊긴 도우미의 종료 처리도 보강합니다.
- 메뉴·드래그 중복 요청을 차단하고 `Escape` 취소 후 입력 복구를 개선합니다. 요청 검증·준비와 클립보드 응답 대기에 시간 제한을 적용합니다.
- 실제 드롭이나 셸 명령이 실행되기 시작하면 오래 걸린다는 이유로 자동 중단하지 않습니다.

확인한 현상과 복구 기록은 [셸 메뉴·드래그 복구 문서](docs/shell-recovery.md)를 참고하세요.

## v0.8.0에서 추가된 기능

- 도구 모음의 **보기**에서 **숨김 항목**, **파일 확장자** 표시를 각각 켜거나 끕니다. 기본값은 숨김 항목 숨기기·확장자 표시이며, 모든 패널에 적용하고 재실행 후에도 유지합니다.
- 숨김 여부는 Windows 파일 속성으로 판단합니다. 확장자를 숨겨도 실제 파일명·아이콘·검색·파일 작업 경로는 유지합니다.
- 목록의 빈 공간 또는 양옆 여백에서 드래그하면 사각형 안의 여러 항목을 선택합니다. `Ctrl`·`Shift`를 누르면 기존 선택에 추가하고, 드래그 도중 `Escape`를 누르면 이전 선택으로 돌아갑니다. 목록 가장자리에서는 자동 스크롤합니다.
- 파일 행을 잡아 끄는 기존 파일 이동은 그대로 사용합니다. 이동 후 클립보드 갱신 실패는 이동 결과와 별도로 알리고, 상위 폴더와 하위 파일을 함께 이동할 때는 중복 처리하지 않습니다.

변경 내용과 검증 범위는 [표시·선택·이동 개선 기록](docs/display-selection.md)을 참고하세요.

## 단축키

| 단축키 | 동작 |
| --- | --- |
| `Ctrl+L` / `Ctrl+K` | 현재 주소창 선택 / 열린 폴더 검색 |
| 주소창에서 `Alt+↓` | 경로 목록 열기 |
| `Alt+←` / `Alt+→` / `Alt+↑` | 뒤로 가기 / 앞으로 가기 / 상위 폴더 |
| 마우스 뒤로·앞으로 가기 버튼 | 현재 활성 패널의 방문 기록 이동 |
| `F5` | 현재 패널 새로고침 |
| `Ctrl+A` | 표시된 항목 전체 선택 |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | 복사 준비 / 이동 준비 / 붙여넣기 |
| `Enter` | 주소 적용 또는 폴더·기본 앱으로 파일 열기 |
| `Alt+Enter` | 파일 정보 보기 |
| `Shift+F10` / 메뉴 키 | 작업 메뉴 열기 |
| `F2` / `Ctrl+Shift+N` | 이름 변경 / 새 폴더 |
| `Delete` | 확인 후 휴지통으로 이동 |
| 드래그 중 `Ctrl` / `Shift` | 복사 / 이동 지정 |
| 일반 드래그 | 탐색기·브라우저로 파일/폴더 끌어내기 (Alt 불필요) |
| `Escape` | 메뉴·대화상자 닫기, 주소 편집·검색·복사 대기 취소 |

## 개발

Node.js 24 이상, npm, Windows x64와 .NET Framework 4.x C# 컴파일러가 필요합니다. `npm run build:native`로 셸 도우미를 빌드합니다.

```powershell
npm ci
npm run desktop
```

| 명령 | 용도 |
| --- | --- |
| `npm start` | 루프백 웹 서버 실행 (`http://127.0.0.1:4173`) |
| `npm run desktop` | Electron 앱 개발 실행 |
| `npm run check` | 렌더러·데스크톱 JavaScript 문법 검사 |
| `npm test` | 파일 조회·복사·이동·탐색기 작업과 세션·즐겨찾기 저장 테스트 |
| `npm run build:portable` | Windows x64 포터블 EXE 생성 (`dist-portable/`) |

푸시·PR 시 [GitHub Actions](.github/workflows/windows.yml)가 Windows에서 문법 검사·테스트·포터블 빌드를 실행하고 EXE와 SHA-256 체크섬을 아티팩트로 남깁니다.

## 검증

v0.9.0은 전체 자동 검사와 출시 EXE의 기능 검사를 수행합니다. 상세 결과와 검증 한계는 [PORTABLE.md의 실행 검증](PORTABLE.md#실행-검증)에 기록합니다. 아래 수치는 과거 버전의 기록입니다.

v0.8.1 로컬 검증: JavaScript 34개 파일 문법 검사와 자동 테스트 201개 통과(실패·건너뜀 없음). 도우미 응답·종료, 드래그 취소·경쟁 상황 및 다른 드라이브 간 파일 이동을 확인했습니다.

v0.8.1 배포 후보 EXE에서 셸 연동 7개, 표시·선택·이동 10개, 탐색 9개 검사 그룹과 포터블 런처 3회 실행이 통과했습니다. 최초 실행·재실행·EXE와 설정 폴더 이동 후 복원 및 정상 종료를 확인했습니다. 셸 메뉴·드래그·클립보드 IPC는 테스트용 응답으로 대체하므로 물리적 외부 앱 드롭 검증과 구분합니다.

아래는 과거 v0.8.0 검증 기록이며, v0.8.1의 테스트·빌드 통과를 의미하지 않습니다. 이번 수정의 확인 내용은 [셸 메뉴·드래그 복구 문서](docs/shell-recovery.md)에 기록합니다.

v0.8.0 로컬 검증: JavaScript 32개 파일 문법 검사 통과, 자동 테스트 145개 통과·실패 0개·건너뜀 0개. 다른 드라이브 간 파일·폴더 이동 검사도 포함합니다.

v0.8.0 출시 전 패키징 프리뷰에서 표시·선택·이동 10개, 셸 연동 4개, 탐색 9개 검사 그룹과 포터블 런처 3회 실행이 통과했습니다. 프리뷰 검증은 공식 EXE 실행 검증과 구분합니다.

프리뷰 파일명·해시와 과거 v0.7.0 검증 기록은 [표시·선택·이동 개선 기록](docs/display-selection.md)에 보존합니다.

빌드 후 별도로 준비한 Playwright 의존성 경로를 지정해 실제 앱 동작을 검증할 수 있습니다. 앱 자체에는 Playwright가 필요하지 않습니다.

```powershell
node scripts/verification/verify-real-files.cjs 'Playwright가 들어 있는 node_modules의 절대 경로'
node scripts/verification/verify-workflows.cjs 'Playwright가 들어 있는 node_modules의 절대 경로'
node scripts/verification/verify-explorer.cjs 'Playwright가 들어 있는 node_modules의 절대 경로'
node scripts/verification/verify-navigation.cjs 'Playwright가 들어 있는 node_modules의 절대 경로'
node scripts/verification/verify-display-selection.cjs 'Playwright가 들어 있는 node_modules의 절대 경로'
node scripts/verification/verify-pane-actions.cjs 'Playwright가 들어 있는 node_modules의 절대 경로' 'dist-portable/win-unpacked/Quadpane.exe'
node scripts/verification/verify-loading.cjs 'Playwright가 들어 있는 node_modules의 절대 경로' 'dist-portable/win-unpacked/Quadpane.exe'
node scripts/verification/verify-launcher.cjs 'Playwright가 들어 있는 node_modules의 절대 경로'
```

과거 검증 기록(v0.5.0): `npm run check` 28개 파일 통과, 전체 `npm test` 59개 통과·1개 건너뜀·실패 0개. 로컬 `0.5.0-fixed` 빌드가 성공했으며, 실제 패키징 앱에서 클립보드·메뉴 IPC 중첩 충돌을 재현한 뒤 수정 결과를 확인했습니다. 물리적 UI 수동 검증과는 구분됩니다.

검증 데이터와 결과는 `.checks/`에 생성됩니다(Git 추적 제외). 현재 검증 범위는 [셸 통합 문서](docs/windows-shell.md), 과거 검증 기록은 [VERIFICATION.md](VERIFICATION.md)를 참고합니다.

## 문서

| 문서 | 내용 |
| --- | --- |
| [DESIGN.md](DESIGN.md) | 화면 구성과 인터페이스 설계 원칙 |
| [PORTABLE.md](PORTABLE.md) | 포터블 실행, 설정 저장 구조, 개발·빌드 상세 |
| [VERIFICATION.md](VERIFICATION.md) | 실행 검증 결과와 검증 범위·한계 |
| [Windows 셸 통합](docs/windows-shell.md) | 클래식 메뉴·드래그·클립보드 동작과 검증 범위 |
| [셸 메뉴·드래그 복구](docs/shell-recovery.md) | v0.8.0 캡처 잔류 현상과 v0.8.1 수정·검증 기록 |
| [표시·선택·이동 개선](docs/display-selection.md) | v0.8.0 표시 설정·드래그 선택·이동 안정성 개선과 프리뷰 검증 이력 |
| [v0.8.1 릴리스 노트](docs/releases/v0.8.1.md) | 네이티브 드래그의 캡처 잔류와 메뉴·드래그 복구 개선 |
| [v0.8.0 릴리스 노트](docs/releases/v0.8.0.md) | 숨김 항목·확장자 표시, 드래그 다중 선택과 파일 이동 안정성 개선 |
| [v0.7.0 릴리스 노트](docs/releases/v0.7.0.md) | 패널별 앞으로 가기, 마우스 측면 버튼 수정과 방문 기록 안정성 개선 |
| [v0.6.0 개발 기록](docs/releases/v0.6.0.md) | 미배포 개발 버전의 변경 사항과 검증 기록 |
| [v0.5.1 릴리스 노트](docs/releases/v0.5.1.md) | 파일 아이콘 개선과 마우스 뒤로가기 지원 |
| [v0.5.0 릴리스 노트](docs/releases/v0.5.0.md) | 과거 변경 사항·제한 사항과 검증 기록 |

## 제한 사항

- Windows 11의 간소화 메뉴 대신 클래식 Explorer 셸 메뉴를 제공합니다. 확장별 호환성과 검증 범위는 [셸 통합 문서](docs/windows-shell.md)를 참고하세요.
- 외부에서 들어오는 드롭은 `Shift`를 눌러도 복사입니다. 외부로 이동할 때는 대상이 이동 전체를 수행해야 하며, 복사 후 원본 삭제를 앱에 요청하는 대상에서는 원본이 남습니다.
- 실제 Windows 메뉴 클릭, Explorer·브라우저로의 물리적 드롭, 클립보드 왕복은 수동 검증이 남아 있습니다. 과거 검증 기록은 현재 버전의 테스트·빌드 통과를 의미하지 않습니다.
- 앱 내장 작업은 덮어쓰기·병합·영구 삭제를 제공하지 않습니다. 셸 메뉴와 외부 드롭 대상은 Windows 또는 확장 프로그램의 동작·확인을 따릅니다.
- 현재 빌드는 코드 서명되지 않은 개발 버전입니다.

## 라이선스

[MIT](LICENSE)
