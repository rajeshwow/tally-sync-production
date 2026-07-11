import axios from "axios";

const TALLY_URL = process.env.TALLY_URL;
const TALLY_REQUEST_TIMEOUT_MS = Number(
  process.env.TALLY_REQUEST_TIMEOUT_MS || 300000,
);

if (!TALLY_URL) {
  throw new Error("[TALLY CLIENT] TALLY_URL is missing in .env");
}

export type TallyDateRange = {
  fromDate: string; // YYYYMMDD
  toDate: string; // YYYYMMDD
};

export async function postToTally(xml: string) {
  const response = await axios.post(TALLY_URL, xml, {
    headers: {
      "Content-Type": "text/xml",
    },
    timeout: TALLY_REQUEST_TIMEOUT_MS,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    responseType: "arraybuffer",
    transformResponse: [(data) => data],
  });

  const xmlText = sanitizeTallyXmlResponse(
    decodeTallyHttpResponse(response.data),
  );

  assertValidTallyResponse(xmlText);

  return xmlText;
}


function readTallyResponseTag(xml: string, tag: string) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(xml || "").match(
    new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i"),
  );

  return String(match?.[1] || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function assertValidTallyResponse(xml: string) {
  const text = String(xml || "").trim();

  if (!text) {
    throw new Error("[TALLY CLIENT] Tally returned an empty response");
  }

  const lineError = readTallyResponseTag(text, "LINEERROR");
  if (lineError) {
    throw new Error(`[TALLY CLIENT] Tally LINEERROR: ${lineError}`);
  }

  const errors = Number(readTallyResponseTag(text, "ERRORS") || 0);
  if (Number.isFinite(errors) && errors > 0) {
    throw new Error(`[TALLY CLIENT] Tally response contains ${errors} error(s)`);
  }

  const status = readTallyResponseTag(text, "STATUS");
  if (status === "0") {
    throw new Error("[TALLY CLIENT] Tally returned STATUS=0");
  }
}

function decodeUtf16Be(buffer: Buffer) {
  const evenLength = buffer.length - (buffer.length % 2);
  const swapped = Buffer.allocUnsafe(evenLength);

  for (let i = 0; i < evenLength; i += 2) {
    swapped[i] = buffer[i + 1];
    swapped[i + 1] = buffer[i];
  }

  return swapped.toString("utf16le");
}

function decodeTallyHttpResponse(data: any) {
  if (typeof data === "string") {
    return data;
  }

  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || []);

  if (!buffer.length) return "";

  // UTF-16 LE BOM: FF FE
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString("utf16le");
  }

  // UTF-16 BE BOM: FE FF
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return decodeUtf16Be(buffer.subarray(2));
  }

  /**
   * Some Tally/RDP responses come without charset header.
   * Detect UTF-16 by null byte pattern.
   */
  const sample = buffer.subarray(0, Math.min(buffer.length, 2000));
  let evenNulls = 0;
  let oddNulls = 0;

  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) {
      if (i % 2 === 0) evenNulls += 1;
      else oddNulls += 1;
    }
  }

  if (oddNulls > sample.length / 4) {
    return buffer.toString("utf16le");
  }

  if (evenNulls > sample.length / 4) {
    return decodeUtf16Be(buffer);
  }

  return buffer.toString("utf8");
}

function sanitizeTallyXmlResponse(value: any) {
  return (
    String(value ?? "")
      .replace(/^\uFEFF/, "")
      /**
       * Tally sometimes returns invalid XML control chars as numeric refs like &#4;
       * and sometimes as literal control chars. Both break browser/XML parsing.
       */
      .replace(
        /&#(?:x0*(?:[0-8bcef]|1[0-9a-f])|0*(?:[0-8]|1[0-9]|2[0-9]|3[01]));/gi,
        "",
      )
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
  );
}

function escapeXml(value: string) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildStaticVariables(companyName?: string | null, extra?: string) {
  return `
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        ${
          companyName
            ? `<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>`
            : ""
        }
        ${extra || ""}
      </STATICVARIABLES>
`;
}

function formatTallyDisplayDate(value: string) {
  const raw = String(value || "").replace(/[^0-9]/g, "");

  if (!/^\d{8}$/.test(raw)) return value;

  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  const year = raw.slice(0, 4);
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));

  return `${day}-${monthNames[month - 1]}-${year}`;
}

function buildDateRangeVariables(dateRange?: TallyDateRange) {
  if (!dateRange?.fromDate || !dateRange?.toDate) {
    return "";
  }

  const fromDateDisplay = escapeXml(formatTallyDisplayDate(dateRange.fromDate));
  const toDateDisplay = escapeXml(formatTallyDisplayDate(dateRange.toDate));

  return `
        <SVFromDate TYPE="Date">${fromDateDisplay}</SVFromDate>
        <SVToDate TYPE="Date">${toDateDisplay}</SVToDate>
        <SVCurrentDate TYPE="Date">${toDateDisplay}</SVCurrentDate>

        <SVFROMDATE TYPE="Date">${fromDateDisplay}</SVFROMDATE>
        <SVTODATE TYPE="Date">${toDateDisplay}</SVTODATE>
        <SVCURRENTDATE TYPE="Date">${toDateDisplay}</SVCURRENTDATE>
`;
}

function buildDateRangeFilterFormula(dateRange?: TallyDateRange) {
  if (!dateRange?.fromDate || !dateRange?.toDate) {
    return `
          <SYSTEM TYPE="Formulae" NAME="DateInSelectedRange">
            Yes
          </SYSTEM>
`;
  }

  return `
          <SYSTEM TYPE="Formulae" NAME="DateInSelectedRange">
            NOT $$IsEmpty:$Date
            AND $Date &gt;= ##SVFromDate
            AND $Date &lt;= ##SVToDate
          </SYSTEM>
`;
}

export async function fetchLedgersXml(companyName?: string) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Ledgers</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(companyName)}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Ledgers" ISMODIFY="No">
            <TYPE>Ledger</TYPE>
            <FETCH>Name,Guid,MasterId,AlterId,Parent,Email,LedgerPhone,LedgerMobile,Mobile,GSTRegistrationNumber,PartyGSTIN,GSTIN,Address,MailingAddress,LedStateName,StateName,CountryName,OpeningBalance,ClosingBalance,LedgerCategory,LedgerClass,Category,Class,PartyCategory,PartyType,LedgerType,Type,*</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

export async function fetchStockItemsXml(companyName?: string) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Stock Items</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(companyName)}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Stock Items" ISMODIFY="No">
            <TYPE>Stock Item</TYPE>
            <FETCH>Name,Guid,MasterId,AlterId,Parent,BaseUnits,OpeningBalance,OpeningRate,OpeningValue,ClosingBalance,ClosingRate,ClosingValue,GSTHSNCode,Description,PartNo,Manufacturer,Brand</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

export async function fetchAccountGroupsXml(companyName?: string) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Account Groups</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(companyName)}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Account Groups" ISMODIFY="No">
            <TYPE>Group</TYPE>
            <FETCH>Name,Guid,MasterId,AlterId,Parent</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

export async function fetchStockGroupsXml(companyName?: string) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Stock Groups</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(companyName)}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Stock Groups" ISMODIFY="No">
            <TYPE>Stock Group</TYPE>
            <FETCH>Name,Guid,MasterId,AlterId,Parent</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

export async function fetchOutstandingsXml(
  companyName?: string,
  dateRange?: TallyDateRange,
) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Outstanding Vouchers</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(companyName, buildDateRangeVariables(dateRange))}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Outstanding Vouchers" ISMODIFY="No">
            <TYPE>Voucher</TYPE>
            <BELONGSTO>Yes</BELONGSTO>
            <FETCH>
              Date,
              Guid,
              VoucherKey,
              MasterId,
              AlterId,
              VoucherNumber,
              VoucherTypeName,
              PartyLedgerName,
              PartyName,
              Reference,
              Narration,
              Amount,
              LedgerEntries,
              AllLedgerEntries,
              BillAllocations,
              CategoryAllocations,
              CostCentreAllocations
            </FETCH>
            <FILTER>OnlyAccountingVouchers</FILTER>
            <FILTER>DateInSelectedRange</FILTER>
          </COLLECTION>

          <SYSTEM TYPE="Formulae" NAME="OnlyAccountingVouchers">
            NOT $$IsOrder:$VoucherTypeName
          </SYSTEM>
          ${buildDateRangeFilterFormula(dateRange)}
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

export type OutstandingReportType = "receivable" | "payable";

export async function fetchOutstandingReportXml(
  companyName: string | undefined,
  reportType: OutstandingReportType,
  dateRange?: TallyDateRange,
) {
  const reportName =
    reportType === "receivable" ? "Bills Receivable" : "Bills Payable";

  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>${escapeXml(reportName)}</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(
        companyName,
        `
        ${buildDateRangeVariables(dateRange)}
        <EXPLODEFLAG>Yes</EXPLODEFLAG>
        `,
      )}
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

export async function fetchSalesOrdersXml(
  companyName?: string,
  dateRange?: TallyDateRange,
) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Sales Register</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(companyName, buildDateRangeVariables(dateRange))}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Sales Register" ISMODIFY="No">
            <TYPE>Voucher</TYPE>
            <BELONGSTO>Yes</BELONGSTO>
            <FETCH>
              Date,
              Guid,
              VoucherKey,
              MasterId,
              AlterId,
              VoucherNumber,
              VoucherTypeName,
              PartyLedgerName,
              PartyName,
              Reference,
              Narration,
              Amount,
              BasicBuyerName,
              BasicOrderRef,
              BasicDueDateOfPymt,
              CostCentreName,
              CostCenterName,
              CostCategoryName,
              LedgerEntries,
              AllLedgerEntries,
              BillAllocations,
              InventoryEntries,
              AllInventoryEntries,
              CategoryAllocations,
              CostCentreAllocations
            </FETCH>
            <FILTER>OnlySalesVouchers</FILTER>
            <FILTER>DateInSelectedRange</FILTER>
          </COLLECTION>

         <SYSTEM TYPE="Formulae" NAME="OnlySalesVouchers">
  $$IsSales:$VoucherTypeName AND NOT $$IsOrder:$VoucherTypeName
</SYSTEM>
          ${buildDateRangeFilterFormula(dateRange)}
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

export async function fetchDeliveryChallansXml(
  companyName?: string,
  dateRange?: TallyDateRange,
) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Delivery Notes Register</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(companyName, buildDateRangeVariables(dateRange))}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Delivery Notes Register" ISMODIFY="No">
            <TYPE>Voucher</TYPE>
            <BELONGSTO>Yes</BELONGSTO>
            <FETCH>
              Date,
              Guid,
              VoucherKey,
              MasterId,
              AlterId,
              VoucherNumber,
              VoucherTypeName,
              PartyLedgerName,
              PartyName,
              Reference,
              Narration,
              Amount,
              BasicBuyerName,
              BasicOrderRef,
              BasicDueDateOfPymt,
              CostCentreName,
              CostCenterName,
              CostCategoryName,
              LedgerEntries,
              AllLedgerEntries,
              BillAllocations,
              InventoryEntries,
              AllInventoryEntries,
              CategoryAllocations,
              CostCentreAllocations
            </FETCH>
            <FILTER>OnlyDeliveryNoteVouchers</FILTER>
            <FILTER>DateInSelectedRange</FILTER>
          </COLLECTION>

         <SYSTEM TYPE="Formulae" NAME="OnlyDeliveryNoteVouchers">
           $$IsDeliveryNote:$VoucherTypeName
         </SYSTEM>
          ${buildDateRangeFilterFormula(dateRange)}
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

export async function fetchHistoricalDeliveryChallansXml(
  companyName?: string,
  dateRange?: TallyDateRange,
) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Deep Delivery Notes Register</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(companyName, buildDateRangeVariables(dateRange))}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Deep Delivery Notes Register" ISMODIFY="No">
            <TYPE>Voucher</TYPE>
            <BELONGSTO>Yes</BELONGSTO>
            <FETCH>
              Date,
              Guid,
              VoucherKey,
              MasterId,
              AlterId,
              VoucherNumber,
              VoucherTypeName,
              PartyLedgerName,
              PartyName,
              Reference,
              Narration,
              Amount,
              BasicBuyerName,
              BasicOrderRef,
              BasicDueDateOfPymt,
              CostCentreName,
              CostCenterName,
              CostCategoryName,
              LedgerEntries,
              AllLedgerEntries,
              BillAllocations,
              InventoryEntries,
              AllInventoryEntries,
              CategoryAllocations,
              CostCentreAllocations
            </FETCH>
            <FILTER>OnlyDeepDeliveryNoteVouchers</FILTER>
            <FILTER>DateInSelectedRange</FILTER>
          </COLLECTION>

         <SYSTEM TYPE="Formulae" NAME="OnlyDeepDeliveryNoteVouchers">
           $$IsDeliveryNote:$VoucherTypeName
         </SYSTEM>
          ${buildDateRangeFilterFormula(dateRange)}
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

export async function fetchPurchaseOrdersXml(
  companyName?: string,
  dateRange?: TallyDateRange,
) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Purchase Register</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(companyName, buildDateRangeVariables(dateRange))}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Purchase Register" ISMODIFY="No">
            <TYPE>Voucher</TYPE>
            <BELONGSTO>Yes</BELONGSTO>
            <FETCH>
              Date,
              Guid,
              VoucherKey,
              MasterId,
              AlterId,
              VoucherNumber,
              VoucherTypeName,
              PartyLedgerName,
              PartyName,
              Reference,
              Narration,
              Amount,
              BasicSupplierName,
              BasicOrderRef,
              BasicDueDateOfPymt,
              CostCentreName,
              CostCenterName,
              CostCategoryName,
              LedgerEntries,
              AllLedgerEntries,
              BillAllocations,
              InventoryEntries,
              AllInventoryEntries,
              CategoryAllocations,
              CostCentreAllocations
            </FETCH>
            <FILTER>OnlyPurchaseVouchers</FILTER>
            <FILTER>DateInSelectedRange</FILTER>
          </COLLECTION>

         <SYSTEM TYPE="Formulae" NAME="OnlyPurchaseVouchers">
  $$IsPurchase:$VoucherTypeName AND NOT $$IsOrder:$VoucherTypeName
</SYSTEM>
          ${buildDateRangeFilterFormula(dateRange)}
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

/**
 * Deep historical transaction pull.
 * These functions are intentionally separate from existing historical sync.
 * Existing fetchSalesOrdersXml/fetchPurchaseOrdersXml remain unchanged.
 */
export async function fetchHistoricalSalesVouchersXml(
  companyName?: string,
  dateRange?: TallyDateRange,
) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Deep Sales Vouchers</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(companyName, buildDateRangeVariables(dateRange))}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Deep Sales Vouchers" ISMODIFY="No">
            <TYPE>Voucher</TYPE>
            <BELONGSTO>Yes</BELONGSTO>
            <FETCH>
              Date,
              Guid,
              VoucherKey,
              MasterId,
              AlterId,
              VoucherNumber,
              VoucherTypeName,
              PartyLedgerName,
              PartyName,
              Reference,
              Narration,
              Amount,
              BasicBuyerName,
              BasicOrderRef,
              BasicBuyerOrderNo,
              BasicDueDateOfPymt,
              LedgerEntries,
              AllLedgerEntries,
              InventoryEntries,
              AllInventoryEntries,
              CategoryAllocations,
              CostCentreAllocations,
               CostCentreName,
              CostCenterName,
              CostCategoryName,
              BillAllocations
            </FETCH>
            <FILTER>OnlyDeepSalesVouchers</FILTER>
            <FILTER>DateInSelectedRange</FILTER>
          </COLLECTION>

          <SYSTEM TYPE="Formulae" NAME="OnlyDeepSalesVouchers">
            $$IsSales:$VoucherTypeName AND NOT $$IsOrder:$VoucherTypeName
          </SYSTEM>
          ${buildDateRangeFilterFormula(dateRange)}
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

export async function fetchHistoricalPurchaseVouchersXml(
  companyName?: string,
  dateRange?: TallyDateRange,
) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Deep Purchase Vouchers</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(companyName, buildDateRangeVariables(dateRange))}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Deep Purchase Vouchers" ISMODIFY="No">
            <TYPE>Voucher</TYPE>
            <BELONGSTO>Yes</BELONGSTO>
            <FETCH>
              Date,
              Guid,
              VoucherKey,
              MasterId,
              AlterId,
              VoucherNumber,
              VoucherTypeName,
              PartyLedgerName,
              PartyName,
              Reference,
              Narration,
              Amount,
              BasicSupplierName,
              BasicOrderRef,
              BasicDueDateOfPymt,
              LedgerEntries,
              AllLedgerEntries,
              InventoryEntries,
              AllInventoryEntries,
              CategoryAllocations,
              CostCentreAllocations,
               CostCentreName,
              CostCenterName,
              CostCategoryName,
              BillAllocations
            </FETCH>
             <FILTER>OnlyDeepPurchaseVouchers</FILTER>
            <FILTER>DateInSelectedRange</FILTER>
          </COLLECTION>

          <SYSTEM TYPE="Formulae" NAME="OnlyDeepPurchaseVouchers">
            $$IsPurchase:$VoucherTypeName AND NOT $$IsOrder:$VoucherTypeName
          </SYSTEM>
          ${buildDateRangeFilterFormula(dateRange)}
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

export async function fetchHistoricalOutstandingVouchersXml(
  companyName?: string,
  dateRange?: TallyDateRange,
) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Deep Outstanding Vouchers</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(companyName, buildDateRangeVariables(dateRange))}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Deep Outstanding Vouchers" ISMODIFY="No">
            <TYPE>Voucher</TYPE>
            <BELONGSTO>Yes</BELONGSTO>
            <FETCH>
              Date,
              Guid,
              VoucherKey,
              MasterId,
              AlterId,
              VoucherNumber,
              VoucherTypeName,
              PartyLedgerName,
              PartyName,
              Reference,
              Narration,
              Amount,
              LedgerEntries,
              AllLedgerEntries,
              BillAllocations,
              CategoryAllocations,
              CostCentreAllocations
            </FETCH>
            <FILTER>OnlyOutstandingAffectingVouchers</FILTER>
            <FILTER>DateInSelectedRange</FILTER>
          </COLLECTION>

          <SYSTEM TYPE="Formulae" NAME="OnlyOutstandingAffectingVouchers">
            $$IsSales:$VoucherTypeName
            OR $$IsPurchase:$VoucherTypeName
            OR $VoucherTypeName = "Receipt"
            OR $VoucherTypeName = "Payment"
          </SYSTEM>
          ${buildDateRangeFilterFormula(dateRange)}
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

export async function fetchCostCentersXml(companyName?: string) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Cost Centers</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(companyName)}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Cost Centers" ISMODIFY="No">
            <TYPE>Cost Centre</TYPE>
            <FETCH>Name,GUID,Parent,Category,Description</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

export async function fetchTallyCompaniesXml() {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Loaded Companies</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Loaded Companies" ISMODIFY="No">
            <TYPE>Company</TYPE>
            <FETCH>Name,Guid,StartingFrom,BooksFrom,CountryOfResidence,StateName</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`.trim();

  return postToTally(xml);
}

/**
 * Returns only the company currently active in the Tally UI.
 * The generic Company collection can contain every company available in the
 * Tally data directory, so masters sync must not use that collection directly.
 */
export async function fetchCurrentTallyCompanyXml() {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Current Company</ID>
  </HEADER>

  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>

      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Current Company" ISMODIFY="No">
            <TYPE>Company</TYPE>
            <FETCH>
              Name,
              Guid,
              StartingFrom,
              BooksFrom,
              CountryOfResidence,
              StateName
            </FETCH>

            <FILTER>CRM Is Current Company</FILTER>
          </COLLECTION>

          <SYSTEM TYPE="Formulae" NAME="CRM Is Current Company">
            $Name = ##SVCurrentCompany
          </SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`.trim();

  return postToTally(xml);
}
