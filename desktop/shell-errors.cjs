'use strict';

const operations = {
  'pane:shell-menu': 'Windows 셸 메뉴',
  'pane:read-shell-clipboard': '클립보드 읽기',
  'pane:write-shell-clipboard': '클립보드 복사·잘라내기',
  'pane:complete-shell-paste': '클립보드 붙여넣기 완료 처리',
  'pane:begin-native-drag': 'Windows 파일 드래그',
  'pane:cancel-shell': 'Windows 셸 작업 취소',
};

function shellErrorResult(error, channel) {
  if (!Object.hasOwn(operations, channel)) return undefined;
  const operation = operations[channel];
  const code = error?.code ?? 'SHELL_FAILED';
  let message = `${operation} 작업을 완료하지 못했습니다. 다시 시도해 주세요.`;
  if (code === 'SHELL_BUSY' || code === 'ACTION_BUSY') {
    message = `${operation} 작업을 지금 실행할 수 없습니다. 진행 중인 메뉴·드래그 또는 파일 작업을 마친 뒤 다시 시도해 주세요.`;
  } else if (code === 'SHELL_CANCELLED') {
    message = `${operation} 작업이 취소되었습니다.`;
  } else if (code === 'SHELL_HELPER_EXITED') {
    message = `${operation} 처리 중 Windows 셸 도우미가 종료되었습니다. 다시 시도해 주세요.`;
  }
  const result = { code, message, details: error?.message || String(error) };
  // Keep diagnostics separate from the operation-specific user message. In
  // particular, helper launch/COM errors do not imply folder access permissions.
  for (const key of ['nativeError', 'hresult', 'errno', 'syscall', 'path', 'exitCode', 'signal']) {
    if (error?.[key] !== undefined) result[key] = error[key];
  }
  return { ok: false, error: result };
}

module.exports = { shellErrorResult };
