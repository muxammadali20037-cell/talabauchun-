-- Refunds need the payer's Telegram id even after the account was deleted (payment records are kept for accounting).
alter table payments add column if not exists payer_telegram_id bigint;
update payments p set payer_telegram_id = u.telegram_id from users u where u.id = p.user_id and p.payer_telegram_id is null and p.status in ('paid','refunded');
