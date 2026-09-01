// clone-tracker.js
//
// Fetches clone traffic for every public repo owned by GH_USERNAME,
// merges it into a persisted JSON file (so history survives GitHub's
// 14-day traffic retention window), and renders an SVG report card.
//
// Env vars required:
//   GH_USERNAME      - GitHub username to track (e.g. "SurajDias")
//   GH_TRAFFIC_TOKEN - PAT (classic, "repo" scope) — needed to read
//                       traffic/clones, which GITHUB_TOKEN can't access
//                       for repos outside the running workflow.

const fs = require('fs');
const path = require('path');

const USERNAME = process.env.GH_USERNAME;
const TOKEN = process.env.GH_TRAFFIC_TOKEN;

if (!USERNAME || !TOKEN) {
  console.error('Missing GH_USERNAME or GH_TRAFFIC_TOKEN env vars.');
  process.exit(1);
}

const DATA_PATH = path.join(__dirname, '..', 'profile', 'clone-data.json');
const SVG_PATH = path.join(__dirname, '..', 'profile', 'clone-report.svg');

const API_HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': `${USERNAME}-clone-tracker`,
};

async function githubJson(url) {
  const res = await fetch(url, { headers: API_HEADERS });
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status} for ${url}: ${await res.text()}`);
  }
  return res.json();
}

// Fetch every public, non-fork repo owned by the user (paginated).
async function fetchPublicRepos() {
  const repos = [];
  let page = 1;
  while (true) {
    const batch = await githubJson(
      `https://api.github.com/users/${USERNAME}/repos?per_page=100&page=${page}&type=owner`
    );
    if (batch.length === 0) break;
    for (const r of batch) {
      if (!r.private && !r.fork) repos.push(r.name);
    }
    if (batch.length < 100) break;
    page += 1;
  }
  return repos;
}

// Fetch the last 14 days of daily clone counts for one repo.
async function fetchRepoClones(repoName) {
  try {
    const data = await githubJson(
      `https://api.github.com/repos/${USERNAME}/${repoName}/traffic/clones?per=day`
    );
    return data.clones || [];
  } catch (err) {
    // Traffic data requires push access; skip repos we can't read (e.g.
    // if the PAT ever loses access) instead of failing the whole run.
    console.warn(`Skipping ${repoName}: ${err.message}`);
    return [];
  }
}

function loadExistingData() {
  if (fs.existsSync(DATA_PATH)) {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  }
  return { repos: {}, lastUpdated: null };
}

// Merge fresh daily counts into the persisted store, keyed by date so
// re-running never double-counts a day GitHub already reported.
function mergeCloneDays(store, repoName, days) {
  if (!store.repos[repoName]) store.repos[repoName] = { days: {} };
  for (const d of days) {
    const date = d.timestamp.slice(0, 10); // YYYY-MM-DD
    store.repos[repoName].days[date] = d.count;
  }
}

function computeStats(store) {
  const repoTotals = {};
  const dailyTotals = {}; // date -> sum across all repos

  for (const [repoName, repoData] of Object.entries(store.repos)) {
    let total = 0;
    for (const [date, count] of Object.entries(repoData.days)) {
      total += count;
      dailyTotals[date] = (dailyTotals[date] || 0) + count;
    }
    repoTotals[repoName] = total;
  }

  const overallTotal = Object.values(repoTotals).reduce((a, b) => a + b, 0);
  const reposTracked = Object.keys(store.repos).length;

  const sortedDates = Object.keys(dailyTotals).sort();
  const last14Dates = sortedDates.slice(-14);
  const last14Total = last14Dates.reduce((sum, d) => sum + dailyTotals[d], 0);
  const momentum = last14Dates.map((d) => dailyTotals[d] || 0);

  const topRepos = Object.entries(repoTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  return { overallTotal, reposTracked, last14Total, momentum, topRepos };
}

function buildSparklinePoints(momentum, width, height, padding) {
  if (momentum.length === 0) return '';
  const max = Math.max(...momentum, 1);
  const step = (width - padding * 2) / Math.max(momentum.length - 1, 1);
  return momentum
    .map((v, i) => {
      const x = padding + i * step;
      const y = height - padding - (v / max) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c]));
}

function renderSvg(stats) {
  const width = 800;
  const height = 260;
  const updatedDate = new Date().toISOString().slice(0, 10);
  const sparkPoints = buildSparklinePoints(stats.momentum, 320, 60, 6);

  const topRepoRows = stats.topRepos
    .map(([name, total], i) => {
      const y = 90 + i * 26;
      return `
        <text x="470" y="${y}" font-size="13" fill="#C9D1D9">${escapeXml(name)}</text>
        <text x="770" y="${y}" font-size="13" fill="#38BDF8" text-anchor="end" font-weight="600">${total}</text>`;
    })
    .join('');

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="${height}" rx="10" fill="#0D1117" stroke="#21262D" />
  <line x1="440" y1="24" x2="440" y2="${height - 24}" stroke="#21262D" />

  <circle cx="30" cy="34" r="4" fill="#3FB950" />
  <text x="42" y="38" font-size="12" letter-spacing="1" fill="#8B949E">ACCOUNT CLONE PULSE</text>
  <text x="230" y="38" font-size="11" fill="#3FB950">LIVE</text>

  <text x="30" y="95" font-size="46" font-weight="700" fill="#F0F6FC">${stats.overallTotal}</text>
  <text x="30" y="118" font-size="12" letter-spacing="1" fill="#A78BFA">OVERALL TRACKED CLONES</text>

  <text x="30" y="150" font-size="14" fill="#38BDF8" font-weight="600">${stats.last14Total}<tspan fill="#8B949E" font-weight="400"> clones · last 14 days</tspan></text>
  <text x="30" y="172" font-size="14" fill="#A78BFA" font-weight="600">${stats.reposTracked}<tspan fill="#8B949E" font-weight="400"> repositories tracked</tspan></text>

  <text x="470" y="38" font-size="12" letter-spacing="1" fill="#8B949E">TOP CLONED PROJECTS · TRACKED</text>
  ${topRepoRows}

  <g transform="translate(460, 150)">
    <polyline points="${sparkPoints}" fill="none" stroke="#38BDF8" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
  </g>
  <text x="470" y="228" font-size="10" letter-spacing="1" fill="#8B949E">DAILY MOMENTUM ACROSS ALL REPOS</text>
  <text x="770" y="228" font-size="10" fill="#8B949E" text-anchor="end">updated ${updatedDate}</text>
</svg>`;
}

async function main() {
  const store = loadExistingData();
  const repos = await fetchPublicRepos();

  for (const repoName of repos) {
    const days = await fetchRepoClones(repoName);
    mergeCloneDays(store, repoName, days);
  }

  store.lastUpdated = new Date().toISOString();

  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(store, null, 2));

  const stats = computeStats(store);
  fs.writeFileSync(SVG_PATH, renderSvg(stats));

  console.log(`Tracked ${stats.reposTracked} repos, ${stats.overallTotal} total clones.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
