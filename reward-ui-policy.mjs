export function rewardProgramAccepting(settings) {
  return settings?.enabled === true;
}

export function rewardActionErrorMessage(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || error || '').trim().split('\n')[0].trim();
  if (code.includes('failed-precondition') &&
      message.includes('not accepting participants')) {
    return 'Программа наград пока не принимает участников';
  }
  return message || 'Неизвестная ошибка';
}

export function canSubmitForRewards(dashboard) {
  return rewardProgramAccepting(dashboard?.settings) &&
    dashboard?.membership?.status === 'active' &&
    dashboard?.membership?.terms_current === true;
}
