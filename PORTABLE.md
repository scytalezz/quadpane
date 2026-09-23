# Windows 포터블 실행

`0.5.0`은 실제 Windows 파일·폴더 탐색과 복사·이동을 지원하는 x64 앱입니다. 기본 앱으로 파일 열기, 탐색기에서 보기, 이름 변경, 새 폴더, 확인 후 휴지통 이동과 파일 끌어 놓기를 제공합니다. 변경 사항은 [릴리스 노트](docs/releases/v0.5.0.md)에 정리했습니다.

소스 기준 갱신: 2026-09-23

## 사용과 설정 이동

빌드 후 생성되는 `dist-portable/quadpane-0.5.0-portable-x64.exe`를 쓰기 가능한 폴더에 두고 실행합니다. 설치, 관리자 권한, 별도 Node.js가 필요하지 않습니다. Electron 런타임을 포함합니다.

실행 파일 옆 `quadpane-data/`에는 다음 정보가 저장됩니다.

| 위치 | 내용 |
| --- | --- |
| `session.json` | 선택한 작업 공간, 패널별 전체 경로·정렬, 분할 상태·활성 패널 |
| `preferences.json` | 사용자 즐겨찾기와 최근 경로 |
| `session/` | 테마 선택을 포함한 브라우저 저장소와 캐시 |
| `profile/`, `logs/`, `crashes/` | Electron 프로필, 로그, 크래시 파일 저장 경로 |

앱을 종료한 뒤 EXE와 `quadpane-data/`를 함께 옮기면 설정을 이어서 사용합니다. 기존 `session.json`과 테마 저장소도 그대로 사용합니다. 경로는 절대 경로이므로 다른 PC에서 해당 폴더가 없으면 주소창에서 새 경로를 지정하거나 드라이브 연결 후 재시도합니다.

설정 디렉터리에 쓸 수 없으면 안내 후 종료합니다. 실행 중 저장 실패와 읽을 수 없는 설정은 화면에 알립니다. 설정 경로를 AppData로 자동 변경하지 않습니다.

NSIS portable 런처는 실행에 필요한 파일을 Windows 임시 폴더에 풉니다. 앱 설정은 임시 추출 폴더가 아닌 `PORTABLE_EXECUTABLE_DIR`를 기준으로 저장합니다. 현재 빌드는 코드 서명되지 않은 개발 버전입니다.

## 복사·이동 동작

패널과 작업 공간 사이에서 파일·폴더를 복사하거나 이동할 수 있습니다. 같은 이름의 대상 항목은 건너뛰고, 기존 폴더에 병합하지 않습니다. 링크·정션, 원본 폴더의 하위 대상, 드라이브·공유 루트 전체 작업은 거부합니다.

앱 내부 드래그는 같은 드라이브에서 이동, 다른 드라이브에서 복사를 기본으로 합니다. UNC는 같은 공유 루트를 기준으로 판단하며 `Ctrl`은 복사, `Shift`는 이동을 지정합니다. 대상 패널의 파일 목록과 폴더 항목에 놓을 수 있습니다. Windows 탐색기에서 들어오는 실제 파일 객체도 처리합니다. 문자열 경로를 담은 HTML 드롭은 받지 않습니다.

일반 드래그로 다른 앱에 파일·폴더를 보냅니다(Alt 불필요). 네이티브 도우미가 셸 IDataObject와 OLE DoDragDrop(Copy|Move)을 사용합니다. 외부에서 들어오는 드롭은 Shift를 눌러도 복사입니다. Chromium의 비동기 드롭 응답으로 원본이 조기에 삭제되는 일을 막기 위한 동작입니다. Ctrl+C/X/V와 셸 메뉴는 Windows 파일 클립보드를 공유합니다. 실제 Explorer·브라우저에서 물리적으로 드롭하는 동작은 별도 수동 검증 대상입니다.

외부로의 이동은 Explorer의 최적화된 파일 시스템 이동처럼 대상이 전체 이동을 수행하는 경우에 지원됩니다. 복사 후 원본 삭제를 보내는 앱에 요청하는 일반적인 이동 방식에서는 원본이 남습니다. 도우미는 드롭 후 원본을 삭제하지 않으며, 명시적인 비최적화 MOVE 피드백에는 안내를 표시합니다. 외부 파일을 앱으로 이동하려면 잘라내기·붙여넣기를 사용합니다.

v0.5.0은 포커스 복귀 시 클립보드 읽기와 메뉴·드래그 요청이 겹치는 문제를 수정합니다. 클립보드 작업을 요청 순서대로 처리하고 그 뒤에 메뉴·드래그 하나를 예약합니다. 메뉴·드래그가 예약되거나 실행 중이면 추가 셸 요청은 `SHELL_BUSY`로 거부해 중첩 대기를 막습니다. 셸 실패는 작업별 한국어 안내와 원래 오류 정보를 제공하며, 폴더 읽기 오류(`READ_FAILED`)로 잘못 분류하지 않습니다.

복사는 대상 폴더의 임시 영역에서 준비한 뒤 최종 이름으로 옮깁니다. 파일 복사에는 Windows의 기본 파일 복사를 사용하며 NTFS 추가 데이터 스트림(`Zone.Identifier` 포함)을 함께 보존합니다. 이동은 Windows/.NET 파일 작업을 사용하고 다른 드라이브의 파일·폴더도 처리합니다. 이동이 일부만 끝나면 원본·대상을 자동 정리하지 않고 남은 경로를 결과에 표시합니다.

파일 변경 작업은 한 번에 하나씩 실행합니다. 실행 중 창을 닫으면 작업이 끝난 뒤 종료합니다. 진행 상태는 고정 높이 줄에, 상세 결과는 겹쳐 열리는 창에 표시하므로 작업에 따라 창이나 패널 크기를 바꾸지 않습니다. 조작 방법과 단축키는 [README.md](README.md)에 있습니다.

## 파일 관리와 제한

파일 두 번 클릭과 `Enter`는 Windows 기본 앱을 호출합니다. **파일 정보** 또는 `Alt+Enter`로 메타데이터를 확인하고, **탐색기에서 보기**로 해당 항목을 Windows 탐색기에 표시합니다. 오른쪽 클릭은 Windows IContextMenu 기반 클래식 셸 메뉴입니다. 셸 Rename은 앱의 이름 변경 대화상자로 연결합니다. 셸 메뉴 명령은 내장 파일 작업과 달리 Windows/확장 프로그램의 정책을 따릅니다.

`F2`는 이름 변경, `Ctrl+Shift+N`은 현재 폴더에 새 폴더를 만듭니다. Windows 예약 이름·금지 문자·끝 공백과 마침표를 거부하며, 기존 항목을 덮어쓰지 않습니다. 이름 변경이 일부만 진행되고 복구도 실패하면 남은 임시 경로와 원래 경로를 알립니다.

`Delete`는 취소 버튼에 포커스를 둔 확인 창을 연 뒤 휴지통으로 보냅니다. 확인 전 취소·닫기·`Escape`는 파일을 변경하지 않습니다. 휴지통을 사용할 수 없는 항목은 실패로 표시하며 영구 삭제로 대체하지 않습니다. 영구 삭제와 진행 중인 파일 작업 취소는 제공하지 않습니다.

## 개발과 빌드

```powershell
npm ci
npm run check
npm test
npm run desktop
npm run build:portable
```

개발 설정은 프로젝트의 `.quadpane-dev-data/`에 저장합니다. 패키징 결과는 `dist-portable/`에 생성되며, `win-unpacked/`는 중간 산출물입니다. Electron `44.3.0`, electron-builder `26.16.1`을 잠금 파일과 `npm ci`로 설치합니다. `npm start`는 일반 브라우저에서 포터블 실행 안내를 확인하는 웹 서버입니다.

렌더러는 격리된 [desktop/preload.cjs](desktop/preload.cjs)를 통해 메인 프로세스에 요청합니다.

| API | 역할 |
| --- | --- |
| `bootstrap`, `listDirectory` | 드라이브·설정·폴더 조회 |
| `saveSession`, `savePreferences` | 작업 공간·즐겨찾기·최근 경로 저장 |
| `transfer` | 파일·폴더 복사와 이동 |
| `openPath`, `revealPath` | 기본 앱 열기와 Windows 탐색기 표시 |
| `trashItems`, `renameItem`, `createFolder` | 휴지통 이동·이름 변경·새 폴더 |
| `beginNativeDrag` | 검증한 선택 경로로 Windows 파일 드래그 시작 |
| `droppedPaths` | preload에서 실제 `File`의 파일 시스템 경로 추출 |

메인 프로세스가 호출 화면과 경로를 검사하고 파일 작업·설정 저장을 수행합니다. 복사·이동·휴지통·이름 변경·새 폴더는 공통 실행 잠금을 사용합니다. 렌더러 Node.js 접근, 렌더러의 새 창·외부 페이지 탐색, 웹뷰, 권한 요청 및 다운로드를 차단합니다. 사용자가 선택한 파일의 기본 앱 열기와 탐색기 표시는 메인 프로세스의 Electron `shell` API를 사용합니다.

## 실행 검증

빌드 후 별도로 제공된 Playwright 의존성 경로를 지정합니다.

```powershell
node scripts/verification/verify-real-files.cjs 'Playwright가 들어 있는 node_modules의 절대 경로'
node scripts/verification/verify-workflows.cjs 'Playwright가 들어 있는 node_modules의 절대 경로'
node scripts/verification/verify-explorer.cjs 'Playwright가 들어 있는 node_modules의 절대 경로'
node scripts/verification/verify-launcher.cjs 'Playwright가 들어 있는 node_modules의 절대 경로'
```

셸 변경 검증은 `verify-explorer.cjs`를 사용합니다. 기존 파일 조회·워크플로·런처 검사는 별도 회귀 검사이며 이 변경의 통과를 의미하지 않습니다. 테스트 데이터와 결과는 `.checks/`에 저장합니다.

`verify-explorer.cjs`는 새 `verify-native-shell.cjs`를 실행합니다. 셸 메뉴·OLE 드래그·클립보드 IPC를 가로채고, 다중 선택·키보드·배경 메뉴 요청, 셸 Rename 연결, Ctrl+C/V, 디스크 기반 File 드롭의 실제 복사·이동과 피드백을 검사합니다. 실제 Windows 메뉴 클릭·Explorer/브라우저 드롭 완료·클립보드 왕복 검증을 대신하지 않습니다.

`npm test`는 별도로 실제 Windows COM 메뉴 열거와 도우미 취소/복구를 검사합니다. 상세 구조·공식 API 문서·수동 검증 항목은 [windows-shell.md](docs/windows-shell.md)를 참고하세요.

v0.5.0 검증 결과: `npm run check` 28개 파일 통과, 전체 `npm test` 59개 통과·1개 건너뜀·실패 0개. 로컬 `0.5.0-fixed` 빌드가 성공했으며, 실제 패키징 앱에서 클립보드 읽기와 메뉴 IPC 요청의 중첩 충돌을 재현한 뒤 수정 결과를 확인했습니다.

[VERIFICATION.md](VERIFICATION.md)는 과거 실행 결과와 빌드 식별값을 보존한 기록입니다. 실제 Windows 메뉴 클릭·물리적 드롭·클립보드 왕복은 아직 수동 검증되지 않았습니다.
