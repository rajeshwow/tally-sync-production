# RDP Historical Transaction Sync Runbook

This version is built for real/RDP Tally data. Do not run all transaction modules together on RDP.

## What changed

- Added separate module routes:
  - `POST /sync/historical/sales-vouchers`
  - `POST /sync/historical/purchase-vouchers`
  - `POST /sync/historical/outstandings`
  - Short aliases: `/sync/historical/so`, `/sync/historical/po`, `/sync/historical/os`
- Sales/Purchase run month-wise automatically using `HISTORICAL_TRANSACTION_RANGE_MONTHS=1`.
- Each company + module + range is checkpointed in `.tally-sync-checkpoints.json`.
- Re-running the same route skips successful ranges and retries failed ranges.
- CRM payload is reduced for RDP by stripping `raw_tally_data` when `CRM_STRIP_RAW_TALLY_DATA=true`.
- CRM duplicate payload aliases were reduced to avoid large request bodies.
- A failing range does not crash the whole historical transaction job; final status becomes `partial_success` with `failedItems`.

## Safe RDP .env values

```env
DISABLE_AUTO_SYNC=true
HISTORICAL_TRANSACTION_RANGE_MONTHS=1
BATCH_SIZE_SALES_ORDERS=1
BATCH_SIZE_PURCHASE_ORDERS=1
BATCH_SIZE_OUTSTANDINGS=5
TALLY_RETRY_ATTEMPTS=2
CRM_RETRY_ATTEMPTS=2
TALLY_REQUEST_TIMEOUT_MS=600000
CRM_REQUEST_TIMEOUT_MS=600000
CRM_STRIP_RAW_TALLY_DATA=true
SYNC_CHECKPOINT_FILE=.tally-sync-checkpoints.json
```

## Start agent

```bat
npm run dev
```

## Run Sales vouchers full range

```bat
C:\Windows\System32\curl.exe -X POST "http://127.0.0.1:5050/sync/historical/sales-vouchers" ^
-H "Authorization: Bearer {{agentToken}}" ^
-H "Content-Type: application/json" ^
-d "{\"fromDate\":\"20230401\",\"toDate\":\"20260619\"}"
```

## Run Purchase vouchers full range

```bat
C:\Windows\System32\curl.exe -X POST "http://127.0.0.1:5050/sync/historical/purchase-vouchers" ^
-H "Authorization: Bearer {{agentToken}}" ^
-H "Content-Type: application/json" ^
-d "{\"fromDate\":\"20230401\",\"toDate\":\"20260619\"}"
```

## Run Outstandings

```bat
C:\Windows\System32\curl.exe -X POST "http://127.0.0.1:5050/sync/historical/outstandings" ^
-H "Authorization: Bearer {{agentToken}}" ^
-H "Content-Type: application/json" ^
-d "{\"fromDate\":\"20230401\",\"toDate\":\"20260619\"}"
```

## Check status

```bat
C:\Windows\System32\curl.exe -X GET "http://127.0.0.1:5050/sync/historical-transactions/status" ^
-H "Authorization: Bearer {{agentToken}}"
```

## Retry failed ranges

Run the same command again. Successful ranges will be skipped automatically.

## Force restart a module

Use only when you intentionally want to clear checkpoints for the selected module.

```bat
C:\Windows\System32\curl.exe -X POST "http://127.0.0.1:5050/sync/historical/sales-vouchers" ^
-H "Authorization: Bearer {{agentToken}}" ^
-H "Content-Type: application/json" ^
-d "{\"fromDate\":\"20230401\",\"toDate\":\"20260619\",\"forceRestart\":true}"
```

## Manual reset

Delete `.tally-sync-checkpoints.json` only if you want a full fresh retry.
