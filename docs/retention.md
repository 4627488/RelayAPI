# Data retention

RelayAPI keeps short-lived request detail, medium-lived request summaries and
long-lived daily aggregates. Cleanup runs hourly with a PostgreSQL advisory
transaction lock, `SKIP LOCKED`, bounded batches and a maximum runtime.

| Data | Default retention |
| --- | --- |
| Successful, pricing-complete detail | deterministic sample, 1 day |
| Error or pricing-incomplete detail | 14 days |
| Request summaries | 30 days, rolled up before deletion |
| Unmatched upstream lifecycle events | 24 hours |
| Processed lifecycle events | success 24 hours, error 7 days |
| Settled/released/expired reservations | 14 days |
| Pricing-incomplete reservations | 90 days |
| Parent quota observations | 180 days |
| Used/revoked/expired invitations | 30 days |
| Billing ledger and manual credits | retained |

Request, forwarded-request and upstream-response captures are bounded and only
stored in the detail table. Setting a retention duration to zero disables that
cleanup class; it does not immediately delete data.
