const params = new URLSearchParams(location.search);
const orderId = params.get('InvId') || params.get('orderId') || '';
const outcome = document.documentElement.dataset.result === 'fail'
  ? 'fail'
  : 'success';
const openAppButton = document.getElementById('open-app');

if (openAppButton && /^\d{1,18}$/.test(orderId)) {
  const appUrl = `vlineupapp://billing/${outcome}?orderId=${encodeURIComponent(orderId)}`;
  openAppButton.href = appUrl;
  openAppButton.hidden = false;

  let seconds = 10;
  const countdown = document.createElement('p');
  countdown.className = 'security-note';
  openAppButton.insertAdjacentElement('afterend', countdown);
  const render = () => {
    countdown.textContent = `Автоматически вернём в приложение через ${seconds} сек.`;
  };
  render();
  const timer = setInterval(() => {
    seconds -= 1;
    render();
    if (seconds <= 0) {
      clearInterval(timer);
      location.href = appUrl;
    }
  }, 1000);
}
