import {
  fetchCurrentTallyCompanyXml,
  fetchTallyCompaniesXml,
} from "./tally.client";

export type TallyCompanyForSync = {
  name: string;
  guid?: string | null;
  state?: string | null;
  country?: string | null;
  booksFrom?: string | null;
  startingFrom?: string | null;
};

export type TallyCompanySelection = {
  companyName?: string | null;
  companyGuid?: string | null;
  /** Internal use: dynamically detected current Tally company may bypass .env allowlist. */
  skipConfiguredAllowlist?: boolean;
};

function decodeXml(value: string) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, `"`)
    .replace(/&apos;/g, "'");
}

function readTag(block: string, tag: string): string {
  const match = block.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"),
  );

  return decodeXml(match?.[1]?.trim() || "");
}

function readAttr(block: string, tag: string, attr: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, "i"));

  return decodeXml(match?.[1]?.trim() || "");
}

function normalizeCompanyName(value?: string | null) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeGuid(value?: string | null) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function parseTallyCompanies(xml: string): TallyCompanyForSync[] {
  const text = String(xml || "");

  const companyBlocks = text.match(/<COMPANY[\s\S]*?<\/COMPANY>/gi) || [];

  const companies = companyBlocks
    .map((block) => {
      const attrName = readAttr(block, "COMPANY", "NAME");
      const tagName = readTag(block, "NAME");

      return {
        name: attrName || tagName,
        guid: readTag(block, "GUID") || null,
        state: readTag(block, "STATENAME") || null,
        country: readTag(block, "COUNTRYOFRESIDENCE") || null,
        booksFrom: readTag(block, "BOOKSFROM") || null,
        startingFrom: readTag(block, "STARTINGFROM") || null,
      };
    })
    .filter((company) => Boolean(company.name));

  const unique = new Map<string, TallyCompanyForSync>();

  for (const company of companies) {
    const key =
      normalizeGuid(company.guid) || normalizeCompanyName(company.name);

    if (!unique.has(key)) {
      unique.set(key, company);
    }
  }

  return Array.from(unique.values());
}


/**
 * Resolves the company that is currently active in the Tally UI.
 * No company name/GUID is read from .env for this lookup.
 */
export async function resolveCurrentTallyCompany(): Promise<TallyCompanyForSync> {
  const currentCompanyXml = await fetchCurrentTallyCompanyXml();
  const companies = parseTallyCompanies(String(currentCompanyXml || ""));

  if (!companies.length) {
    throw new Error(
      "No active Tally company detected. Open/select one company in Tally and retry.",
    );
  }

  if (companies.length > 1) {
    throw new Error(
      `Multiple active Tally companies were returned: ${companies
        .map((company) => company.name)
        .join(" | ")}. Keep/select one current company and retry.`,
    );
  }

  console.log("[TALLY] Current opened company auto-detected:", companies[0]);

  return companies[0];
}

/**
 * Manual/API-triggered sync ke liye company GUID ya exact name se select hoti hai.
 * Daily sync is resolver ko directly use nahi karta; wo resolveCurrentTallyCompany()
 * se active Tally company detect karke explicit GUID/name pass karta hai.
 *
 * Priority:
 * 1. Request body companyGuid
 * 2. ENV TALLY_COMPANY_GUID
 * 3. Request body companyName
 * 4. ENV TALLY_COMPANY_NAME
 */
export async function resolveTallyCompany(
  selection: TallyCompanySelection = {},
): Promise<TallyCompanyForSync> {
  const requestedGuid = String(
    selection.companyGuid || process.env.TALLY_COMPANY_GUID || "",
  ).trim();

  const requestedName = String(
    selection.companyName || process.env.TALLY_COMPANY_NAME || "",
  ).trim();

  if (!requestedGuid && !requestedName) {
    throw new Error(
      "Safe company selection is required. Set TALLY_COMPANY_GUID (preferred) or TALLY_COMPANY_NAME in .env, or send companyGuid/companyName in /sync/run.",
    );
  }

  const companiesXml = await fetchTallyCompaniesXml();

  const companies = parseTallyCompanies(String(companiesXml || ""));

  if (!companies.length) {
    throw new Error("No Tally companies were returned by the XML endpoint.");
  }

  /*
   * GUID matching has first priority.
   */
  if (requestedGuid) {
    const guidMatches = companies.filter(
      (company) => normalizeGuid(company.guid) === normalizeGuid(requestedGuid),
    );

    if (guidMatches.length === 1) {
      console.log("[TALLY] Company selected by GUID:", guidMatches[0]);

      return guidMatches[0];
    }

    if (guidMatches.length > 1) {
      throw new Error(
        `Multiple Tally companies matched TALLY_COMPANY_GUID=${requestedGuid}. Sync stopped for safety.`,
      );
    }

    throw new Error(
      `Configured TALLY_COMPANY_GUID=${requestedGuid} was not found in Tally. Sync stopped for safety.`,
    );
  }

  /*
   * Name matching must be exact after trim/case/spacing normalization.
   * Partial or contains matching intentionally nahi karni hai.
   */
  const nameMatches = companies.filter(
    (company) =>
      normalizeCompanyName(company.name) ===
      normalizeCompanyName(requestedName),
  );

  if (nameMatches.length === 1) {
    console.log("[TALLY] Company selected by exact name:", nameMatches[0]);

    return nameMatches[0];
  }

  if (nameMatches.length > 1) {
    throw new Error(
      `Multiple Tally companies have the exact name "${requestedName}". Configure TALLY_COMPANY_GUID to select safely.`,
    );
  }

  const available = companies
    .slice(0, 20)
    .map(
      (company) => `${company.name}${company.guid ? ` [${company.guid}]` : ""}`,
    )
    .join(" | ");

  throw new Error(
    `Configured TALLY_COMPANY_NAME="${requestedName}" was not found exactly. Available companies: ${available}`,
  );
}
