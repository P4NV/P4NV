const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

// Configuration
const HEADERS = {
    'Authorization': `token ${process.env.ACCESS_TOKEN}`,
    'Content-Type': 'application/json'
};
const USER_NAME = 'P4NV';
const QUERY_COUNT = {
    user_getter: 0,
    follower_getter: 0,
    graph_repos_stars: 0,
    recursive_loc: 0,
    graph_commits: 0,
    loc_query: 0
};

let OWNER_ID;

// Utility Functions
function dailyReadme(birthday) {
    const now = new Date();
    const birth = new Date(birthday);

    let years = now.getFullYear() - birth.getFullYear();
    let months = now.getMonth() - birth.getMonth();
    let days = now.getDate() - birth.getDate();

    if (days < 0) {
        months--;
        const prevMonth = new Date(now.getFullYear(), now.getMonth(), 0);
        days += prevMonth.getDate();
    }

    if (months < 0) {
        years--;
        months += 12;
    }

    const cake = (months === 0 && days === 0) ? ' 🎂' : '';
    return `${years} year${formatPlural(years)}, ${months} month${formatPlural(months)}, ${days} day${formatPlural(days)}${cake}`;
}

function formatPlural(unit) {
    return unit !== 1 ? 's' : '';
}

async function simpleRequest(funcName, query, variables) {
    const response = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ query, variables })
    });

    if (response.status === 200) {
        return response;
    }

    const text = await response.text();
    throw new Error(`${funcName} failed with status ${response.status}: ${text}`);
}

async function graphCommits(startDate, endDate) {
    queryCount('graph_commits');
    const query = `
    query($start_date: DateTime!, $end_date: DateTime!, $login: String!) {
      user(login: $login) {
        contributionsCollection(from: $start_date, to: $end_date) {
          contributionCalendar {
            totalContributions
          }
        }
      }
    }`;

    const variables = { start_date: startDate, end_date: endDate, login: USER_NAME };
    const response = await simpleRequest('graphCommits', query, variables);
    const data = await response.json();
    return data.data.user.contributionsCollection.contributionCalendar.totalContributions;
}

async function graphReposStars(countType, ownerAffiliation, cursor = null) {
    queryCount('graph_repos_stars');
    const query = `
    query ($owner_affiliation: [RepositoryAffiliation], $login: String!, $cursor: String) {
      user(login: $login) {
        repositories(first: 100, after: $cursor, ownerAffiliations: $owner_affiliation) {
          totalCount
          edges {
            node {
              ... on Repository {
                nameWithOwner
                stargazers {
                  totalCount
                }
              }
            }
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    }`;

    const variables = { owner_affiliation: ownerAffiliation, login: USER_NAME, cursor };
    const response = await simpleRequest('graphReposStars', query, variables);
    const data = await response.json();

    if (countType === 'repos') {
        return data.data.user.repositories.totalCount;
    } else if (countType === 'stars') {
        return starsCounter(data.data.user.repositories.edges);
    }
}

async function recursiveLoc(owner, repoName, data, cacheComment, additionTotal = 0, deletionTotal = 0, myCommits = 0, cursor = null) {
    queryCount('recursive_loc');
    const query = `
    query ($repo_name: String!, $owner: String!, $cursor: String) {
      repository(name: $repo_name, owner: $owner) {
        defaultBranchRef {
          target {
            ... on Commit {
              history(first: 100, after: $cursor) {
                totalCount
                edges {
                  node {
                    ... on Commit {
                      committedDate
                    }
                    author {
                      user {
                        id
                      }
                    }
                    deletions
                    additions
                  }
                }
                pageInfo {
                  endCursor
                  hasNextPage
                }
              }
            }
          }
        }
      }
    }`;

    const variables = { repo_name: repoName, owner, cursor };
    const response = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ query, variables })
    });

    if (response.status === 200) {
        const result = await response.json();
        if (result.data.repository.defaultBranchRef !== null) {
            return locCounterOneRepo(owner, repoName, data, cacheComment,
                result.data.repository.defaultBranchRef.target.history,
                additionTotal, deletionTotal, myCommits);
        } else {
            return [0, 0, 0];
        }
    }

    await forceCloseFile(data, cacheComment);
    if (response.status === 403) {
        throw new Error('Too many requests! Hit anti-abuse limit!');
    }
    const text = await response.text();
    throw new Error(`recursiveLoc failed with ${response.status}: ${text}`);
}

async function locCounterOneRepo(owner, repoName, data, cacheComment, history, additionTotal, deletionTotal, myCommits) {
    for (const edge of history.edges) {
        if (edge.node.author.user && edge.node.author.user.id === OWNER_ID.id) {
            myCommits++;
            additionTotal += edge.node.additions;
            deletionTotal += edge.node.deletions;
        }
    }

    if (history.edges.length === 0 || !history.pageInfo.hasNextPage) {
        return [additionTotal, deletionTotal, myCommits];
    } else {
        return recursiveLoc(owner, repoName, data, cacheComment, additionTotal, deletionTotal, myCommits, history.pageInfo.endCursor);
    }
}

async function locQuery(ownerAffiliation, commentSize = 0, forceCache = false, cursor = null, edges = []) {
    queryCount('loc_query');
    const query = `
    query ($owner_affiliation: [RepositoryAffiliation], $login: String!, $cursor: String) {
      user(login: $login) {
        repositories(first: 60, after: $cursor, ownerAffiliations: $owner_affiliation) {
          edges {
            node {
              ... on Repository {
                nameWithOwner
                defaultBranchRef {
                  target {
                    ... on Commit {
                      history {
                        totalCount
                      }
                    }
                  }
                }
              }
            }
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    }`;

    const variables = { owner_affiliation: ownerAffiliation, login: USER_NAME, cursor };
    const response = await simpleRequest('locQuery', query, variables);
    const data = await response.json();

    if (data.data.user.repositories.pageInfo.hasNextPage) {
        edges = edges.concat(data.data.user.repositories.edges);
        return locQuery(ownerAffiliation, commentSize, forceCache,
            data.data.user.repositories.pageInfo.endCursor, edges);
    } else {
        return cacheBuilder(edges.concat(data.data.user.repositories.edges), commentSize, forceCache);
    }
}

async function cacheBuilder(edges, commentSize, forceCache) {
    let cached = true;
    const filename = path.join('cache', crypto.createHash('sha256').update(USER_NAME).digest('hex') + '.txt');

    let data = [];
    try {
        const content = await fs.readFile(filename, 'utf-8');
        const lines = content.split('\n');
        // Keep all lines including empty ones for proper indexing
        data = lines;
    } catch (err) {
        // File doesn't exist, create initial structure
        data = [];
        if (commentSize > 0) {
            for (let i = 0; i < commentSize; i++) {
                data.push('Comment line ' + (i + 1));
            }
        }
        // Add placeholder lines for each repo
        for (let i = 0; i < edges.length; i++) {
            const hash = crypto.createHash('sha256').update(edges[i].node.nameWithOwner).digest('hex');
            data.push(`${hash} 0 0 0 0`);
        }
        await fs.writeFile(filename, data.join('\n'));
    }

    // Ensure we have the right number of lines
    const expectedLines = commentSize + edges.length;
    while (data.length < expectedLines) {
        const hash = crypto.createHash('sha256').update(edges[data.length - commentSize]?.node?.nameWithOwner || 'unknown').digest('hex');
        data.push(`${hash} 0 0 0 0`);
    }

    if (data.length - commentSize !== edges.length || forceCache) {
        cached = false;
        await flushCache(edges, filename, commentSize);
        const content = await fs.readFile(filename, 'utf-8');
        data = content.split('\n');
    }

    const cacheComment = data.slice(0, commentSize);
    data = data.slice(commentSize);

    for (let index = 0; index < edges.length; index++) {
        // Ensure data[index] exists and is a string
        if (!data[index] || typeof data[index] !== 'string') {
            const hash = crypto.createHash('sha256').update(edges[index].node.nameWithOwner).digest('hex');
            data[index] = `${hash} 0 0 0 0`;
            continue;
        }

        const parts = data[index].trim().split(/\s+/); // Split by any whitespace
        const repoHash = parts[0];
        const commitCount = parts[1];

        const expectedHash = crypto.createHash('sha256').update(edges[index].node.nameWithOwner).digest('hex');

        if (repoHash === expectedHash) {
            try {
                const totalCount = edges[index].node.defaultBranchRef?.target?.history?.totalCount || 0;
                if (parseInt(commitCount) !== totalCount) {
                    const [owner, repoName] = edges[index].node.nameWithOwner.split('/');
                    const loc = await recursiveLoc(owner, repoName, data, cacheComment);
                    data[index] = `${repoHash} ${totalCount} ${loc[2]} ${loc[0]} ${loc[1]}\n`;
                }
            } catch (err) {
                data[index] = `${repoHash} 0 0 0 0\n`;
            }
        }
    }

    await fs.writeFile(filename, cacheComment.join('\n') + '\n' + data.join('\n'));

    let locAdd = 0, locDel = 0;
    for (const line of data) {
        if (!line.trim()) continue;
        const parts = line.split(' ');
        locAdd += parseInt(parts[3]) || 0;
        locDel += parseInt(parts[4]) || 0;
    }

    return [locAdd, locDel, locAdd - locDel, cached];
}

async function flushCache(edges, filename, commentSize) {
    let data = [];
    try {
        const content = await fs.readFile(filename, 'utf-8');
        const lines = content.split('\n');
        if (commentSize > 0) {
            data = lines.slice(0, commentSize);
        }
    } catch (err) {
        // File doesn't exist
    }

    let output = data.join('');
    for (const node of edges) {
        const hash = crypto.createHash('sha256').update(node.node.nameWithOwner).digest('hex');
        output += `${hash} 0 0 0 0\n`;
    }

    await fs.writeFile(filename, output);
}

async function forceCloseFile(data, cacheComment) {
    const filename = path.join('cache', crypto.createHash('sha256').update(USER_NAME).digest('hex') + '.txt');
    await fs.writeFile(filename, cacheComment.join('') + data.join(''));
    console.log('There was an error while writing to the cache file. The file,', filename, 'has had the partial data saved and closed.');
}

function starsCounter(data) {
    let totalStars = 0;
    for (const node of data) {
        totalStars += node.node.stargazers.totalCount;
    }
    return totalStars;
}

async function svgOverwrite(filename, ageData, commitData, starData, repoData, contribData, followerData, locData) {
    let svg = await fs.readFile(filename, 'utf-8');

    svg = justifyFormat(svg, 'commit_data', commitData, 22);
    svg = justifyFormat(svg, 'star_data', starData, 14);
    svg = justifyFormat(svg, 'repo_data', repoData, 6);
    svg = justifyFormat(svg, 'contrib_data', contribData);
    svg = justifyFormat(svg, 'follower_data', followerData, 10);
    svg = justifyFormat(svg, 'loc_data', locData[2], 9);
    svg = justifyFormat(svg, 'loc_add', locData[0]);
    svg = justifyFormat(svg, 'loc_del', locData[1], 7);

    await fs.writeFile(filename, svg);
}

function justifyFormat(svg, elementId, newText, length = 0) {
    if (typeof newText === 'number') {
        newText = newText.toLocaleString('en-US');
    }
    newText = String(newText);

    svg = findAndReplace(svg, elementId, newText);

    const justLen = Math.max(0, length - newText.length);
    let dotString;

    if (justLen <= 2) {
        const dotMap = { 0: '', 1: ' ', 2: '. ' };
        dotString = dotMap[justLen];
    } else {
        dotString = ' ' + '.'.repeat(justLen) + ' ';
    }

    svg = findAndReplace(svg, `${elementId}_dots`, dotString);
    return svg;
}

function findAndReplace(svg, elementId, newText) {
    const regex = new RegExp(`(<tspan[^>]*id="${elementId}"[^>]*>)[^<]*(<\/tspan>)`, 'g');
    return svg.replace(regex, `$1${newText}$2`);
}

async function commitCounter(commentSize) {
    let totalCommits = 0;
    const filename = path.join('cache', crypto.createHash('sha256').update(USER_NAME).digest('hex') + '.txt');
    const content = await fs.readFile(filename, 'utf-8');
    const lines = content.split('\n');
    const data = lines.slice(commentSize);

    for (const line of data) {
        if (!line.trim()) continue;
        const parts = line.split(' ');
        totalCommits += parseInt(parts[2]) || 0;
    }

    return totalCommits;
}

async function userGetter(username) {
    queryCount('user_getter');
    const query = `
    query($login: String!) {
      user(login: $login) {
        id
        createdAt
      }
    }`;

    const variables = { login: username };
    const response = await simpleRequest('userGetter', query, variables);
    const data = await response.json();
    return [{ id: data.data.user.id }, data.data.user.createdAt];
}

async function followerGetter(username) {
    queryCount('follower_getter');
    const query = `
    query($login: String!) {
      user(login: $login) {
        followers {
          totalCount
        }
      }
    }`;

    const response = await simpleRequest('followerGetter', query, { login: username });
    const data = await response.json();
    return data.data.user.followers.totalCount;
}

function queryCount(functId) {
    QUERY_COUNT[functId]++;
}

async function perfCounter(func, ...args) {
    const start = performance.now();
    const result = await func(...args);
    return [result, (performance.now() - start) / 1000];
}

function formatter(queryType, difference, functReturn = false, whitespace = 0) {
    const timeStr = difference > 1
        ? `${difference.toFixed(4)} s`
        : `${(difference * 1000).toFixed(4)} ms`;

    console.log(`   ${queryType.padEnd(20)}: ${timeStr.padStart(12)}`);

    if (whitespace) {
        return functReturn.toLocaleString('en-US').padEnd(whitespace);
    }
    return functReturn;
}

function calculateAge(birthdate) {
    const birth = new Date(birthdate);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    
    // Adjust if birthday hasn't occurred yet this year
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
        age--;
    }
    
    return age;
}

// Main execution
async function main() {
    console.log('Calculation times:');

    // Get user data
    const [userData, userTime] = await perfCounter(userGetter, 'P4NV');
    OWNER_ID = userData[0];
    const accDate = userData[1];
    formatter('account data', userTime);

    // Calculate age (update with P4NV's birthdate if known, or remove)
    const [ageData, ageTime] = await perfCounter(dailyReadme, '2005-03-21'); // Update birthdate
    formatter('age calculation', ageTime);

    // Get LOC
    const [totalLoc, locTime] = await perfCounter(locQuery, ['OWNER', 'COLLABORATOR', 'ORGANIZATION_MEMBER'], 7);
    formatter(totalLoc[3] ? 'LOC (cached)' : 'LOC (no cache)', locTime);

    // Get commits
    const [commitData, commitTime] = await perfCounter(commitCounter, 7);

    // Get stars
    const [starData, starTime] = await perfCounter(graphReposStars, 'stars', ['OWNER']);

    // Get repos
    const [repoData, repoTime] = await perfCounter(graphReposStars, 'repos', ['OWNER']);

    // Get contributed repos
    const [contribData, contribTime] = await perfCounter(graphReposStars, 'repos', ['OWNER', 'COLLABORATOR', 'ORGANIZATION_MEMBER']);

    // Get followers
    const [followerData, followerTime] = await perfCounter(followerGetter, 'P4NV');

    // Remove archived data section - specific to Andrew6rant
    let finalCommitData = commitData;
    let finalContribData = contribData;

    // Format LOC
    for (let i = 0; i < totalLoc.length - 1; i++) {
        totalLoc[i] = totalLoc[i].toLocaleString('en-US');
    }

    // Update SVGs
    await svgOverwrite('dark_mode.svg', ageData, finalCommitData, starData, repoData, finalContribData, followerData, totalLoc.slice(0, -1));
    await svgOverwrite('light_mode.svg', ageData, finalCommitData, starData, repoData, finalContribData, followerData, totalLoc.slice(0, -1));

    const totalTime = userTime + ageTime + locTime + commitTime + starTime + repoTime + contribTime;
    console.log(`\nTotal function time: ${totalTime.toFixed(4)} s`);
    console.log(`\nTotal GitHub GraphQL API calls: ${Object.values(QUERY_COUNT).reduce((a, b) => a + b, 0)}`);
    for (const [name, count] of Object.entries(QUERY_COUNT)) {
        console.log(`   ${name.padEnd(25)}: ${count.toString().padStart(6)}`);
    }
}

main().catch(console.error);
