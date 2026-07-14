import {
  parseTallyCompanies,
  resolveTallyCompany,
  TallyCompanyForSync,
  TallyCompanySelection,
} from "./tally-company-selector";
import { fetchTallyCompaniesXml } from "./tally.client";

type ConfiguredCompanySelector = {
  raw: string;
  name?: string | null;
  guid?: string | null;
};

function normalizeName(value?: string | null) {
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

function looksLikeGuid(value?: string | null) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value || "").trim(),
  );
}

function parseConfiguredToken(rawToken: string): ConfiguredCompanySelector {
  const raw = rawToken.trim();
  const separator = raw.includes("::") ? "::" : raw.includes("|") ? "|" : null;

  if (!separator) {
    return looksLikeGuid(raw)
      ? { raw, guid: raw, name: null }
      : { raw, name: raw, guid: null };
  }

  const parts = raw
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean);

  const guid = parts.find((part) => looksLikeGuid(part)) || null;
  const name = parts.find((part) => !looksLikeGuid(part)) || null;

  return { raw, name, guid };
}

export function getConfiguredCompanySelectors(): ConfiguredCompanySelector[] {
  const multi = String(process.env.TALLY_COMPANIES || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(parseConfiguredToken);

  if (multi.length) return multi;

  const singularGuid = String(process.env.TALLY_COMPANY_GUID || "").trim();
  const singularName = String(process.env.TALLY_COMPANY_NAME || "").trim();

  if (singularGuid || singularName) {
    return [
      {
        raw: singularGuid || singularName,
        guid: singularGuid || null,
        name: singularName || null,
      },
    ];
  }

  return [];
}

export async function getAvailableTallyCompanies(): Promise<
  TallyCompanyForSync[]
> {
  const xml = await fetchTallyCompaniesXml();
  const companies = parseTallyCompanies(String(xml || ""));

  if (!companies.length) {
    throw new Error("No Tally companies were returned by the XML endpoint.");
  }

  return companies;
}

function selectorMatchesCompany(
  selector: ConfiguredCompanySelector,
  company: TallyCompanyForSync,
) {
  if (selector.guid) {
    return normalizeGuid(selector.guid) === normalizeGuid(company.guid);
  }

  if (selector.name) {
    return normalizeName(selector.name) === normalizeName(company.name);
  }

  return false;
}

function companyKey(company: TallyCompanyForSync) {
  return normalizeGuid(company.guid) || normalizeName(company.name);
}

export async function resolveConfiguredTallyCompanies(
  selection: TallyCompanySelection = {},
): Promise<TallyCompanyForSync[]> {
  const configured = getConfiguredCompanySelectors();
  const explicitGuid = String(selection.companyGuid || "").trim();
  const explicitName = String(selection.companyName || "").trim();

  if (explicitGuid || explicitName) {
    const selected = await resolveTallyCompany({
      companyGuid: explicitGuid || null,
      companyName: explicitName || null,
    });

    if (
      !selection.skipConfiguredAllowlist &&
      configured.length > 0 &&
      !configured.some((selector) => selectorMatchesCompany(selector, selected))
    ) {
      throw new Error(
        `Requested Tally company "${selected.name}" is not present in TALLY_COMPANIES. Sync stopped for safety.`,
      );
    }

    return [selected];
  }

  if (!configured.length) {
    throw new Error(
      "No safe Tally company configuration found. Set TALLY_COMPANIES, or TALLY_COMPANY_GUID/TALLY_COMPANY_NAME.",
    );
  }

  const available = await getAvailableTallyCompanies();
  const resolved: TallyCompanyForSync[] = [];
  const missing: string[] = [];

  for (const selector of configured) {
    const matches = available.filter((company) =>
      selectorMatchesCompany(selector, company),
    );

    if (matches.length === 1) {
      resolved.push(matches[0]);
      continue;
    }

    if (matches.length > 1) {
      throw new Error(
        `Multiple Tally companies matched configured value "${selector.raw}". Configure the company GUID explicitly.`,
      );
    }

    missing.push(selector.raw);
  }

  if (missing.length) {
    const availableText = available
      .map(
        (company) =>
          `${company.name}${company.guid ? ` [${company.guid}]` : ""}`,
      )
      .join(" | ");

    throw new Error(
      `Configured Tally companies not found exactly: ${missing.join(", ")}. Available: ${availableText}`,
    );
  }

  const unique = new Map<string, TallyCompanyForSync>();

  for (const company of resolved) {
    unique.set(companyKey(company), company);
  }

  return Array.from(unique.values());
}

export async function getTallyCompanyDiagnostics() {
  const configured = getConfiguredCompanySelectors();
  const available = await getAvailableTallyCompanies();

  const resolved = configured.length
    ? await resolveConfiguredTallyCompanies()
    : [];

  return {
    configured,
    available,
    resolved,
    safe_to_sync:
      configured.length > 0 && resolved.length === configured.length,
  };
}
