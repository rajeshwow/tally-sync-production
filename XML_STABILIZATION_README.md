# FlexLoud Tally Sync Agent 1.1.0 — Production XML Stabilization

Validated against the production XML capture for:

- Company: `Binary Infosolutions Pvt Ltd (Indore) - (from 1-Apr-23)`
- GUID: `9784a623-df5a-45ef-9d75-bb531569a831`
- Test range: `20260601` to `20260607`

## Fixed in this build

1. Exact multi-company allowlist and shared company selection across masters/historical/daily flows.
2. Cross-process Windows/RDP lock; only one agent process may use the endpoint.
3. Tally HTTP responses fail on empty response, `LINEERROR`, `ERRORS > 0`, or `STATUS=0`.
4. Account-group hierarchy is pulled before ledgers, so nested debtor/creditor groups can become customer/vendor organizations.
5. VAT dealer type `Regular` is no longer used as CRM ledger category.
6. GST is calculated as `max(IGST, CGST + SGST)`; production 18% no longer becomes 36%.
7. Cost-centre allocation is selected from the business ledger first, avoiding duplicate party/inventory allocation totals.
8. `BASICORDERREF` is used only when it looks like a real order reference; salesperson names are not stored as SO/PO references.
9. Custom Sales/Purchase voucher names are accepted because the TDL collection already determines voucher nature.
10. Empty collection-wrapper vouchers are ignored.
11. Party names containing words such as `Sales` are not dropped from outstanding reports.
12. Receivable/payable type is passed explicitly; Payables cannot silently become Receivables.
13. Outstandings are pushed as one current full snapshot, not grouped into fake historical months.
14. Snapshot metadata is sent on every batch; CRM finalizes/settles missing rows only on the final verified batch.
15. An empty outstanding snapshot is blocked by default to prevent accidental mass closure.
16. Daily cron now runs masters + configured lookback Sales/Purchase/DC + current outstanding snapshot.
17. Incremental daily sync bypasses historical checkpoints; historical backfill remains resumable.

## Production XML verification

See `PRODUCTION_XML_TEST_RESULTS.json`.

Expected verified counts:

- Ledgers: 765
- Stock Items: 437
- Cost Centres: 13
- Sales vouchers: 9
- Purchase vouchers: 3
- Bills Receivable: 279
- Bills Payable: 258
- GST rate in selected sales items: 18%
- Voucher BISMP/26-27/55 cost-centre taxable allocation: 22,964
- Voucher BISMP/26-27/58 cost-centre taxable allocation: 76,280
- Voucher BISMP/26-27/59 reference: blank (salesperson was correctly rejected)

## Required backend deployment

Deploy the accompanying backend patch and SQL migration before using this agent. The agent sends full-snapshot metadata that the old backend schema strips.

Deployment order:

1. Run backend SQL migration.
2. Replace backend Tally module files and deploy backend.
3. Replace the RDP agent folder/build.
4. Copy the real `.env` into the new agent folder.
5. Keep automatic sync disabled during the first controlled backfill.
6. Run company diagnostics.
7. Run masters once.
8. Run Sales, Purchase, and Outstanding historical endpoints one at a time.
9. Verify counts in CRM.
10. Enable automatic daily sync.

## Recommended `.env` during first controlled backfill

```env
PORT=5050
TALLY_URL=http://127.0.0.1:9000
CRM_BASE_URL=https://crm-api.flexloud.com/v1
CRM_TENANT_SLUG=atvi
TALLY_AGENT_TOKEN=REPLACE_WITH_ROTATED_TOKEN

TALLY_COMPANIES=9784a623-df5a-45ef-9d75-bb531569a831|Binary Infosolutions Pvt Ltd (Indore) - (from 1-Apr-23)

CRM_REQUEST_TIMEOUT_MS=600000
TALLY_REQUEST_TIMEOUT_MS=600000
TALLY_RETRY_ATTEMPTS=2
CRM_RETRY_ATTEMPTS=2
CRM_STRIP_RAW_TALLY_DATA=true

BATCH_SIZE_LEDGERS=10
BATCH_SIZE_STOCK_ITEMS=10
BATCH_SIZE_COST_CENTERS=10
BATCH_SIZE_SALES_ORDERS=1
BATCH_SIZE_PURCHASE_ORDERS=1
BATCH_SIZE_OUTSTANDINGS=5

HISTORICAL_SYNC_AUTO_DETECT_FROM_DATE=true
HISTORICAL_SYNC_MIN_YEAR=2022
HISTORICAL_SYNC_DETECT_CHUNK_MONTHS=12
HISTORICAL_SYNC_RANGE_MONTHS=1
HISTORICAL_TRANSACTION_RANGE_MONTHS=1
OUTSTANDING_REPORT_FILTER_TO_DATE=false
ALLOW_EMPTY_OUTSTANDING_SNAPSHOT=false
SYNC_CHECKPOINT_FILE=.tally-sync-checkpoints.json

DISABLE_AUTO_SYNC=true
DAILY_SYNC_ENABLED=false
DAILY_SYNC_RUN_ON_START=false
SYNC_CRON=*/30 * * * *
DAILY_SYNC_LOOKBACK_DAYS=3

AGENT_LOCK_FILE=C:\ProgramData\FlexLoud\tally-sync-agent.lock
```

After historical verification:

```env
DISABLE_AUTO_SYNC=false
```

Restart the single agent service/process after changing it.

## Start command

Use only:

```bat
scripts\start-daily-sync-agent.bat
```

Do not separately start `daily-sync.runner.js` or a second Node process.

## Diagnostics

```bat
curl.exe -H "Authorization: Bearer {{token}}" http://127.0.0.1:5050/diagnostics/companies
```

Do not start sync unless `safe_to_sync=true` and `resolved` contains only intended companies.

## Historical order

For each company:

1. Masters: `/sync/run`
2. Sales vouchers: `/sync/historical/so`
3. Purchase vouchers: `/sync/historical/po`
4. Current Outstanding snapshot: `/sync/historical/os`

Use short ranges first, verify, then run the full history.
