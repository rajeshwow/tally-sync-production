function readTag(block: string, tag: string) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const match = block.match(
    new RegExp(`<${escapedTag}(\\s[^>]*)?>([\\s\\S]*?)</${escapedTag}>`, "i"),
  );

  return match?.[2]?.trim() || "";
}

function readAttr(block: string, tag: string, attr: string) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedAttr = attr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const match = block.match(
    new RegExp(`<${escapedTag}\\b[^>]*\\b${escapedAttr}="([^"]*)"`, "i"),
  );

  return match?.[1]?.trim() || "";
}

function stripXml(value: string) {
  return String(value || "")
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x?[0-9a-fA-F]+;/g, "") // removes all numeric XML entities like &#4;, &#x04;
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // removes control chars
    .replace(/<[^>]+>/g, "")
    .replace(/Not Applicable/gi, "")
    .replace(/Not Found/gi, "")
    .replace(/As per Company\/Stock Group/gi, "")
    .replace(/Not Available/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeTallyXmlText(value: any) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .replace(
      /&#(?:x0*(?:[0-8bcef]|1[0-9a-f])|0*(?:[0-8]|1[0-9]|2[0-9]|3[01]));/gi,
      "",
    )
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");
}

function readName(block: string, tag: string) {
  return stripXml(readAttr(block, tag, "NAME") || readTag(block, "NAME"));
}

function toNumber(value?: string | number | null) {
  if (value === undefined || value === null || value === "") return 0;

  const cleaned = String(value)
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "");

  const num = Number(cleaned);

  return Number.isFinite(num) ? num : 0;
}

function parseCostCenterAllocations(block: string) {
  const allocations: Array<{
    cost_center_name: string;
    cost_category?: string | null;
    amount: number;
  }> = [];

  const categoryBlocks =
    block.match(
      /<CATEGORYALLOCATIONS\.LIST[\s\S]*?<\/CATEGORYALLOCATIONS\.LIST>/gi,
    ) || [];

  for (const categoryBlock of categoryBlocks) {
    const category = stripXml(readTag(categoryBlock, "CATEGORY")) || null;

    const ccBlocks =
      categoryBlock.match(
        /<COSTCENTREALLOCATIONS\.LIST[\s\S]*?<\/COSTCENTREALLOCATIONS\.LIST>/gi,
      ) || [];

    for (const ccBlock of ccBlocks) {
      const name = stripXml(readTag(ccBlock, "NAME"));

      if (!name) continue;

      allocations.push({
        cost_center_name: name,
        cost_category: category,
        amount: Math.abs(toNumber(readTag(ccBlock, "AMOUNT"))),
      });
    }
  }

  return allocations;
}

function getPrimaryCostCenter(block: string) {
  const allocations = parseCostCenterAllocations(block);

  if (!allocations.length) {
    return {
      cost_center_name: null,
      cost_category: null,
      cost_center_amount: 0,
      cost_center_allocations: [],
    };
  }

  const primary = allocations.find((item) => item.amount > 0) || allocations[0];

  return {
    cost_center_name: primary.cost_center_name,
    cost_category: primary.cost_category || null,
    cost_center_amount: primary.amount || 0,
    cost_center_allocations: allocations,
  };
}

function toPositiveNumber(value: any) {
  return Math.abs(toNumber(value));
}

function parseQty(value: any) {
  const cleaned = stripXml(String(value || "")).replace(/,/g, "");
  const match = cleaned.match(/-?\d+(\.\d+)?/);
  return match ? Math.abs(Number(match[0])) : 0;
}

function readFirstAvailableTag(block: string, tags: string[]) {
  for (const tag of tags) {
    const value = stripXml(readTag(block, tag));
    if (value) return value;
  }

  return "";
}

function extractCrmSalesOrderRef(value?: string | null) {
  const text = stripXml(String(value || "")).trim();

  if (!text) return "";

  const directSoMatch = text.match(/\bSO-\d+\b/i);
  if (directSoMatch?.[0]) {
    return directSoMatch[0].toUpperCase();
  }

  return text
    .replace(/^crm\s*so\s*no\s*[:#-]?\s*/i, "")
    .replace(/^sales\s*order\s*[:#-]?\s*/i, "")
    .trim();
}

function isLikelyOrderReference(value?: string | null) {
  const text = stripXml(String(value || "")).trim();
  if (!text) return false;
  if (/\b(?:SO|PO)[-\/ ]?\d+\b/i.test(text)) return true;
  if (
    /^(?:CRM\s*)?(?:SALES|PURCHASE)\s*ORDER\s*[:#-]?\s*[A-Z0-9\/-]*\d+[A-Z0-9\/-]*$/i.test(
      text,
    )
  )
    return true;
  return !/\s/.test(text) && /\d/.test(text) && /[-\/]/.test(text);
}

function readVoucherReferenceNumber(block: string) {
  const directReference = readFirstAvailableTag(block, [
    "REFERENCE",
    "BASICBUYERORDERNO",
    "ORDERREFERENCE",
    "ORDERREF",
  ]);
  if (directReference) return extractCrmSalesOrderRef(directReference);

  const basicOrderRef = stripXml(readTag(block, "BASICORDERREF"));
  if (isLikelyOrderReference(basicOrderRef))
    return extractCrmSalesOrderRef(basicOrderRef);

  const narrationRef = extractCrmSalesOrderRef(
    stripXml(readTag(block, "NARRATION")),
  );
  return isLikelyOrderReference(narrationRef) ? narrationRef : "";
}

function readFirstAvailableNumber(block: string, tags: string[]) {
  for (const tag of tags) {
    const value = stripXml(readTag(block, tag));
    const num = toPositiveNumber(value);
    if (num > 0) return num;
  }

  return 0;
}

function readHsnCode(block: string) {
  const directHsn = readFirstAvailableTag(block, [
    "GSTHSNCODE",
    "HSNCODE",
    "HSN",
    "HSNCODEVALUE",
    "HSNSACCODE",
  ]);

  if (directHsn) return directHsn;

  const hsnDetailsBlocks =
    block.match(/<HSNDETAILS\.LIST\b[\s\S]*?<\/HSNDETAILS\.LIST>/gi) || [];

  for (const hsnBlock of hsnDetailsBlocks) {
    const hsn = readFirstAvailableTag(hsnBlock, [
      "HSNCODE",
      "HSN",
      "GSTHSNCODE",
      "HSNSACCODE",
    ]);

    if (hsn) return hsn;
  }

  return "NA";
}

function readGstRate(block: string) {
  const dutyRateBlocks =
    block.match(/<RATEDETAILS\.LIST\b[\s\S]*?<\/RATEDETAILS\.LIST>/gi) || [];

  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  let cess = 0;
  let stateCess = 0;
  const unclassifiedRates: number[] = [];

  for (const rateBlock of dutyRateBlocks) {
    const head = normalizeText(
      readFirstAvailableTag(rateBlock, [
        "GSTRATEDUTYHEAD",
        "DUTYHEAD",
        "TAXHEAD",
      ]),
    );
    const rate = readFirstAvailableNumber(rateBlock, [
      "GSTRATE",
      "RATE",
      "TAXRATE",
      "DUTYRATE",
    ]);
    if (rate <= 0) continue;

    if (head.includes("cgst")) cgst = Math.max(cgst, rate);
    else if (head.includes("sgst") || head.includes("utgst"))
      sgst = Math.max(sgst, rate);
    else if (head.includes("igst")) igst = Math.max(igst, rate);
    else if (head.includes("state cess")) stateCess = Math.max(stateCess, rate);
    else if (head.includes("cess")) cess = Math.max(cess, rate);
    else unclassifiedRates.push(rate);
  }

  const standardGstRate = Math.max(igst, cgst + sgst);
  if (standardGstRate > 0) return standardGstRate + cess + stateCess;

  const rates = [...block.matchAll(/<GSTRATE>([\s\S]*?)<\/GSTRATE>/gi)]
    .map((match) => toPositiveNumber(match[1]))
    .filter((rate) => rate > 0);
  const fallbackRates = rates.length ? rates : unclassifiedRates;
  if (!fallbackRates.length) return 0;
  if (fallbackRates.length === 1) return fallbackRates[0];

  const sorted = [...fallbackRates].sort((a, b) => b - a);
  const maxRate = sorted[0];
  const remainingTotal = sorted.slice(1).reduce((sum, rate) => sum + rate, 0);
  if (Math.abs(maxRate - remainingTotal) < 0.0001) return maxRate;
  if (sorted.length === 2 && Math.abs(sorted[0] - sorted[1]) < 0.0001) {
    return sorted[0] + sorted[1];
  }
  return maxRate;
}

function readListRate(block: string, listTag: string) {
  const listBlocks =
    block.match(new RegExp(`<${listTag}\\b[\\s\\S]*?<\\/${listTag}>`, "gi")) ||
    [];

  for (const listBlock of listBlocks) {
    const rate = readFirstAvailableNumber(listBlock, [
      "RATE",
      "PRICE",
      "STANDARDPRICE",
      "STANDARDRATE",
      "FULLPRICE",
      "MRPRATE",
    ]);

    if (rate > 0) return rate;
  }

  return 0;
}

function readStockPrice(
  block: string,
  input: {
    openingQty: number;
    openingRateNumber: number;
    openingValueNumber: number;
    closingQty: number;
    closingValueNumber: number;
  },
) {
  const standardPrice =
    readFirstAvailableNumber(block, [
      "STANDARDPRICE",
      "STANDARDRATE",
      "SELLINGPRICE",
      "SALEPRICE",
      "RATE",
      "MRP",
      "MRPRATE",
    ]) ||
    readListRate(block, "STANDARDPRICELIST.LIST") ||
    readListRate(block, "FULLPRICELIST.LIST") ||
    readListRate(block, "PRICELEVELLIST.LIST");

  if (standardPrice > 0) return standardPrice;
  if (input.openingRateNumber > 0) return input.openingRateNumber;

  if (input.openingQty > 0 && input.openingValueNumber > 0) {
    return input.openingValueNumber / input.openingQty;
  }

  if (input.closingQty > 0 && input.closingValueNumber > 0) {
    return input.closingValueNumber / input.closingQty;
  }

  if (input.openingValueNumber > 0) return input.openingValueNumber;
  if (input.closingValueNumber > 0) return input.closingValueNumber;

  return 0;
}

function cleanLedgerCategoryValue(value: any) {
  const text = stripXml(String(value || ""));

  if (!text) return "";

  const lowered = text.toLowerCase();

  if (
    lowered === "not applicable" ||
    lowered === "not found" ||
    lowered === "not available" ||
    lowered === "as per company/stock group"
  ) {
    return "";
  }

  return text;
}

function readLedgerTypeCategory(block: string) {
  const directTags = [
    "LEDGERCATEGORY",
    "LEDGERCATEGORYNAME",
    "LEDGERCLASS",
    "LEDGERCLASSNAME",
    "PARTYCATEGORY",
    "PARTYLEDGERCATEGORY",
    "CUSTOMERCATEGORY",
    "VENDORCATEGORY",
    "DEALERCATEGORY",
  ];

  for (const tag of directTags) {
    const value = cleanLedgerCategoryValue(readTag(block, tag));
    if (value && !/^(regular|unregistered|registered)$/i.test(value))
      return value;
  }

  const udfMatches = [
    ...block.matchAll(
      /<(UDF:[A-Z0-9_.:-]*(?:CATEGORY|CLASS)[A-Z0-9_.:-]*)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    ),
  ];

  for (const match of udfMatches) {
    const tag = match[1] || "";
    const value = cleanLedgerCategoryValue(match[2]);
    if (!value) continue;
    if (
      /GST|VAT|TAX|DUTY|DEALER|REGISTRATION|VOUCHER|STOCK|PRICE|RATE|BILL/i.test(
        tag,
      )
    )
      continue;
    if (/^(regular|unregistered|registered)$/i.test(value)) continue;
    return value;
  }

  return "";
}

export type ParsedAccountGroup = {
  guid: string | null;
  masterId: string | null;
  alterId: string | null;
  name: string;
  parent: string | null;
};

export function parseAccountGroups(xml: string): ParsedAccountGroup[] {
  const blocks = String(xml || "").match(/<GROUP\b[\s\S]*?<\/GROUP>/gi) || [];
  return blocks
    .map((block) => ({
      guid: stripXml(readTag(block, "GUID")) || null,
      masterId: stripXml(readTag(block, "MASTERID")) || null,
      alterId: stripXml(readTag(block, "ALTERID")) || null,
      name: readName(block, "GROUP"),
      parent: stripXml(readTag(block, "PARENT")) || null,
    }))
    .filter((group) => group.name);
}

export function enrichLedgersWithGroupHierarchy<T extends Record<string, any>>(
  ledgers: T[],
  groups: ParsedAccountGroup[],
): T[] {
  const groupByName = new Map(
    groups.map((group) => [normalizeText(group.name), group]),
  );

  return ledgers.map((ledger) => {
    const path: string[] = [];
    const visited = new Set<string>();
    let current = stripXml(String(ledger.parent || ""));

    while (current) {
      const key = normalizeText(current);
      if (!key || visited.has(key)) break;
      visited.add(key);
      path.push(current);
      current = stripXml(String(groupByName.get(key)?.parent || ""));
    }

    const normalizedPath = path.map((name) => normalizeText(name));
    const partyType = normalizedPath.includes("sundry debtors")
      ? "customer"
      : normalizedPath.includes("sundry creditors")
        ? "vendor"
        : null;
    const partyRootGroup =
      partyType === "customer"
        ? "Sundry Debtors"
        : partyType === "vendor"
          ? "Sundry Creditors"
          : null;

    return {
      ...ledger,
      ledgerGroupPath: path,
      ledger_group_path: path,
      rootGroup: path[path.length - 1] || ledger.parent || null,
      root_group: path[path.length - 1] || ledger.parent || null,
      partyRootGroup,
      party_root_group: partyRootGroup,
      partyType,
      party_type: partyType,
    };
  });
}

export function parseLedgers(xml: string) {
  const blocks = xml.match(/<LEDGER\b[\s\S]*?<\/LEDGER>/gi) || [];

  return blocks
    .map((block) => {
      const parent = stripXml(readTag(block, "PARENT"));
      const ledgerTypeCategory = readLedgerTypeCategory(block);

      return {
        guid: stripXml(readTag(block, "GUID")),
        masterId: stripXml(readTag(block, "MASTERID")),
        alterId: stripXml(readTag(block, "ALTERID")),
        name: readName(block, "LEDGER"),

        parent,

        // Tally accounting group
        group: parent,
        ledgerGroup: parent,
        ledger_group: parent,

        // Screenshot wala Type / Category / Class
        type: ledgerTypeCategory || null,
        category: ledgerTypeCategory || null,
        ledgerType: ledgerTypeCategory || null,
        ledger_type: ledgerTypeCategory || null,
        ledgerCategory: ledgerTypeCategory || null,
        ledger_category: ledgerTypeCategory || null,

        email: stripXml(readTag(block, "EMAIL")),

        phone:
          stripXml(readTag(block, "LEDGERPHONE")) ||
          stripXml(readTag(block, "LEDGERMOBILE")) ||
          stripXml(readTag(block, "MOBILE")),

        gstin:
          stripXml(readTag(block, "GSTREGISTRATIONNUMBER")) ||
          stripXml(readTag(block, "PARTYGSTIN")) ||
          stripXml(readTag(block, "GSTIN")),

        address:
          stripXml(readTag(block, "ADDRESS")) ||
          stripXml(readTag(block, "MAILINGADDRESS")),

        state:
          stripXml(readTag(block, "LEDSTATENAME")) ||
          stripXml(readTag(block, "STATENAME")) ||
          stripXml(readTag(block, "STATE")),

        country:
          stripXml(readTag(block, "COUNTRYNAME")) ||
          stripXml(readTag(block, "COUNTRY")) ||
          "India",

        openingBalance: stripXml(readTag(block, "OPENINGBALANCE")),
        closingBalance: stripXml(readTag(block, "CLOSINGBALANCE")),
      };
    })
    .filter((x) => x.name);
}

export function parseCostCenters(xml: string) {
  const records: any[] = [];

  const blocks =
    String(xml || "").match(/<COSTCENTRE\b[\s\S]*?<\/COSTCENTRE>/gi) || [];

  for (const block of blocks) {
    const nameFromAttr = stripXml(readAttr(block, "COSTCENTRE", "NAME"));
    const nameFromTag = stripXml(readTag(block, "NAME"));

    const name = nameFromAttr || nameFromTag;
    const costCenter = getPrimaryCostCenter(block);

    if (!name) continue;

    records.push({
      guid: stripXml(readTag(block, "GUID")) || null,
      masterId: stripXml(readTag(block, "MASTERID")) || null,
      alterId: stripXml(readTag(block, "ALTERID")) || null,

      name,

      cost_center_name: stripXml(costCenter.cost_center_name || ""),
      cost_category: stripXml(costCenter.cost_category || ""),
      cost_center_amount: costCenter.cost_center_amount,
      cost_center_allocations: costCenter.cost_center_allocations,

      parent: stripXml(readTag(block, "PARENT")) || null,
      category: stripXml(readTag(block, "CATEGORY")) || null,
      description: stripXml(readTag(block, "DESCRIPTION")) || null,
    });
  }

  return records;
}

export type ParsedStockGroup = {
  guid: string | null;
  masterId: string | null;
  alterId: string | null;
  name: string;
  parent: string | null;
};

function normalizeStockGroupKey(value?: string | null) {
  return stripXml(String(value || ""))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isPrimaryStockGroup(value?: string | null) {
  const key = normalizeStockGroupKey(value);

  return (
    !key || key === "primary" || key === "* primary" || key === "not applicable"
  );
}

function cleanProductGroupName(value?: string | null) {
  const text = stripXml(String(value || ""))
    .replace(/\s+/g, " ")
    .trim();

  if (!text || isPrimaryStockGroup(text)) return null;

  return text;
}

function sameStockGroupName(a?: string | null, b?: string | null) {
  const left = normalizeStockGroupKey(a);
  const right = normalizeStockGroupKey(b);

  return Boolean(left && right && left === right);
}

function cleanStockGroupPath(value?: string | null) {
  const parts = String(value || "")
    .split(">")
    .map((part) => cleanProductGroupName(part))
    .filter(Boolean);

  return parts.length ? parts.join(" > ") : null;
}

export function parseStockGroups(xml: string): ParsedStockGroup[] {
  const text = String(xml || "");

  const closingBlocks =
    text.match(/<STOCKGROUP\b[\s\S]*?<\/STOCKGROUP>/gi) || [];

  const selfClosingBlocks = text.match(/<STOCKGROUP\b[^>]*\/>/gi) || [];

  const blocks = [...closingBlocks, ...selfClosingBlocks];

  const groups = blocks
    .map((block) => {
      const name = readName(block, "STOCKGROUP");

      return {
        guid: stripXml(readTag(block, "GUID")) || null,
        masterId: stripXml(readTag(block, "MASTERID")) || null,
        alterId: stripXml(readTag(block, "ALTERID")) || null,
        name,
        parent: stripXml(readTag(block, "PARENT")) || null,
      };
    })
    .filter((group) => Boolean(group.name));

  const uniqueByName = new Map<string, ParsedStockGroup>();

  for (const group of groups) {
    const key = normalizeStockGroupKey(group.name);

    if (key && !uniqueByName.has(key)) {
      uniqueByName.set(key, group);
    }
  }

  return Array.from(uniqueByName.values());
}

function resolveStockGroupHierarchy(
  stockItemParent: string,
  stockGroups: ParsedStockGroup[] = [],
) {
  const immediateGroup = stripXml(stockItemParent) || "Uncategorized";

  if (!immediateGroup || immediateGroup === "Uncategorized") {
    return {
      rootStockGroupName: "Uncategorized",
      stockGroupName: "Uncategorized",
      stockGroupPath: "Uncategorized",
    };
  }

  const groupByName = new Map<string, ParsedStockGroup>();

  for (const group of stockGroups) {
    const key = normalizeStockGroupKey(group.name);

    if (key) {
      groupByName.set(key, group);
    }
  }

  const chain: string[] = [];
  const visited = new Set<string>();
  let currentName: string | null = immediateGroup;

  while (currentName && !isPrimaryStockGroup(currentName)) {
    const currentKey = normalizeStockGroupKey(currentName);

    if (!currentKey || visited.has(currentKey)) break;

    visited.add(currentKey);
    chain.push(currentName);

    const currentGroup = groupByName.get(currentKey);
    const parentName = stripXml(currentGroup?.parent || "");

    if (!parentName || isPrimaryStockGroup(parentName)) break;

    currentName = parentName;
  }

  const rootStockGroupName = chain.length
    ? chain[chain.length - 1]
    : immediateGroup;

  return {
    rootStockGroupName,
    stockGroupName: immediateGroup,
    stockGroupPath: chain.length
      ? [...chain].reverse().join(" > ")
      : immediateGroup,
  };
}

export function parseStockItems(
  xml: string,
  stockGroups: ParsedStockGroup[] = [],
) {
  const text = String(xml || "");

  const closingBlocks = text.match(/<STOCKITEM\b[\s\S]*?<\/STOCKITEM>/gi) || [];

  const selfClosingBlocks = text.match(/<STOCKITEM\b[^>]*\/>/gi) || [];

  const blocks = [...closingBlocks, ...selfClosingBlocks];

  return blocks
    .map((block) => {
      const openingBalanceRaw = stripXml(readTag(block, "OPENINGBALANCE"));
      const closingBalanceRaw = stripXml(readTag(block, "CLOSINGBALANCE"));

      const openingRateRaw = stripXml(readTag(block, "OPENINGRATE"));
      const openingValueRaw = stripXml(readTag(block, "OPENINGVALUE"));

      const closingRateRaw = stripXml(readTag(block, "CLOSINGRATE"));
      const closingValueRaw = stripXml(readTag(block, "CLOSINGVALUE"));

      const baseQtyRaw = stripXml(readTag(block, "BASEQTY"));
      const actualQtyRaw = stripXml(readTag(block, "ACTUALQTY"));
      const billedQtyRaw = stripXml(readTag(block, "BILLEDQTY"));

      const openingQty = parseQty(openingBalanceRaw);
      const closingQty = parseQty(closingBalanceRaw);
      const baseQty = parseQty(baseQtyRaw);
      const actualQty = parseQty(actualQtyRaw);
      const billedQty = parseQty(billedQtyRaw);

      const openingRateNumber = toPositiveNumber(openingRateRaw);
      const openingValueNumber = toPositiveNumber(openingValueRaw);

      const closingRateNumber = toPositiveNumber(closingRateRaw);
      const closingValueNumber = toPositiveNumber(closingValueRaw);

      const baseUnit = stripXml(
        readTag(block, "BASEUNITS") ||
          readTag(block, "BASEUNIT") ||
          readTag(block, "UNIT") ||
          readTag(block, "UOM"),
      );

      const partNumber =
        stripXml(readTag(block, "PARTNO")) ||
        stripXml(readTag(block, "PARTNUMBER")) ||
        stripXml(readTag(block, "ITEMCODE")) ||
        stripXml(readTag(block, "STOCKITEMCODE"));

      const description =
        stripXml(readTag(block, "DESCRIPTION")) ||
        stripXml(readTag(block, "NARRATION")) ||
        "";

      const manufacturer =
        stripXml(readTag(block, "MANUFACTURER")) ||
        stripXml(readTag(block, "BRAND")) ||
        "";

      const price = readStockPrice(block, {
        openingQty,
        openingRateNumber,
        openingValueNumber,
        closingQty,
        closingValueNumber,
      });

      const stockOnHand = closingQty || openingQty || baseQty || actualQty || 0;
      const availableForSale = stockOnHand;

      const parent = stripXml(readTag(block, "PARENT")) || "Uncategorized";
      const stockGroupHierarchy = resolveStockGroupHierarchy(
        parent,
        stockGroups,
      );

      const rootStockGroupName = cleanProductGroupName(
        stockGroupHierarchy.rootStockGroupName,
      );

      const stockGroupName = cleanProductGroupName(
        stockGroupHierarchy.stockGroupName,
      );

      const stockGroupPath = cleanStockGroupPath(
        stockGroupHierarchy.stockGroupPath,
      );

      const stockCategoryName = cleanProductGroupName(
        readTag(block, "CATEGORY") ||
          readTag(block, "STOCKCATEGORY") ||
          readTag(block, "STOCKCATEGORYNAME"),
      );

      // CRM reports must follow Tally's Stock Category:
      // ATVI STAND, ATVI CAMERA, ATVI MIC, ATVI IFP, ATVI OPS, etc.
      const crmCategory =
        stockCategoryName || rootStockGroupName || "Uncategorized";

      // Preserve the immediate Stock Group as CRM sub-category.
      const crmSubCategory =
        stockGroupName && !sameStockGroupName(stockGroupName, crmCategory)
          ? stockGroupName
          : rootStockGroupName &&
              !sameStockGroupName(rootStockGroupName, crmCategory)
            ? rootStockGroupName
            : null;

      return {
        guid: stripXml(readTag(block, "GUID")),
        masterId: stripXml(readTag(block, "MASTERID")),
        alterId: stripXml(readTag(block, "ALTERID")),

        name: readName(block, "STOCKITEM"),
        parent,
        category: crmCategory,
        subCategory: crmSubCategory,
        sub_category: crmSubCategory,

        stockGroupName,
        rootStockGroupName,
        stockGroupPath,

        stockCategoryName,
        stockCategory: stockCategoryName,
        tallyStockCategory: stockCategoryName,
        tally_stock_category: stockCategoryName,

        baseUnit,
        unit: baseUnit,

        partNumber,
        description,
        manufacturer,

        openingBalance: openingBalanceRaw,
        openingRate: openingRateRaw,
        openingValue: openingValueRaw,

        closingBalance: closingBalanceRaw,
        closingRate: closingRateRaw,
        closingValue: closingValueRaw,

        baseQty: baseQtyRaw,
        actualQty: actualQtyRaw,
        billedQty: billedQtyRaw,

        openingQty,
        closingQty,
        baseQtyNumber: baseQty,
        actualQtyNumber: actualQty,
        billedQtyNumber: billedQty,

        openingRateNumber,
        openingValueNumber,
        closingRateNumber,
        closingValueNumber,

        hsnCode: readHsnCode(block),
        gstRate: readGstRate(block),

        price,
        sellingPrice: price,
        costPrice: price,
        msp: price,

        stockOnHand,
        availableForSale,
      };
    })
    .filter((x) => x.name);
}

function toNumberLike(value?: string | number | null) {
  if (value === undefined || value === null || value === "") return 0;

  const cleaned = String(value)
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "");

  const num = Number(cleaned);

  return Number.isFinite(num) ? Math.abs(num) : 0;
}

function normalizeDate(value?: string | null) {
  if (!value) return null;

  const text = String(value).trim();

  const monthMap: Record<string, string> = {
    jan: "01",
    january: "01",
    feb: "02",
    february: "02",
    mar: "03",
    march: "03",
    apr: "04",
    april: "04",
    may: "05",
    jun: "06",
    june: "06",
    jul: "07",
    july: "07",
    aug: "08",
    august: "08",
    sep: "09",
    sept: "09",
    september: "09",
    oct: "10",
    october: "10",
    nov: "11",
    november: "11",
    dec: "12",
    december: "12",
  };

  const textDate = text.match(
    /^(\d{1,2})[-/\s]+([a-zA-Z]{3,9})[-/\s]+(\d{2,4})$/,
  );

  if (textDate) {
    const day = textDate[1].padStart(2, "0");
    const month = monthMap[textDate[2].toLowerCase()];
    let year = Number(textDate[3]);

    if (!month) return null;

    if (year < 100) {
      year = year >= 70 ? 1900 + year : 2000 + year;
    }

    return `${year}-${month}-${day}`;
  }

  // Tally sometimes gives YYYYMMDD
  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  return text;
}

function tallyJulianToDate(value?: string | null) {
  if (!value) return null;

  const jd = Number(String(value).trim());
  if (!Number.isFinite(jd)) return null;

  // Tally JD base: 1900-01-01 => JD 1
  const date = new Date(Date.UTC(1899, 11, 31));
  date.setUTCDate(date.getUTCDate() + jd);

  return date.toISOString().slice(0, 10);
}

function readTallyDate(block: string, tag: string) {
  const textDate = stripXml(readTag(block, tag));
  const normalizedTextDate = normalizeDate(textDate);

  if (normalizedTextDate) return normalizedTextDate;

  const jd = readAttr(block, tag, "JD");
  return tallyJulianToDate(jd);
}

function getDrCr(value?: string | number | null) {
  const text = String(value || "").trim();

  if (text.startsWith("-")) return "Cr";
  if (text) return "Dr";

  return null;
}

function extractBlocks(xml: string, tagName: string) {
  const blocks: string[] = [];
  const regex = new RegExp(
    `<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`,
    "gi",
  );

  let match;

  while ((match = regex.exec(xml)) !== null) {
    blocks.push(match[0]);
  }

  return blocks;
}

function normalizeText(value?: string | null) {
  return stripXml(String(value || ""))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function toSignedNumberLike(value?: string | number | null) {
  if (value === undefined || value === null || value === "") return 0;

  const cleaned = String(value)
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "");

  const num = Number(cleaned);

  return Number.isFinite(num) ? num : 0;
}

function toAbsNumberLike(value?: string | number | null) {
  return Math.abs(toSignedNumberLike(value));
}

function getVoucherNature(voucherType?: string | null) {
  const type = normalizeText(voucherType);

  if (type === "sales") {
    return {
      billType: "receivable",
      effect: "base",
    };
  }

  if (type === "receipt") {
    return {
      billType: "receivable",
      effect: "adjustment",
    };
  }

  if (type === "purchase") {
    return {
      billType: "payable",
      effect: "base",
    };
  }

  if (type === "payment") {
    return {
      billType: "payable",
      effect: "adjustment",
    };
  }

  return null;
}

function isSameName(a?: string | null, b?: string | null) {
  const left = normalizeText(a);
  const right = normalizeText(b);

  return Boolean(left && right && left === right);
}

function buildOutstandingKey(input: {
  billType: string;
  ledgerName: string;
  billRef: string;
}) {
  return [
    normalizeText(input.billType),
    normalizeText(input.ledgerName),
    normalizeText(input.billRef),
  ].join("::");
}

function normalizeLedgerName(value?: string | null) {
  return stripXml(String(value || ""))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function decodeXml(value: string) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

export function parseTallyLoadedCompany(xml: string) {
  const companyBlocks =
    String(xml || "").match(/<COMPANY[\s\S]*?<\/COMPANY>/gi) || [];

  const companies = companyBlocks
    .map((block) => {
      const nameFromAttr = block.match(/NAME="([^"]+)"/i)?.[1] || "";
      const nameFromTag = readTag(block, "NAME");

      return {
        name: decodeXml(nameFromAttr || nameFromTag),
        guid: decodeXml(readTag(block, "GUID")),
      };
    })
    .filter((item) => item.name);

  const preferredCompanyName =
    process.env.TALLY_COMPANY_NAME?.trim().toLowerCase();

  if (preferredCompanyName) {
    const matched = companies.find(
      (company) => company.name.trim().toLowerCase() === preferredCompanyName,
    );

    if (matched) return matched;
  }

  return companies[0] || null;
}

function isNonPartyOutstandingLedger(ledgerName?: string | null) {
  const name = normalizeLedgerName(ledgerName);
  if (!name) return true;

  const blockedExactNames = new Set([
    "sales account",
    "purchase account",
    "cash",
    "cash in hand",
    "round off",
    "rounding off",
    "cgst",
    "sgst",
    "igst",
    "input cgst",
    "input sgst",
    "input igst",
    "output cgst",
    "output sgst",
    "output igst",
  ]);
  if (blockedExactNames.has(name)) return true;
  return /^(?:input|output)?\s*(?:cgst|sgst|igst)(?:\s*@?\s*\d+(?:\.\d+)?%?)?$/i.test(
    name,
  );
}

function parseVoucherOutstandingRows(voucherBlock: string) {
  const voucherDate = readTallyDate(voucherBlock, "DATE");

  const voucherNo =
    stripXml(readTag(voucherBlock, "VOUCHERNUMBER")) ||
    stripXml(readTag(voucherBlock, "REFERENCE")) ||
    stripXml(readTag(voucherBlock, "VCHNO"));

  const voucherGuid =
    stripXml(readTag(voucherBlock, "GUID")) ||
    stripXml(readTag(voucherBlock, "VOUCHERGUID")) ||
    null;

  const voucherType =
    stripXml(readTag(voucherBlock, "VOUCHERTYPENAME")) ||
    readAttr(voucherBlock, "VOUCHER", "VCHTYPE") ||
    null;

  const nature = getVoucherNature(voucherType);

  if (!nature) {
    return [];
  }

  const partyLedgerName =
    stripXml(readTag(voucherBlock, "PARTYLEDGERNAME")) ||
    stripXml(readTag(voucherBlock, "PARTYNAME")) ||
    stripXml(readTag(voucherBlock, "BASICBUYERNAME")) ||
    stripXml(readTag(voucherBlock, "BASICSUPPLIERNAME"));

  const partyLedgerGuid =
    stripXml(readTag(voucherBlock, "PARTYLEDGERGUID")) || null;

  const voucherLevelCostCenter = getPrimaryCostCenter(voucherBlock);

  /**
   * IMPORTANT:
   * Do not combine ALLLEDGERENTRIES and LEDGERENTRIES.
   * Some Tally XML exports contain same ledger in both.
   * Combining both causes double outstanding.
   */
  const allLedgerEntries = extractBlocks(voucherBlock, "ALLLEDGERENTRIES.LIST");
  const normalLedgerEntries = extractBlocks(voucherBlock, "LEDGERENTRIES.LIST");

  const ledgerBlocks = allLedgerEntries.length
    ? allLedgerEntries
    : normalLedgerEntries;

  const rows: any[] = [];

  for (const ledgerBlock of ledgerBlocks) {
    const ledgerName =
      stripXml(readTag(ledgerBlock, "LEDGERNAME")) || partyLedgerName;

    if (!ledgerName) continue;

    if (isNonPartyOutstandingLedger(ledgerName)) {
      continue;
    }

    // Only party ledger bill allocations should be considered.
    if (partyLedgerName && !isSameName(ledgerName, partyLedgerName)) {
      continue;
    }

    const billBlocks = extractBlocks(ledgerBlock, "BILLALLOCATIONS.LIST");

    if (!billBlocks.length) continue;

    const ledgerGuid =
      stripXml(readTag(ledgerBlock, "LEDGERGUID")) ||
      stripXml(readTag(ledgerBlock, "PARTYLEDGERGUID")) ||
      partyLedgerGuid ||
      null;

    const ledgerCostCenter = getPrimaryCostCenter(ledgerBlock);

    const costCenter = ledgerCostCenter.cost_center_name
      ? ledgerCostCenter
      : voucherLevelCostCenter;

    for (const billBlock of billBlocks) {
      const billRef =
        stripXml(readTag(billBlock, "NAME")) ||
        stripXml(readTag(billBlock, "BILLNAME")) ||
        stripXml(readTag(billBlock, "REFERENCE")) ||
        voucherNo;

      if (!billRef) continue;

      const amountRaw =
        stripXml(readTag(billBlock, "AMOUNT")) ||
        stripXml(readTag(ledgerBlock, "AMOUNT"));

      const amount = toAbsNumberLike(amountRaw);

      if (amount <= 0) continue;

      const billDate =
        readTallyDate(billBlock, "BILLDATE") ||
        readTallyDate(billBlock, "DATE") ||
        voucherDate;

      const dueDate =
        readTallyDate(billBlock, "BILLDUEDATE") ||
        readTallyDate(billBlock, "DUEDATE") ||
        billDate ||
        voucherDate;

      rows.push({
        tallyGuid: voucherGuid,
        ledgerGuid,
        ledgerName,

        voucherGuid,
        voucherNumber: voucherNo || billRef,
        voucherNo: voucherNo || billRef,
        voucherType,
        voucherDate,
        dueDate,

        billRef,
        billType: nature.billType,

        effect: nature.effect,
        amount,

        costCenterName: costCenter.cost_center_name || null,
        cost_center_name: costCenter.cost_center_name || null,

        costCategory: costCenter.cost_category || null,
        cost_category: costCenter.cost_category || null,

        costCenterAmount: costCenter.cost_center_amount || 0,
        cost_center_amount: costCenter.cost_center_amount || 0,

        costCenterAllocations: costCenter.cost_center_allocations || [],
        cost_center_allocations: costCenter.cost_center_allocations || [],

        drCr: getDrCr(amountRaw),
        partyType: null,
        voucherKey: stripXml(readTag(voucherBlock, "VOUCHERKEY")) || null,
        voucher_key: stripXml(readTag(voucherBlock, "VOUCHERKEY")) || null,

        masterId: stripXml(readTag(voucherBlock, "MASTERID")) || null,
        master_id: stripXml(readTag(voucherBlock, "MASTERID")) || null,

        alterId: stripXml(readTag(voucherBlock, "ALTERID")) || null,
        alter_id: stripXml(readTag(voucherBlock, "ALTERID")) || null,

        tally_guid: voucherGuid,

        ledger_guid: ledgerGuid,
        ledger_name: ledgerName,

        voucher_guid: voucherGuid,
        voucher_number: voucherNo || billRef,
        voucher_no: voucherNo || billRef,

        voucherTypeName: voucherType,
        voucher_type_name: voucherType,

        voucher_date: voucherDate,
        due_date: dueDate,

        bill_ref: billRef,
        bill_type: nature.billType,

        rawTallyData: voucherBlock,
        raw_tally_data: voucherBlock,
      });
    }
  }

  return rows;
}

function parseVoucherItems(voucherBlock: string) {
  const allInventoryBlocks =
    voucherBlock.match(
      /<ALLINVENTORYENTRIES\.LIST\b[\s\S]*?<\/ALLINVENTORYENTRIES\.LIST>/gi,
    ) || [];

  const normalInventoryBlocks =
    voucherBlock.match(
      /<INVENTORYENTRIES\.LIST\b[\s\S]*?<\/INVENTORYENTRIES\.LIST>/gi,
    ) || [];

  const itemBlocks = allInventoryBlocks.length
    ? allInventoryBlocks
    : normalInventoryBlocks;

  return itemBlocks
    .map((itemBlock, index) => {
      const stockItemName =
        stripXml(readTag(itemBlock, "STOCKITEMNAME")) ||
        stripXml(readTag(itemBlock, "NAME"));

      const actualQtyRaw = stripXml(readTag(itemBlock, "ACTUALQTY"));
      const billedQtyRaw = stripXml(readTag(itemBlock, "BILLEDQTY"));
      const rateRaw = stripXml(readTag(itemBlock, "RATE"));
      const amountRaw = stripXml(readTag(itemBlock, "AMOUNT"));

      const quantity =
        parseQty(billedQtyRaw) ||
        parseQty(actualQtyRaw) ||
        toPositiveNumber(amountRaw);

      const rate = toPositiveNumber(rateRaw);
      const amount = toPositiveNumber(amountRaw);

      const hsnCode =
        readHsnCode(itemBlock) ||
        stripXml(readTag(itemBlock, "GSTHSNNAME")) ||
        "NA";

      const gstRate = readGstRate(itemBlock);
      const discount = toPositiveNumber(readTag(itemBlock, "DISCOUNT"));
      const taxableAmount = Math.max(amount - discount, 0);
      const taxAmount = gstRate > 0 ? (taxableAmount * gstRate) / 100 : 0;

      const unit =
        stripXml(readTag(itemBlock, "UNIT")) ||
        stripXml(readTag(itemBlock, "BASEUNITS")) ||
        stripXml(readTag(itemBlock, "STOCKITEMBASEUNITS")) ||
        "";

      const stockItemGuid =
        stripXml(readTag(itemBlock, "STOCKITEMGUID")) ||
        stripXml(readTag(itemBlock, "GUID")) ||
        null;

      return {
        lineNo: index + 1,
        line_no: index + 1,

        stockItemName,
        stock_item_name: stockItemName,

        stockItemGuid,
        stock_item_guid: stockItemGuid,

        description:
          stripXml(readTag(itemBlock, "DESCRIPTION")) ||
          stripXml(readTag(itemBlock, "NARRATION")) ||
          stockItemName,

        actualQty: actualQtyRaw,
        actual_qty: actualQtyRaw,

        billedQty: billedQtyRaw,
        billed_qty: billedQtyRaw,

        quantity,
        qty: quantity,

        rate,
        price: rate,

        amount,
        total: amount,

        unit,

        hsnCode,
        hsn_code: hsnCode,

        gstRate,
        gst_rate: gstRate,
        taxRate: gstRate,
        tax_rate: gstRate,
        discount,
        taxAmount,
        tax_amount: taxAmount,

        rawTallyData: itemBlock,
        raw_tally_data: itemBlock,
      };
    })
    .filter((item) => item.stockItemName);
}

function inferOfficialBillReportType(xml: string) {
  return /bills payable|bill payable|payable/i.test(xml)
    ? "payable"
    : "receivable";
}

function parseOfficialBillFixedOutstandingRows(
  xml: string,
  explicitBillType?: "receivable" | "payable",
) {
  const source = String(xml || "").replace(/\u0000/g, "");
  const billType = explicitBillType || inferOfficialBillReportType(source);
  const voucherType =
    billType === "receivable" ? "Bills Receivable" : "Bills Payable";

  const segments =
    source.match(/<BILLFIXED\b[\s\S]*?(?=<BILLFIXED\b|<\/ENVELOPE>|$)/gi) || [];

  return segments
    .map((segment) => {
      const fixedBlock =
        segment.match(/<BILLFIXED\b[\s\S]*?<\/BILLFIXED>/i)?.[0] || segment;

      const ledgerName =
        stripXml(readTag(fixedBlock, "BILLPARTY")) ||
        stripXml(readTag(fixedBlock, "LEDGERNAME")) ||
        stripXml(readTag(fixedBlock, "PARTYLEDGERNAME")) ||
        stripXml(readTag(fixedBlock, "PARTYNAME"));

      const billRef =
        stripXml(readTag(fixedBlock, "BILLREF")) ||
        stripXml(readTag(fixedBlock, "BILLNAME")) ||
        stripXml(readTag(fixedBlock, "REFERENCE")) ||
        stripXml(readTag(fixedBlock, "NAME"));

      const billDate =
        readTallyDate(fixedBlock, "BILLDATE") ||
        readTallyDate(fixedBlock, "DATE");

      const pendingAmountRaw =
        stripXml(readTag(segment, "BILLCL")) ||
        stripXml(readTag(segment, "BILLCLOSING")) ||
        stripXml(readTag(segment, "CLOSINGBALANCE")) ||
        stripXml(readTag(segment, "PENDINGAMOUNT")) ||
        stripXml(readTag(segment, "AMOUNT"));

      const pendingAmount = toAbsNumberLike(pendingAmountRaw);

      const dueDate =
        readTallyDate(segment, "BILLDUE") ||
        readTallyDate(segment, "BILLDUEDATE") ||
        readTallyDate(segment, "DUEDATE") ||
        billDate;

      const overdueDaysRaw =
        stripXml(readTag(segment, "BILLOVERDUE")) ||
        stripXml(readTag(segment, "OVERDUEDAYS"));

      return {
        ledgerName,
        ledgerGuid: null,

        voucherGuid: null,
        voucherNo: billRef || null,
        voucherNumber: billRef || null,
        voucherType,

        voucherDate: billDate,
        dueDate,

        billRef,
        billType,
        openingAmount: pendingAmount,
        billAmount: pendingAmount,
        pendingAmount,
        outstandingAmount: pendingAmount,

        costCenterName: null,
        cost_center_name: null,

        costCategory: null,
        cost_category: null,

        costCenterAmount: 0,
        cost_center_amount: 0,

        costCenterAllocations: [],
        cost_center_allocations: [],

        overdueDays: toAbsNumberLike(overdueDaysRaw),
        drCr: getDrCr(pendingAmountRaw),

        partyType: null,
        tallyGuid: null,
        tally_guid: null,

        ledger_guid: null,
        ledger_name: ledgerName,

        voucher_guid: null,
        voucher_number: billRef || null,
        voucher_no: billRef || null,

        voucherTypeName: voucherType,
        voucher_type_name: voucherType,

        voucher_date: billDate,
        due_date: dueDate,

        bill_ref: billRef,
        bill_type: billType,

        rawTallyData: segment,
        raw_tally_data: segment,
      };
    })
    .filter(
      (row) =>
        row.ledgerName &&
        row.billRef &&
        row.pendingAmount > 0 &&
        !isNonPartyOutstandingLedger(row.ledgerName),
    );
}

export function parseOutstandings(
  xml: string,
  explicitBillType?: "receivable" | "payable",
) {
  const source = sanitizeTallyXmlText(xml);

  const voucherBlocks = extractBlocks(source, "VOUCHER");

  if (voucherBlocks.length) {
    const rawRows = voucherBlocks
      .flatMap((voucherBlock) => parseVoucherOutstandingRows(voucherBlock))
      .filter((row) => row.ledgerName && row.billRef && row.amount > 0);

    const grouped = new Map<string, any>();

    for (const row of rawRows) {
      const key = buildOutstandingKey({
        billType: row.billType,
        ledgerName: row.ledgerName,
        billRef: row.billRef,
      });

      if (!grouped.has(key)) {
        grouped.set(key, {
          ...row,
          baseAmount: 0,
          adjustmentAmount: 0,
        });
      }

      const current = grouped.get(key);

      if (row.effect === "base") {
        current.baseAmount += row.amount;

        // Keep bill details from Sales/Purchase voucher.
        current.tallyGuid = row.tallyGuid;
        current.voucherGuid = row.voucherGuid;
        current.voucherNumber = row.voucherNumber;
        current.voucherNo = row.voucherNo;
        current.voucherType = row.voucherType;
        current.voucherDate = row.voucherDate;
        current.dueDate = row.dueDate;
        current.ledgerGuid = row.ledgerGuid || current.ledgerGuid;

        current.costCenterName = row.costCenterName || current.costCenterName;
        current.cost_center_name =
          row.cost_center_name || current.cost_center_name;

        current.costCategory = row.costCategory || current.costCategory;
        current.cost_category = row.cost_category || current.cost_category;

        current.costCenterAmount =
          row.costCenterAmount || current.costCenterAmount;

        current.cost_center_amount =
          row.cost_center_amount || current.cost_center_amount;

        current.costCenterAllocations =
          row.costCenterAllocations || current.costCenterAllocations;

        current.cost_center_allocations =
          row.cost_center_allocations || current.cost_center_allocations;
      }

      if (row.effect === "adjustment") {
        current.adjustmentAmount += row.amount;
      }
    }

    return Array.from(grouped.values())
      .map((row) => {
        const baseAmount = Number(row.baseAmount || 0);
        const adjustmentAmount = Number(row.adjustmentAmount || 0);

        const pendingAmount = Math.max(0, baseAmount - adjustmentAmount);

        return {
          ...row,

          // Tally Bills Receivable screen shows pending amount.
          billAmount: pendingAmount,
          pendingAmount,
          outstandingAmount: pendingAmount,

          openingAmount: baseAmount,
          adjustmentAmount,
        };
      })
      .filter(
        (row) =>
          row.ledgerName &&
          row.billRef &&
          row.baseAmount > 0 &&
          row.pendingAmount > 0,
      );
  }

  const officialBillRows = parseOfficialBillFixedOutstandingRows(
    source,
    explicitBillType,
  );

  if (officialBillRows.length) {
    return officialBillRows;
  }

  let blocks = extractBlocks(source, "BILLFIXED");

  if (!blocks.length) {
    blocks = extractBlocks(source, "BILL");
  }

  if (!blocks.length) {
    blocks = extractBlocks(source, "BILLS");
  }

  return blocks
    .map((block) => {
      const costCenter = getPrimaryCostCenter(block);

      const ledgerName =
        readTag(block, "BILLPARTY") ||
        readTag(block, "LEDGERNAME") ||
        readTag(block, "PARTYLEDGERNAME") ||
        readTag(block, "PARTYNAME") ||
        readTag(block, "NAME");

      const billRef =
        readAttr(block, "NAME", "NAME") ||
        readTag(block, "BILLNAME") ||
        readTag(block, "REFERENCE") ||
        readTag(block, "REFERENCENUMBER") ||
        readTag(block, "BILLREF") ||
        readTag(block, "NAME");

      const voucherNo =
        readTag(block, "VOUCHERNUMBER") ||
        readTag(block, "VOUCHERNO") ||
        readTag(block, "VCHNO");

      const voucherType =
        readTag(block, "VOUCHERTYPENAME") ||
        readTag(block, "VOUCHERTYPE") ||
        readTag(block, "VCHTYPE");

      const voucherDate =
        readTallyDate(block, "BILLDATE") ||
        readTallyDate(block, "DATE") ||
        readTallyDate(block, "VOUCHERDATE");

      const dueDate =
        readTallyDate(block, "BILLDUEDATE") ||
        readTallyDate(block, "BILLCREDITPERIOD") ||
        readTallyDate(block, "DUEDATE") ||
        voucherDate;

      const openingAmountRaw =
        readTag(block, "BILLOPENING") ||
        readTag(block, "OPENINGBALANCE") ||
        readTag(block, "OPENINGAMOUNT");

      const pendingAmountRaw =
        readTag(block, "BILLCLOSING") ||
        readTag(block, "BILLCL") ||
        readTag(block, "CLOSINGBALANCE") ||
        readTag(block, "PENDINGAMOUNT") ||
        readTag(block, "AMOUNT");

      const overdueDaysRaw =
        readTag(block, "BILLOVERDUE") || readTag(block, "OVERDUEDAYS");

      const openingAmount = toAbsNumberLike(openingAmountRaw);
      const pendingAmount = toAbsNumberLike(pendingAmountRaw);

      return {
        ledgerName,
        ledgerGuid:
          stripXml(readTag(block, "LEDGERGUID")) ||
          stripXml(readTag(block, "PARTYLEDGERGUID")) ||
          stripXml(readTag(block, "MASTERGUID")) ||
          null,

        voucherGuid:
          stripXml(readTag(block, "VOUCHERGUID")) ||
          stripXml(readTag(block, "GUID")) ||
          null,

        billRef,
        voucherNo: voucherNo || null,
        voucherNumber: voucherNo || null,
        voucherType: voucherType || null,

        voucherDate,
        dueDate,

        billType: explicitBillType || inferOfficialBillReportType(source),
        openingAmount,
        billAmount: pendingAmount,
        pendingAmount,
        outstandingAmount: pendingAmount,

        costCenterName: costCenter.cost_center_name || null,
        cost_center_name: costCenter.cost_center_name || null,

        costCategory: costCenter.cost_category || null,
        cost_category: costCenter.cost_category || null,

        costCenterAmount: costCenter.cost_center_amount || 0,
        cost_center_amount: costCenter.cost_center_amount || 0,

        costCenterAllocations: costCenter.cost_center_allocations || [],
        cost_center_allocations: costCenter.cost_center_allocations || [],

        overdueDays: toAbsNumberLike(overdueDaysRaw),

        drCr: getDrCr(pendingAmountRaw || openingAmountRaw),

        partyType: null,
        tallyGuid:
          stripXml(readTag(block, "VOUCHERGUID")) ||
          stripXml(readTag(block, "GUID")) ||
          null,

        tally_guid:
          stripXml(readTag(block, "VOUCHERGUID")) ||
          stripXml(readTag(block, "GUID")) ||
          null,

        ledger_guid:
          stripXml(readTag(block, "LEDGERGUID")) ||
          stripXml(readTag(block, "PARTYLEDGERGUID")) ||
          stripXml(readTag(block, "MASTERGUID")) ||
          null,

        ledger_name: ledgerName,

        voucher_guid:
          stripXml(readTag(block, "VOUCHERGUID")) ||
          stripXml(readTag(block, "GUID")) ||
          null,

        voucher_number: voucherNo || null,
        voucher_no: voucherNo || null,

        voucherTypeName: voucherType || null,
        voucher_type_name: voucherType || null,

        voucher_date: voucherDate,
        due_date: dueDate,

        bill_ref: billRef,

        bill_type: explicitBillType || inferOfficialBillReportType(source),

        rawTallyData: block,
        raw_tally_data: block,
      };
    })
    .filter(
      (row) =>
        row.ledgerName &&
        row.billRef &&
        row.pendingAmount > 0 &&
        !isNonPartyOutstandingLedger(row.ledgerName),
    );
}

function readBlocks(xml: string, tagName: string) {
  const re = new RegExp(`<${tagName}\\b[\\s\\S]*?<\\/${tagName}>`, "gi");
  return String(xml || "").match(re) || [];
}

function readAllTagValues(block: string, tagName: string) {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `<${escapedTag}\\b[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`,
    "gi",
  );

  const values: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(block)) !== null) {
    const value = stripXml(match[1]);
    if (value) values.push(value);
  }

  return values;
}

function readAllUdfValuesBySuffix(block: string, suffix: string) {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `<UDF:[^>\\s]*${escapedSuffix}\\b[^>]*>([\\s\\S]*?)<\\/UDF:[^>\\s]*${escapedSuffix}>`,
    "gi",
  );

  const values: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(block)) !== null) {
    const value = stripXml(match[1]);
    if (value) values.push(value);
  }

  return values;
}

function isUsefulCostCenterName(value?: string | null) {
  const normalized = normalizeText(value || "");

  return Boolean(
    normalized &&
    ![
      "unknown",
      "not applicable",
      "not available",
      "not found",
      "end of list",
    ].includes(normalized),
  );
}

function parseVoucherCostCenters(voucherBlock: string) {
  type Allocation = {
    guid: string | null;
    name: string;
    category: string | null;
    amount: number;
  };
  const partyLedgerName =
    stripXml(readTag(voucherBlock, "PARTYLEDGERNAME")) ||
    stripXml(readTag(voucherBlock, "PARTYNAME"));

  const parseScopeAllocations = (scope: string): Allocation[] => {
    const rows: Allocation[] = [];
    for (const categoryBlock of readBlocks(scope, "CATEGORYALLOCATIONS.LIST")) {
      const category =
        stripXml(readTag(categoryBlock, "CATEGORY")) ||
        stripXml(readTag(categoryBlock, "NAME")) ||
        null;
      for (const ccBlock of readBlocks(
        categoryBlock,
        "COSTCENTREALLOCATIONS.LIST",
      )) {
        const name =
          stripXml(readTag(ccBlock, "NAME")) ||
          stripXml(readTag(ccBlock, "COSTCENTRENAME")) ||
          stripXml(readTag(ccBlock, "COSTCENTERNAME"));
        if (!isUsefulCostCenterName(name)) continue;
        rows.push({
          guid:
            stripXml(readTag(ccBlock, "GUID")) ||
            stripXml(readTag(ccBlock, "COSTCENTREGUID")) ||
            stripXml(readTag(ccBlock, "COSTCENTERGUID")) ||
            null,
          name,
          category,
          amount: toPositiveNumber(readTag(ccBlock, "AMOUNT")),
        });
      }
    }
    return rows;
  };

  const allLedgerBlocks = readBlocks(voucherBlock, "ALLLEDGERENTRIES.LIST");
  const ledgerBlocks = allLedgerBlocks.length
    ? allLedgerBlocks
    : readBlocks(voucherBlock, "LEDGERENTRIES.LIST");
  const business: Allocation[] = [];
  const party: Allocation[] = [];

  for (const ledgerBlock of ledgerBlocks) {
    const ledgerName = stripXml(readTag(ledgerBlock, "LEDGERNAME"));
    const rows = parseScopeAllocations(ledgerBlock);
    if (!rows.length) continue;
    if (partyLedgerName && isSameName(ledgerName, partyLedgerName))
      party.push(...rows);
    else business.push(...rows);
  }

  let selected = business.length ? business : party;
  if (!selected.length) {
    const allInventory = readBlocks(voucherBlock, "ALLINVENTORYENTRIES.LIST");
    const inventory = allInventory.length
      ? allInventory
      : readBlocks(voucherBlock, "INVENTORYENTRIES.LIST");
    selected = inventory.flatMap(parseScopeAllocations);
  }
  if (!selected.length) selected = parseScopeAllocations(voucherBlock);

  if (!selected.length) {
    const fallbackNames = [
      ...readAllTagValues(voucherBlock, "COSTCENTRENAME"),
      ...readAllTagValues(voucherBlock, "COSTCENTERNAME"),
      ...readAllTagValues(voucherBlock, "UDF:CCM_VCHBILLCC"),
      ...readAllUdfValuesBySuffix(voucherBlock, "VCHBILLCC"),
      ...readAllUdfValuesBySuffix(voucherBlock, "BILLCC"),
    ];
    selected = Array.from(new Set(fallbackNames.map(stripXml)))
      .filter(isUsefulCostCenterName)
      .map((name) => ({ guid: null, name, category: null, amount: 0 }));
  }

  const merged = new Map<string, Allocation>();
  for (const row of selected) {
    const key = `${row.guid || ""}::${normalizeText(row.name)}::${normalizeText(row.category || "")}`;
    const existing = merged.get(key);
    if (existing) existing.amount += Number(row.amount || 0);
    else merged.set(key, { ...row });
  }
  const finalAllocations = Array.from(merged.values());
  const primary =
    finalAllocations.find((row) => Number(row.amount || 0) > 0) ||
    finalAllocations[0] ||
    null;

  return {
    costCenterGuid: primary?.guid || null,
    costCenterName: primary?.name || null,
    costCategory: primary?.category || null,
    costCenterAmount: finalAllocations.reduce(
      (sum, row) => sum + Number(row.amount || 0),
      0,
    ),
    costCenterAllocations: finalAllocations,
  };
}

type VoucherOrderParseOptions = {
  exactVoucherType?: boolean;
  excludeOrderVoucherTypes?: boolean;
  trustSourceCollection?: boolean;
  voucherNature?: "sales" | "purchase" | "delivery_challan";
};

function isVoucherTypeAllowed(
  voucherType: string | null | undefined,
  expectedVoucherType: string,
  options: VoucherOrderParseOptions = {},
) {
  const normalizedVoucherType = normalizeText(voucherType);
  const normalizedExpectedType = normalizeText(expectedVoucherType);

  if (!normalizedExpectedType) return true;
  if (!normalizedVoucherType) return Boolean(options.trustSourceCollection);

  if (
    options.excludeOrderVoucherTypes &&
    normalizedVoucherType.includes("order")
  ) {
    return false;
  }

  if (options.trustSourceCollection) return true;
  if (options.exactVoucherType)
    return normalizedVoucherType === normalizedExpectedType;
  return normalizedVoucherType.includes(normalizedExpectedType);
}

function parseVoucherOrders(
  xml: string,
  expectedVoucherType: string,
  options: VoucherOrderParseOptions = {},
) {
  const source = sanitizeTallyXmlText(xml);

  const voucherBlocks = source.match(/<VOUCHER\b[\s\S]*?<\/VOUCHER>/gi) || [];

  return voucherBlocks
    .map((block) => {
      const voucherType =
        stripXml(readTag(block, "VOUCHERTYPENAME")) ||
        readAttr(block, "VOUCHER", "VCHTYPE");

      if (!isVoucherTypeAllowed(voucherType, expectedVoucherType, options)) {
        return null;
      }

      const guid =
        stripXml(readTag(block, "GUID")) ||
        stripXml(readTag(block, "VOUCHERGUID")) ||
        null;

      const voucherKey = stripXml(readTag(block, "VOUCHERKEY")) || null;
      const masterId = stripXml(readTag(block, "MASTERID")) || null;
      const alterId = stripXml(readTag(block, "ALTERID")) || null;

      const voucherDate =
        readTallyDate(block, "DATE") ||
        normalizeDate(stripXml(readTag(block, "DATE")));

      const voucherNumber =
        stripXml(readTag(block, "VOUCHERNUMBER")) ||
        stripXml(readTag(block, "REFERENCE")) ||
        stripXml(readTag(block, "VCHNO")) ||
        "";

      const partyLedgerName =
        stripXml(readTag(block, "PARTYLEDGERNAME")) ||
        stripXml(readTag(block, "PARTYNAME")) ||
        stripXml(readTag(block, "BASICBUYERNAME")) ||
        stripXml(readTag(block, "BASICSUPPLIERNAME"));

      const partyGuid =
        stripXml(readTag(block, "PARTYLEDGERGUID")) ||
        stripXml(readTag(block, "LEDGERGUID")) ||
        null;

      if (
        !guid &&
        !masterId &&
        !voucherNumber &&
        !voucherDate &&
        !partyLedgerName
      ) {
        return null;
      }

      const items = parseVoucherItems(block);

      const sourceInventoryBlocks = (() => {
        const allInventoryBlocks =
          block.match(
            /<ALLINVENTORYENTRIES\.LIST\b[\s\S]*?<\/ALLINVENTORYENTRIES\.LIST>/gi,
          ) || [];

        if (allInventoryBlocks.length) return allInventoryBlocks;

        return (
          block.match(
            /<INVENTORYENTRIES\.LIST\b[\s\S]*?<\/INVENTORYENTRIES\.LIST>/gi,
          ) || []
        );
      })();

      // Tally can emit an empty INVENTORYENTRIES.LIST node for accounting-only
      // vouchers. Counting list tags caused false parser failures. Count only
      // source entries that actually contain a non-empty STOCKITEMNAME.
      const sourceInventoryEntryCount = sourceInventoryBlocks.filter(
        (itemBlock) => Boolean(stripXml(readTag(itemBlock, "STOCKITEMNAME"))),
      ).length;

      const itemsParsedSuccessfully =
        sourceInventoryEntryCount === items.length;

      const itemsTotal = items.reduce(
        (sum, item) => sum + Number(item.amount || 0),
        0,
      );

      const voucherAmount = toPositiveNumber(readTag(block, "AMOUNT"));
      const totalAmount = voucherAmount || itemsTotal;

      const costCenterData = parseVoucherCostCenters(block);

      const referenceNumber = readVoucherReferenceNumber(block);

      const basicOrderRef = stripXml(readTag(block, "BASICORDERREF")) || "";
      const basicBuyerOrderNo =
        stripXml(readTag(block, "BASICBUYERORDERNO")) || "";

      const orderRef =
        stripXml(readTag(block, "ORDERREFERENCE")) ||
        stripXml(readTag(block, "ORDERREF")) ||
        "";

      const dueDate =
        readTallyDate(block, "BASICDUEDATEOFPYMT") ||
        normalizeDate(stripXml(readTag(block, "BASICDUEDATEOFPYMT")));

      const narration = stripXml(readTag(block, "NARRATION"));

      return {
        guid,
        voucherKey,
        masterId,
        alterId,
        voucherNumber,
        voucherType,
        voucherDate,
        partyName: partyLedgerName,
        partyGuid,
        referenceNumber,
        basicOrderRef,
        basicBuyerOrderNo,
        orderRef,
        dueDate,
        narration,
        totalAmount,
        items,
        voucherNature: options.voucherNature || null,
        voucher_nature: options.voucherNature || null,
        inventoryEntryCount: sourceInventoryEntryCount,
        inventory_entry_count: sourceInventoryEntryCount,
        itemsParsedSuccessfully,
        items_parsed_successfully: itemsParsedSuccessfully,

        costCenterGuid: costCenterData.costCenterGuid,
        costCenterName: costCenterData.costCenterName,
        costCategory: costCenterData.costCategory,
        costCenterAmount: costCenterData.costCenterAmount,
        costCenterAllocations: costCenterData.costCenterAllocations,

        tallyGuid: guid,
        tally_guid: guid,

        voucherGuid: guid,
        voucher_guid: guid,

        voucher_key: voucherKey,

        master_id: masterId,
        alter_id: alterId,

        voucherNo: voucherNumber,
        voucher_no: voucherNumber,
        voucher_number: voucherNumber,

        voucherTypeName: voucherType,
        voucher_type_name: voucherType,

        partyLedgerName,
        party_ledger_name: partyLedgerName,
        party_name: partyLedgerName,

        partyLedgerGuid: partyGuid,
        party_ledger_guid: partyGuid,

        reference: referenceNumber,
        reference_number: referenceNumber,

        basic_order_ref: basicOrderRef,
        basic_buyer_order_no: basicBuyerOrderNo,
        order_ref: orderRef,

        amount: totalAmount,
        total_amount: totalAmount,

        cost_center_guid: costCenterData.costCenterGuid,
        cost_center_name: costCenterData.costCenterName,
        cost_category: costCenterData.costCategory,
        cost_center_amount: costCenterData.costCenterAmount,
        cost_center_allocations: costCenterData.costCenterAllocations,

        rawTallyData: block,
        raw_tally_data: block,
      };
    })
    .filter(Boolean);
}

export function parseSalesOrders(xml: string) {
  return parseVoucherOrders(xml, "Sales", {
    exactVoucherType: true,
    excludeOrderVoucherTypes: true,
    voucherNature: "sales",
  });
}

export function parsePurchaseOrders(xml: string) {
  return parseVoucherOrders(xml, "Purchase", { voucherNature: "purchase" });
}

/**
 * Historical deep transaction sync:
 * Use inclusive voucher type matching for custom Tally voucher types like
 * "GST Sales", "Local Purchase", etc. but always exclude Order vouchers.
 * Existing parseSalesOrders/parsePurchaseOrders are kept unchanged.
 */
export function parseSalesVouchers(xml: string) {
  return parseVoucherOrders(xml, "Sales", {
    trustSourceCollection: true,
    excludeOrderVoucherTypes: true,
    voucherNature: "sales",
  });
}

export function parsePurchaseVouchers(xml: string) {
  return parseVoucherOrders(xml, "Purchase", {
    trustSourceCollection: true,
    excludeOrderVoucherTypes: true,
    voucherNature: "purchase",
  });
}

export function parseDeliveryChallans(xml: string) {
  return parseVoucherOrders(xml, "Delivery Note");
}
