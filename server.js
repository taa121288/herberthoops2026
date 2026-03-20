const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'results.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'marchmadness2026';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────
// BRACKET DATA (needed server-side for ESPN matching)
// ──────────────────────────────────────────────
const ESPN_IDS = {
  "Duke":150,"Siena":2561,"Ohio St":194,"TCU":2628,"St. John's":2599,
  "N. Iowa":2460,"Kansas":2305,"Cal Baptist":2856,"Louisville":97,"SFLA":58,
  "Michigan St":127,"N. Dakota St":2449,"UCLA":26,"UCF":2116,"UConn":41,
  "Furman":231,"Florida":57,"PVAM":2504,"Clemson":228,"Iowa":2294,
  "Vanderbilt":238,"McNeese":2377,"Nebraska":158,"Troy":2653,"N. Carolina":153,
  "VCU":2670,"Illinois":356,"Penn":219,"MARYCA":2345,"Texas A&M":245,
  "Houston":248,"Idaho":70,"Arizona":12,"LIU":112027,"Villanova":222,
  "Utah St":328,"Wisconsin":275,"High Point":2272,"Arkansas":8,"Hawaii":62,
  "BYU":252,"Texas":251,"Gonzaga":2250,"Kennesaw St":338,"Miami":2390,
  "Missouri":142,"Purdue":2509,"Queens":164809,"Michigan":130,"Howard":47,
  "Georgia":61,"Saint Louis":139,"Texas Tech":2641,"Akron":2006,"Alabama":333,
  "Hofstra":2275,"Tennessee":2633,"Miami OH":193,"Virginia":258,"Wright St":2900,
  "Kentucky":96,"Santa Clara":2541,"Iowa St":66,"Tenn. State":2634
};

// Reverse lookup: ESPN ID → team name
const ID_TO_TEAM = {};
for (const [name, id] of Object.entries(ESPN_IDS)) {
  ID_TO_TEAM[String(id)] = name;
}

// First round: [gameId, seed1, team1, seed2, team2]
const FIRST_ROUND = [
  [1,"Duke","Siena"],[2,"Ohio St","TCU"],[3,"St. John's","N. Iowa"],
  [4,"Kansas","Cal Baptist"],[5,"Louisville","SFLA"],[6,"Michigan St","N. Dakota St"],
  [7,"UCLA","UCF"],[8,"UConn","Furman"],[9,"Florida","PVAM"],
  [10,"Clemson","Iowa"],[11,"Vanderbilt","McNeese"],[12,"Nebraska","Troy"],
  [13,"N. Carolina","VCU"],[14,"Illinois","Penn"],[15,"MARYCA","Texas A&M"],
  [16,"Houston","Idaho"],[17,"Arizona","LIU"],[18,"Villanova","Utah St"],
  [19,"Wisconsin","High Point"],[20,"Arkansas","Hawaii"],[21,"BYU","Texas"],
  [22,"Gonzaga","Kennesaw St"],[23,"Miami","Missouri"],[24,"Purdue","Queens"],
  [25,"Michigan","Howard"],[26,"Georgia","Saint Louis"],[27,"Texas Tech","Akron"],
  [28,"Alabama","Hofstra"],[29,"Tennessee","Miami OH"],[30,"Virginia","Wright St"],
  [31,"Kentucky","Santa Clara"],[32,"Iowa St","Tenn. State"]
];

// Feed structure: [gameId, feeder1, feeder2]
const FEEDS = [
  [33,1,2],[34,3,4],[35,5,6],[36,7,8],[37,9,10],[38,11,12],[39,13,14],[40,15,16],
  [41,17,18],[42,19,20],[43,21,22],[44,23,24],[45,25,26],[46,27,28],[47,29,30],[48,31,32],
  [49,33,34],[50,35,36],[51,37,38],[52,39,40],[53,41,42],[54,43,44],[55,45,46],[56,47,48],
  [57,49,50],[58,51,52],[59,53,54],[60,55,56],[61,57,58],[62,59,60],[63,61,62]
];

// Build game tree for matching
const GAME_TREE = {};
FIRST_ROUND.forEach(g => { GAME_TREE[g[0]] = { type: 'first', teams: [g[1], g[2]] }; });
FEEDS.forEach(g => { GAME_TREE[g[0]] = { type: 'later', feeders: [g[1], g[2]] }; });

// ──────────────────────────────────────────────
// DATA PERSISTENCE
// ──────────────────────────────────────────────
function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { results: {}, liveGames: {}, lastFetch: null }; }
}
function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ──────────────────────────────────────────────
// ESPN SCOREBOARD FETCHER
// ──────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'HerbertHoops/1.0' } }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Get teams for a given game ID based on current results
function getGameTeams(gameId, results) {
  const node = GAME_TREE[gameId];
  if (node.type === 'first') return node.teams;
  const t1 = results[String(node.feeders[0])] || null;
  const t2 = results[String(node.feeders[1])] || null;
  return [t1, t2];
}

// Match an ESPN game to one of our 63 bracket games
function matchEspnGame(espnTeamId1, espnTeamId2, results) {
  const team1 = ID_TO_TEAM[String(espnTeamId1)];
  const team2 = ID_TO_TEAM[String(espnTeamId2)];
  if (!team1 || !team2) return null;

  for (let gid = 1; gid <= 63; gid++) {
    if (results[String(gid)]) continue; // already have result
    const teams = getGameTeams(gid, results);
    if (!teams[0] || !teams[1]) continue;
    if ((teams[0] === team1 && teams[1] === team2) ||
        (teams[0] === team2 && teams[1] === team1)) {
      return gid;
    }
  }
  return null;
}

async function fetchEspnScores() {
  const data = readData();
  const liveGames = {};
  let updated = false;

  // Tournament dates: check a range of dates around now
  // March Madness 2026 roughly March 19 - April 6
  const now = new Date();
  const dates = [];
  // Check today, yesterday, and the past 3 weeks of tournament
  for (let d = 0; d <= 21; d++) {
    const dt = new Date(now);
    dt.setDate(dt.getDate() - d);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    dates.push(`${y}${m}${day}`);
  }

  for (const dateStr of dates) {
    // Try multiple group IDs — ESPN changes the tournament group across years
    // groups=100 = NCAA Tournament, groups=50 = conference tournaments, no group = all games
    const urls = [
      `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${dateStr}&groups=100&limit=100`,
      `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${dateStr}&limit=100`
    ];
    const seen = new Set();
    for (const url of urls) {
    try {
      const json = await httpGet(url);
      if (!json.events) continue;

      for (const event of json.events) {
        const comp = event.competitions && event.competitions[0];
        if (!comp || !comp.competitors || comp.competitors.length !== 2) continue;

        const c1 = comp.competitors[0];
        const c2 = comp.competitors[1];
        const id1 = c1.team && c1.team.id;
        const id2 = c2.team && c2.team.id;
        if (!id1 || !id2) continue;

        // Skip if we already processed this matchup from another group URL
        const matchKey = [id1, id2].sort().join('-');
        if (seen.has(matchKey)) continue;
        seen.add(matchKey);

        const isComplete = comp.status && comp.status.type && comp.status.type.completed;
        const isInProgress = comp.status && comp.status.type &&
          (comp.status.type.name === 'STATUS_IN_PROGRESS' || comp.status.type.name === 'STATUS_HALFTIME' || comp.status.type.state === 'in');

        const gameId = matchEspnGame(id1, id2, data.results);
        const team1Name = ID_TO_TEAM[String(id1)];
        const team2Name = ID_TO_TEAM[String(id2)];
        if (!gameId && (team1Name || team2Name)) {
          console.log(`  ⚠️  Partial match: ${team1Name||id1} vs ${team2Name||id2} — one team ID may be wrong`);
        }

        if (gameId && isComplete) {
          // Find winner
          const winner = c1.winner ? c1 : c2.winner ? c2 : null;
          if (winner && winner.team) {
            const winnerName = ID_TO_TEAM[String(winner.team.id)];
            if (winnerName && !data.results[String(gameId)]) {
              data.results[String(gameId)] = winnerName;
              updated = true;
              console.log(`  ✅ Game ${gameId}: ${winnerName} wins`);
            }
          }
          // Store final score
          if (!data.scores) data.scores = {};
          if (!data.scores[String(gameId)]) {
            const score1 = c1.score || '0';
            const score2 = c2.score || '0';
            const name1 = ID_TO_TEAM[String(id1)] || (c1.team.abbreviation || '???');
            const name2 = ID_TO_TEAM[String(id2)] || (c2.team.abbreviation || '???');
            data.scores[String(gameId)] = { t1: name1, s1: parseInt(score1), t2: name2, s2: parseInt(score2) };
            updated = true;
          }
        } else if (gameId && isInProgress) {
          // Track live game
          const score1 = c1.score || '0';
          const score2 = c2.score || '0';
          const abbr1 = (c1.team.abbreviation || '???').toUpperCase();
          const abbr2 = (c2.team.abbreviation || '???').toUpperCase();
          const clock = comp.status.displayClock || '';
          const period = comp.status.period || '';
          const periodSuffix = period === 1 ? '1H' : period === 2 ? '2H' : 'OT';
          liveGames[String(gameId)] = {
            score: `${abbr1} ${score1} - ${abbr2} ${score2}`,
            time: `${clock} ${periodSuffix}`
          };
        }
      }
    } catch (e) {
      // Skip URLs/dates that fail — ESPN might not have data for them
    }
    } // end of urls loop
  }

  data.liveGames = liveGames;
  data.lastFetch = new Date().toISOString();
  if (updated || JSON.stringify(data.liveGames) !== JSON.stringify(readData().liveGames)) {
    writeData(data);
  }
  return data;
}

// ──────────────────────────────────────────────
// AUTO-FETCH: poll ESPN every 2 minutes
// ──────────────────────────────────────────────
let fetchInterval = null;
function startAutoFetch() {
  console.log('  📡 Auto-fetch: checking ESPN every 2 minutes');
  // Initial fetch
  fetchEspnScores().then(() => console.log('  📡 Initial ESPN fetch complete')).catch(() => {});
  // Then every 2 minutes
  fetchInterval = setInterval(() => {
    fetchEspnScores().catch(e => console.log('  ⚠️  ESPN fetch error:', e.message));
  }, 120000);
}

// ──────────────────────────────────────────────
// API ENDPOINTS
// ──────────────────────────────────────────────
app.get('/api/results', (req, res) => {
  const data = readData();
  if (!data.scores) data.scores = {};
  res.json(data);
});

// Manual result entry (admin)
app.post('/api/results', (req, res) => {
  const { password, gameId, winner } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  const data = readData();
  if (winner) data.results[String(gameId)] = winner;
  else delete data.results[String(gameId)];
  writeData(data);
  res.json({ ok: true, results: data.results });
});

// Clear all results (admin)
app.post('/api/results/bulk', (req, res) => {
  const { password, results } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  const data = readData();
  data.results = results || {};
  writeData(data);
  res.json({ ok: true, results: data.results });
});

// Force ESPN refresh (admin)
app.post('/api/refresh', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  try {
    const data = await fetchEspnScores();
    res.json({ ok: true, results: data.results, liveGames: data.liveGames });
  } catch (e) {
    res.status(500).json({ error: 'ESPN fetch failed: ' + e.message });
  }
});

// ──────────────────────────────────────────────
// START
// ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  🏀 HerbertHoops 2026 is running!');
  console.log('  ─────────────────────────────────');
  console.log(`  Open:      http://localhost:${PORT}`);
  console.log(`  Admin:     http://localhost:${PORT}/#admin`);
  console.log(`  Password:  ${ADMIN_PASSWORD}`);
  console.log('');
  startAutoFetch();
});
