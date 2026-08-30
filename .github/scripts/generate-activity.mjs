import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..");
const outputPath = path.join(repositoryRoot, "assets", "github-activity.svg");
const sourcePath = path.join(
  repositoryRoot,
  "profile-3d-contrib",
  "profile-season-animate.svg",
);

const levelNames = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

const palette = ["#E2DED4", "#BFD9D2", "#74B4A8", "#2A7F78", "#D97745"];
const monthNames = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

const escapeXml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, amount) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + amount);
  return toIsoDate(next);
}

function calculateLongestStreak(days) {
  let longest = 0;
  let current = 0;

  for (const day of days) {
    if (day.level > 0) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }

  return longest;
}

function normalizeWeeks(days) {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const startDate = days[0]?.date;
  if (!startDate) return [];

  const start = new Date(`${startDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  const finalDate = days.at(-1).date;
  const weeks = [];

  for (let weekStart = toIsoDate(start); weekStart <= finalDate; weekStart = addDays(weekStart, 7)) {
    const week = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = addDays(weekStart, weekday);
      week.push(
        byDate.get(date) ?? {
          date,
          count: 0,
          level: 0,
          outsideRange: true,
        },
      );
    }
    weeks.push(week);
  }

  return weeks.slice(-53);
}

async function fetchGitHubData() {
  const token = process.env.GITHUB_TOKEN;
  const login =
    process.env.PROFILE_LOGIN ||
    process.env.GITHUB_REPOSITORY_OWNER ||
    process.env.GITHUB_ACTOR;

  if (!token || !login) {
    throw new Error("GitHub credentials are not available; using the committed calendar.");
  }

  const query = `
    query ProfileActivity($login: String!) {
      user(login: $login) {
        pullRequests(first: 1) {
          totalCount
        }
        repositories(first: 100, ownerAffiliations: OWNER) {
          nodes {
            isFork
            primaryLanguage { name }
          }
        }
        contributionsCollection {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                contributionCount
                contributionLevel
                date
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "koul777-profile-activity",
    },
    body: JSON.stringify({ query, variables: { login } }),
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed with ${response.status}.`);
  }

  const payload = await response.json();
  if (payload.errors?.length || !payload.data?.user) {
    throw new Error(payload.errors?.[0]?.message || `GitHub user ${login} was not found.`);
  }

  const calendar = payload.data.user.contributionsCollection.contributionCalendar;
  const days = calendar.weeks
    .flatMap((week) => week.contributionDays)
    .map((day) => ({
      date: day.date,
      count: day.contributionCount,
      level: levelNames[day.contributionLevel] ?? 0,
    }));

  const publicRepositories = payload.data.user.repositories.nodes.filter((repo) => !repo.isFork);
  const languageCounts = new Map();
  for (const repository of publicRepositories) {
    const language = repository.primaryLanguage?.name;
    if (language) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
  }
  const topLanguage =
    [...languageCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ??
    "—";

  return {
    login,
    total: calendar.totalContributions,
    publicRepositories: publicRepositories.length,
    pullRequests: payload.data.user.pullRequests.totalCount,
    topLanguage,
    days,
  };
}

async function loadCommittedCalendar() {
  const source = await readFile(sourcePath, "utf8");
  const levels = [...source.matchAll(/class="cont-top-p\d+-([0-4])"/g)].map((match) =>
    Number(match[1]),
  );
  const range = source.match(/(\d{4}-\d{2}-\d{2}) \/ (\d{4}-\d{2}-\d{2})/);
  const total = Number(source.match(/>(\d+)<\/text><text[^>]*>contributions/)?.[1] ?? 0);
  const publicRepositories = Number(source.match(/Repo<title>(\d+)<\/title>/)?.[1] ?? 0);
  const pullRequests = Number(source.match(/PullReq<title>(\d+)<\/title>/)?.[1] ?? 0);
  const topLanguage = source.match(/<title>([A-Za-z][A-Za-z+#. -]+) \d+<\/title>/)?.[1] ?? "—";

  if (!range || levels.length === 0) {
    throw new Error("The committed 3D contribution calendar could not be parsed.");
  }

  const days = levels.map((level, index) => ({
    date: addDays(range[1], index),
    count: null,
    level,
  }));

  return {
    login: "koul777",
    total,
    publicRepositories,
    pullRequests,
    topLanguage,
    days,
  };
}

function renderSvg(data) {
  const days = [...data.days].sort((a, b) => a.date.localeCompare(b.date));
  const weeks = normalizeWeeks(days);
  const visibleDays = weeks.flat().filter((day) => !day.outsideRange);
  const activeDays = visibleDays.filter((day) => day.level > 0).length;
  const activeWeeks = weeks.filter((week) => week.some((day) => day.level > 0)).length;
  const longestStreak = calculateLongestStreak(visibleDays);
  const firstDate = visibleDays[0]?.date ?? "";
  const lastDate = visibleDays.at(-1)?.date ?? "";

  const gridX = 374;
  const gridY = 112;
  const cellSize = 10;
  const gap = 4;
  const step = cellSize + gap;

  const monthLabels = [];
  let previousMonth = -1;
  weeks.forEach((week, index) => {
    const firstVisibleDay = week.find((day) => !day.outsideRange);
    if (!firstVisibleDay) return;
    const month = Number(firstVisibleDay.date.slice(5, 7)) - 1;
    if (month !== previousMonth && (index === 0 || index > 1)) {
      monthLabels.push(
        `<text x="${gridX + index * step}" y="88" class="month">${monthNames[month]}</text>`,
      );
      previousMonth = month;
    }
  });

  const cells = [];
  weeks.forEach((week, weekIndex) => {
    week.forEach((day, weekday) => {
      if (day.outsideRange) return;
      const x = gridX + weekIndex * step;
      const y = gridY + weekday * step;
      const detail = day.count === null ? `activity level ${day.level}` : `${day.count} contributions`;
      cells.push(
        `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="3" fill="${palette[day.level]}"><title>${escapeXml(day.date)} · ${escapeXml(detail)}</title></rect>`,
      );
    });
  });

  const metrics = [
    [data.total.toLocaleString("en-US"), "CONTRIBUTIONS"],
    [data.publicRepositories, "PUBLIC REPOS"],
    [data.pullRequests, "PULL REQUESTS"],
    [data.topLanguage, "TOP LANGUAGE"],
  ];

  const metricCards = metrics
    .map(([value, label], index) => {
      const x = gridX + index * 190;
      return `
        <g transform="translate(${x} 264)">
          <rect width="174" height="78" rx="18" fill="#FFFDF8" stroke="#D8D1C4"/>
          <text x="18" y="34" class="metric-value">${escapeXml(value)}</text>
          <text x="18" y="58" class="metric-label">${label}</text>
        </g>`;
    })
    .join("");

  const legend = palette
    .map(
      (color, index) =>
        `<rect x="${1037 + index * 17}" y="216" width="10" height="10" rx="3" fill="${color}"/>`,
    )
    .join("");

  return `<svg width="1200" height="380" viewBox="0 0 1200 380" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(data.login)} GitHub build rhythm</title>
  <desc id="desc">A custom contribution infographic showing activity from ${escapeXml(firstDate)} to ${escapeXml(lastDate)}.</desc>
  <defs>
    <linearGradient id="paper" x1="0" y1="0" x2="1200" y2="380" gradientUnits="userSpaceOnUse">
      <stop stop-color="#FBF8F1"/>
      <stop offset="1" stop-color="#EEE8DB"/>
    </linearGradient>
    <pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1" fill="#17324D" fill-opacity="0.05"/>
    </pattern>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#5F5142" flood-opacity="0.11"/>
    </filter>
    <style>
      text { font-family: "Segoe UI", Arial, sans-serif; }
      .eyebrow { fill: #2A7F78; font-size: 13px; font-weight: 750; letter-spacing: 2.2px; }
      .headline { fill: #17324D; font-size: 34px; font-weight: 780; }
      .body { fill: #52636B; font-size: 15px; }
      .small { fill: #69777D; font-size: 11px; font-weight: 650; letter-spacing: 0.7px; }
      .month { fill: #69777D; font-size: 10px; font-weight: 700; letter-spacing: 0.8px; }
      .metric-value { fill: #17324D; font-size: 24px; font-weight: 780; }
      .metric-label { fill: #69777D; font-size: 10px; font-weight: 750; letter-spacing: 1.1px; }
    </style>
  </defs>

  <rect width="1200" height="380" rx="28" fill="url(#paper)"/>
  <rect width="1200" height="380" rx="28" fill="url(#dots)"/>
  <path d="M0 319C153 292 238 341 363 320C528 292 616 246 778 263C943 280 1060 330 1200 290V380H0V319Z" fill="#2A7F78" fill-opacity="0.05"/>

  <g transform="translate(48 44)">
    <text x="0" y="18" class="eyebrow">BUILD RHYTHM</text>
    <text x="0" y="67" class="headline">Small signals.</text>
    <text x="0" y="106" class="headline">Useful change.</text>
    <rect x="0" y="128" width="48" height="4" rx="2" fill="#D97745"/>
    <text x="0" y="166" class="body">A year of turning field questions</text>
    <text x="0" y="189" class="body">into evidence and working tools.</text>

    <g transform="translate(0 234)">
      <circle cx="6" cy="6" r="6" fill="#D97745" fill-opacity="0.24">
        <animate attributeName="r" values="5;10;5" dur="2.8s" repeatCount="indefinite"/>
        <animate attributeName="fill-opacity" values="0.32;0.05;0.32" dur="2.8s" repeatCount="indefinite"/>
      </circle>
      <circle cx="6" cy="6" r="3" fill="#D97745"/>
      <text x="20" y="10" class="small">UPDATED DAILY · SEOUL</text>
    </g>

    <text x="0" y="286" class="small">${escapeXml(firstDate)}  —  ${escapeXml(lastDate)}</text>
    <text x="0" y="309" class="small">${escapeXml(activeDays)} ACTIVE DAYS · ${escapeXml(activeWeeks)} ACTIVE WEEKS</text>
    <text x="0" y="332" class="small">${escapeXml(longestStreak)} DAY LONGEST STREAK · @${escapeXml(data.login)}</text>
  </g>

  <g filter="url(#shadow)">
    <rect x="342" y="42" width="816" height="310" rx="24" fill="#F8F4EC" stroke="#D8D1C4"/>
  </g>
  <text x="374" y="70" class="small">52-WEEK CONTRIBUTION SIGNAL</text>
  ${monthLabels.join("\n  ")}
  <text x="350" y="125" class="month">S</text>
  <text x="350" y="153" class="month">T</text>
  <text x="350" y="181" class="month">T</text>
  ${cells.join("\n  ")}
  <text x="994" y="225" class="small">QUIET</text>
  ${legend}
  <text x="1127" y="225" class="small">DEEP</text>
  ${metricCards}
</svg>
`;
}

let data;
try {
  data = await fetchGitHubData();
  console.log(`Fetched live GitHub activity for ${data.login}.`);
} catch (error) {
  console.warn(error.message);
  data = await loadCommittedCalendar();
  console.log("Generated the infographic from the committed 3D calendar.");
}

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, renderSvg(data), "utf8");
console.log(`Wrote ${path.relative(repositoryRoot, outputPath)}.`);
