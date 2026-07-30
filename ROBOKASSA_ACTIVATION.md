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

Сгенерировать безопасный комплект payload для одноразового тестового заказа:

```bash
ROBOKASSA_MERCHANT_LOGIN=... ROBOKASSA_PASSWORD_2=... \
npm run billing:test-scenarios -- --invoice 700000 --amount 69.30
```

Команда не отправляет запросы и не записывает секреты в файл: она печатает
валидный callback, точный дубликат, неверную подпись и корректно подписанную
чужую сумму для проверки `order_mismatch`.

После успешного сценария заменить тестовые credentials на production, поставить
`ROBOKASSA_TEST_MODE=false`, перезагрузить PM2 и провести одну минимальную
реальную контрольную оплату. Reconciliation включать по расписанию только после
проверки реального возврата и согласования бухгалтерского процесса.

## Подготовленное расписание reconciliation

Файлы находятся в `ops/systemd/`. Установка не включает таймер:

```bash
install -o root -g root -m 0750 \
  ops/run-billing-reconciliation.sh \
  /usr/local/bin/run-vlineups-billing-reconciliation.sh
install -o root -g root -m 0644 \
  ops/systemd/valorant-billing-reconcile.service \
  ops/systemd/valorant-billing-reconcile.timer \
  /etc/systemd/system/
systemctl daemon-reload
systemctl disable --now valorant-billing-reconcile.timer
```

После production-покупки и полного возврата:

```bash
systemctl start valorant-billing-reconcile.service
systemctl status valorant-billing-reconcile.service
systemctl enable --now valorant-billing-reconcile.timer
systemctl list-timers valorant-billing-reconcile.timer
```

Скрипт сам завершится без запроса к провайдеру, пока
`ROBOKASSA_TEST_MODE` не равен `false`.

## Удаление аккаунта

До открытия self-service удаления задать отдельный
`ACCOUNT_DELETION_PEPPER` длиной минимум 32 символа. Сервер:

- требует свежий Firebase-вход не старше 10 минут;
- удаляет ожидающие и отклонённые материалы;
- сохраняет одобренные материалы с автором «Удалённый автор»;
- удаляет профиль, приватную библиотеку, уведомления, права и Auth-аккаунт;
- удаляет прямую персональную связь с billing customer;
- сохраняет обязательную финансовую историю с внутренним UID, который после
  удаления Auth/profile является псевдонимом без публичной связи с человеком;
- переводит незавершённый заказ в `requires_review`, чтобы поздний callback не
  выдал права уже удалённому аккаунту.

## Чек-лист после активации

- секреты есть только на VPS;
- `BILLING_ENABLED=true`, каталог и версия условий совпадают с приложением;
- Result URL отвечает `OK<InvId>` только на корректную подпись;
- Success/Fail страницы доступны по HTTPS;
- в админке нет прямого клиентского чтения закрытых billing-коллекций;
- cron reconciliation использует отдельный токен и ограниченный batch;
- настроен мониторинг 5xx на billing endpoints и заказов `requires_review`.
- в разделе «Платежи» нет зависших `pending` и необъяснённых
  `requires_review`;
- CSV текущей страницы открывается в UTF-8;
- `ACCOUNT_DELETION_PEPPER` задан и тестовое удаление аккаунта прошло;
- timer reconciliation остаётся выключенным до реального теста reversal.
