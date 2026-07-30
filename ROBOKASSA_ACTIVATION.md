# Активация Robokassa для VLineups

Подготовлено: 30.07.2026.

## URL в личном кабинете Robokassa

Установить HTTPS и следующие адреса:

| Поле Robokassa | URL | Метод |
| --- | --- | --- |
| Result URL | `https://vlineups.ru/api/billing/webhook/robokassa` | POST |
| Success URL | `https://vlineups.ru/payment/success` | GET |
| Fail URL | `https://vlineups.ru/payment/fail` | GET |

Result URL — единственный callback, который выдаёт права. Success URL лишь
показывает пользователю серверный статус заказа.

## Переменные окружения VPS

Заполнить значения в окружении PM2, не коммитить секреты:

```dotenv
BILLING_ENABLED=true
BILLING_PROVIDER=robokassa
BILLING_CATALOG_JSON=<однострочный JSON из docs/billing_catalog_v1.json>
BILLING_TERMS_VERSION=2026-08-01
BILLING_INTRO_IDENTITY_PEPPER=<случайная строка минимум 32 символа>
ROBOKASSA_MERCHANT_LOGIN=<идентификатор магазина>
ROBOKASSA_PASSWORD_1=<пароль №1>
ROBOKASSA_PASSWORD_2=<пароль №2>
ROBOKASSA_HASH_ALGORITHM=sha256
ROBOKASSA_TEST_MODE=true
ROBOKASSA_INVOICE_START=<свободный числовой диапазон счетов>
BILLING_RECONCILIATION_TOKEN=<случайный серверный токен минимум 32 символа>
```

После изменения выполнить `pm2 reload ecosystem.config.cjs --update-env`,
затем проверить `/ready`. Сначала оставить `ROBOKASSA_TEST_MODE=true`.

## Контрольный сценарий до production

1. Войти тестовым Firebase-аккаунтом без активного уровня.
2. Купить тестовый тариф на один месяц.
3. Убедиться, что Robokassa вернула на `/payment/success?InvId=...`.
4. До Result URL страница должна показывать ожидание и не выдавать уровень.
5. После подписанного Result URL заказ становится `succeeded`, появляется одна
   запись charge в ledger и активный `account_entitlements/{uid}`.
6. Обновить приложение: уровень, срок и возможности должны совпасть с заказом.
7. В админке открыть «Платежи»: видны заказ, сумма, статус и срок доступа.
8. Повторить тот же Result URL: срок и ledger не должны измениться второй раз.
9. Выполнить тестовый полный reversal через поддерживаемую сверку: order/payment
   становятся `reversed`, ledger получает одну отрицательную запись, относящееся
   к покупке окно доступа снимается.
10. Повторить сверку reversal: повторных списаний или изменений прав нет.
11. Проверить отмену оплаты: `/payment/fail` не выдаёт права.

После успешного сценария заменить тестовые credentials на production, поставить
`ROBOKASSA_TEST_MODE=false`, перезагрузить PM2 и провести одну минимальную
реальную контрольную оплату. Reconciliation включать по расписанию только после
проверки реального возврата и согласования бухгалтерского процесса.

## Чек-лист после активации

- секреты есть только на VPS;
- `BILLING_ENABLED=true`, каталог и версия условий совпадают с приложением;
- Result URL отвечает `OK<InvId>` только на корректную подпись;
- Success/Fail страницы доступны по HTTPS;
- в админке нет прямого клиентского чтения закрытых billing-коллекций;
- cron reconciliation использует отдельный токен и ограниченный batch;
- настроен мониторинг 5xx на billing endpoints и заказов `requires_review`.
