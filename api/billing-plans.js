import { loadBillingCatalog, publicBillingCatalog } from './_lib/billing/catalog.js';

export function createBillingPlansHandler({ loadCatalog = loadBillingCatalog } = {}) {
  return function billingPlansHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const origin = String(req.headers.origin ?? '').trim();
    if (['https://vlineups.ru', 'https://www.vlineups.ru', 'http://localhost:3000'].includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Vary', 'Origin');
    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
    try {
      return res.status(200).json(publicBillingCatalog(loadCatalog()));
    } catch (error) {
      const status = Number(error.status) || 500;
      return res.status(status).json({ error: status >= 500 ? 'billing_unavailable' : error.message });
    }
  };
}

export default createBillingPlansHandler();
