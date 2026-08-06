const params = new URLSearchParams(location.search);
const orderId = params.get('InvId') || params.get('orderId') || '';
const outcome = document.documentElement.dataset.result === 'fail'
  ? 'fail'
  : 'success';
const openAppButton = document.getElementById('open-app');

if (openAppButton && /^\d{1,18}$/.test(orderId)) {
  openAppButton.href = `vlineupapp://billing/${outcome}?orderId=${encodeURIComponent(orderId)}`;
  openAppButton.hidden = false;
}
