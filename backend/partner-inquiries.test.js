import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePartnerInquiry, validatePartnerInquiry } from './partner-inquiries.js';

test('normalizes and accepts a complete partner inquiry', () => {
  const inquiry = normalizePartnerInquiry({
    name: '  Анна  ', contact: ' @anna ', website: 'https://example.com',
    message: 'Хотим обсудить нативную кампанию для игроков Valorant.',
  });
  assert.equal(inquiry.name, 'Анна');
  assert.equal(inquiry.contact, '@anna');
  assert.equal(validatePartnerInquiry(inquiry), '');
});

test('rejects short messages and invalid links', () => {
  assert.equal(validatePartnerInquiry(normalizePartnerInquiry({ name:'Иван', contact:'@ivan', message:'Коротко' })), 'message_too_short');
  assert.equal(validatePartnerInquiry(normalizePartnerInquiry({ name:'Иван', contact:'@ivan', message:'Достаточно длинное описание рекламного предложения.', website:'example.com' })), 'website_invalid');
});

test('silently identifies the honeypot field', () => {
  const inquiry = normalizePartnerInquiry({ name:'Bot', contact:'bot@example.com', message:'Automated advertising inquiry message', website_confirm:'spam' });
  assert.equal(validatePartnerInquiry(inquiry), 'spam_detected');
});
