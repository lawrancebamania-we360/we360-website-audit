// One-off runner (not app code) — calls the real PageSpeed Insights API for a
// fixed list of we360.ai production URLs, on both mobile + desktop.
// Saves TWO things per (url, strategy):
//   1. The full raw PSI/Lighthouse response (site-audits/<date>/pagespeed-raw/) —
//      includes screenshot-thumbnails + network-requests, so filmstrip/waterfall
//      can be rendered from it later without re-fetching.
//   2. A compact summary (pagespeed-insights.json) with scores, lab metrics,
//      field data, AND every failing/non-perfect audit across all 4 categories
//      (not just performance "opportunities") — the actual worklist.
//
// Usage: node site-audits/run-pagespeed.mjs <api-key> <out-dir>

import fs from "node:fs/promises";

const apiKey = process.argv[2];
const outDir = process.argv[3];
if (!apiKey || !outDir) {
  console.error("Usage: node run-pagespeed.mjs <api-key> <out-dir>");
  process.exit(1);
}

// Locked scope — see site-audits/_test-scope.json. Pass a comma-separated
// list of labels via argv[4] to run a subset (default: all).
const ALL_URLS = [
  { label: "homepage", url: "https://www.we360.ai/" },
  { label: "solutions-wfh-monitoring", url: "https://www.we360.ai/solutions/wfh-monitoring/" },
  { label: "alternative-timechamp", url: "https://www.we360.ai/alternative/timechamp/" },
  { label: "industry-digital-marketing-agency", url: "https://www.we360.ai/industry/digital-marketing-agency/" },
  { label: "blog-top-5-hr-software-implementation-fails", url: "https://www.we360.ai/blog/top-5-reasons-why-hr-software-implementation-fails-and-how-to-fix-them/" },
  { label: "features-project-task-management", url: "https://www.we360.ai/features/project-task-management/" },
];
const onlyLabels = process.argv[4] ? new Set(process.argv[4].split(",")) : null;
const urls = onlyLabels ? ALL_URLS.filter((u) => onlyLabels.has(u.label)) : ALL_URLS;

const strategies = ["mobile", "desktop"];

function num(audits, key, divideBy1000 = false) {
  const v = audits?.[key]?.numericValue;
  if (typeof v !== "number") return null;
  return divideBy1000 ? Number((v / 1000).toFixed(3)) : Math.round(v);
}

async function runOne(url, strategy) {
  const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&category=PERFORMANCE&category=SEO&category=ACCESSIBILITY&category=BEST_PRACTICES&key=${apiKey}`;
  const res = await fetch(api);
  const raw = await res.json();
  if (!res.ok) {
    return { error: raw?.error?.message ?? `HTTP ${res.status}`, raw: null, summary: null };
  }
  const lh = raw.lighthouseResult;
  const audits = lh?.audits ?? {};
  const cats = lh?.categories ?? {};
  const scorePct = (c) => (typeof cats[c]?.score === "number" ? Math.round(cats[c].score * 100) : null);

  // Every audit that isn't a clean pass (score null = informational/manual is
  // skipped; score 1 = pass is skipped) across ALL categories we requested —
  // this is the real "what can we fix" list, not just perf opportunities.
  const categoryOf = (auditId) => {
    for (const [catId, cat] of Object.entries(cats)) {
      if (cat.auditRefs?.some((r) => r.id === auditId)) return catId;
    }
    return null;
  };

  const failing_audits = Object.values(audits)
    .filter((a) => typeof a.score === "number" && a.score < 1)
    .map((a) => ({
      id: a.id,
      category: categoryOf(a.id),
      title: a.title,
      score: a.score,
      display_value: a.displayValue ?? null,
      savings_ms: a.details?.type === "opportunity" ? Math.round(a.numericValue ?? 0) : null,
      description: (a.description ?? "").replace(/\[.*?\]\(.*?\)/g, "").slice(0, 300),
    }))
    .sort((a, b) => a.score - b.score);

  const crux = raw.loadingExperience?.metrics ?? null;
  const originCrux = raw.originLoadingExperience?.metrics ?? null;
  const fieldFmt = (m) =>
    m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { category: v.category, p75: v.percentile }])) : null;

  const summary = {
    url,
    strategy,
    fetched_at: new Date().toISOString(),
    scores: {
      performance: scorePct("performance"),
      seo: scorePct("seo"),
      accessibility: scorePct("accessibility"),
      best_practices: scorePct("best-practices"),
    },
    lab_metrics: {
      lcp_s: num(audits, "largest-contentful-paint", true),
      cls: audits["cumulative-layout-shift"]?.numericValue ?? null,
      tbt_ms: num(audits, "total-blocking-time"),
      fcp_s: num(audits, "first-contentful-paint", true),
      speed_index_s: num(audits, "speed-index", true),
      ttfb_s: num(audits, "server-response-time", true),
      inp_ms: num(audits, "interaction-to-next-paint"),
    },
    field_data_url_level: fieldFmt(crux),
    field_data_origin_level: fieldFmt(originCrux),
    failing_audits_count: failing_audits.length,
    failing_audits,
    final_url: lh?.finalDisplayedUrl ?? lh?.finalUrl ?? url,
    lighthouse_version: lh?.lighthouseVersion ?? null,
  };

  return { error: null, raw, summary };
}

const summaries = [];
const rawDir = `${outDir}/pagespeed-raw`;
await fs.mkdir(rawDir, { recursive: true });

for (const { label, url } of urls) {
  for (const strategy of strategies) {
    process.stderr.write(`Testing ${label} (${strategy})...\n`);
    try {
      const { error, raw, summary } = await runOne(url, strategy);
      if (error) {
        summaries.push({ label, url, strategy, error });
        continue;
      }
      await fs.writeFile(`${rawDir}/${label}-${strategy}.json`, JSON.stringify(raw));
      summaries.push({ label, ...summary });
    } catch (e) {
      summaries.push({ label, url, strategy, error: String(e) });
    }
  }
}

const outPath = `${outDir}/pagespeed-insights.json`;
let existing = { results: [] };
try {
  existing = JSON.parse(await fs.readFile(outPath, "utf8"));
} catch {
  // no existing file yet
}
const newLabels = new Set(summaries.map((s) => `${s.label}/${s.strategy}`));
const merged = existing.results.filter((r) => !newLabels.has(`${r.label}/${r.strategy}`)).concat(summaries);

await fs.writeFile(
  outPath,
  JSON.stringify(
    {
      tool: "Google PageSpeed Insights (real API)",
      tested_environment: "production",
      run_at: new Date().toISOString(),
      raw_responses_dir: "pagespeed-raw/ (full Lighthouse JSON per page+device — screenshots, network-requests, all audits)",
      results: merged,
    },
    null,
    2
  )
);
console.log(`Saved summary -> ${outPath}`);
console.log(`Saved raw responses -> ${rawDir}/*.json`);
