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
  if (code === 'SHELL_BUSY') {
    message = `${operation} 작업을 지금 실행할 수 없습니다. 진행 중인 Windows 셸 메뉴·드래그를 마친 뒤 다시 시도해 주세요.`;
  } else if (code === 'ACTION_BUSY') {
    message = `${operation} 작업을 지금 실행할 수 없습니다. 진행 중인 파일 작업을 마친 뒤 다시 시도해 주세요.`;
  } else if (code === 'SHELL_CANCELLED') {
    message = `${operation} 작업이 취소되었습니다.`;
  } else if (code === 'SHELL_CLOSED') {
    message = `${operation} 작업을 실행할 수 없습니다. Windows 셸 서비스가 종료되었습니다.`;
  } else if (code === 'SHELL_TIMEOUT') {
    message = error?.outcomeUncertain === false
      ? `${operation} 요청의 대기 시간이 초과되어 실행 전에 취소되었습니다. 자동으로 다시 시도하지 않습니다.`
      : `${operation} 응답 대기 시간이 초과되었습니다. 작업이 일부 또는 전부 실행되었을 수 있어 결과를 확인할 수 없습니다. 파일과 대상 폴더를 확인해 주세요. 자동으로 다시 시도하지 않습니다.`;
  } else if (code === 'SHELL_HELPER_EXITED') {
    message = `${operation} 처리 중 Windows 셸 도우미가 종료되었습니다. 대상 폴더의 처리 결과를 확인한 뒤 다시 시도해 주세요.`;
  } else if (code === 'SHELL_DISCONNECTED') {
    message = error?.phase === 'committing'
      ? `${operation} 응답 연결이 끊겼습니다. 외부 파일 작업이 진행 중이거나 이미 실행되었을 수 있어 완료·취소 여부를 확인할 수 없습니다. 원본과 대상 폴더의 처리 결과를 확인해 주세요. 자동으로 다시 시도하지 않습니다.`
      : error?.outcomeUncertain === false
        ? `${operation} 요청이 실행되기 전에 Windows 셸 도우미 연결이 끊겼습니다. 셸 작업 복구 후 다시 시도해 주세요. 자동으로 다시 시도하지 않습니다.`
        : `${operation} 응답 연결이 끊겨 처리 결과를 확인할 수 없습니다. 원본과 대상 폴더를 확인한 뒤 셸 작업 복구를 사용해 주세요. 복구되지 않으면 앱을 다시 시작해 주세요. 자동으로 다시 시도하지 않습니다.`;
  } else if (error?.phase === 'committing' && error?.outcomeUncertain === true) {
    message = `${operation} 처리 중 오류가 발생했습니다. 외부 파일 작업의 완료·취소 여부를 확인할 수 없습니다. 원본과 대상 폴더의 처리 결과를 확인해 주세요. 자동으로 다시 시도하지 않습니다.`;
  } else if (code === 'SHELL_RECOVERY_FAILED') {
    message = `${operation} 작업을 준비하지 못했습니다. 이전 Windows 셸 도우미의 종료를 확인하지 못해 잠시 후 다시 시도해 주세요.`;
  }
  const result = { code, message, details: error?.message || String(error) };
  // Keep diagnostics separate from the operation-specific user message. In
  // particular, helper launch/COM errors do not imply folder access permissions.
  for (const key of ['nativeError', 'hresult', 'errno', 'syscall', 'path', 'exitCode', 'signal',
    'requestId', 'mode', 'phase', 'timeoutMs', 'outcomeUncertain', 'retryable', 'transportCode']) {
    if (error?.[key] !== undefined) result[key] = error[key];
  }
  return { ok: false, error: result };
}

module.exports = { shellErrorResult };
