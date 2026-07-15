// src/tools/atlassian.js — Jira + Confluence API helpers
import { printTool } from '../ui.js';
import readline from 'readline';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const UA = 'DevLab/1.0 (+https://github.com)';

// ── Interactive credential prompt (first use, TTY only) ─────────────────────
function promptLine(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim()); }));
}

function persistToEnv(pairs) {
  try {
    const envPath = join(process.cwd(), '.env');
    let content = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
    for (const [k, v] of Object.entries(pairs)) {
      if (!v) continue;
      const re = new RegExp(`^${k}=.*$`, 'm');
      if (re.test(content)) content = content.replace(re, `${k}=${v}`);
      else content += `${content.endsWith('\n') || content === '' ? '' : '\n'}${k}=${v}\n`;
    }
    writeFileSync(envPath, content);
    return true;
  } catch { return false; }
}

let promptedThisSession = false;

async function promptForCredentials(prefix) {
  // Only prompt on an interactive terminal, once per session
  if (!process.stdin.isTTY || promptedThisSession) return false;
  promptedThisSession = true;

  console.log(`\n🔑 ${prefix} is not configured yet — let's set it up now (saved to .env).`);
  console.log('   Get an API token at: https://id.atlassian.com/manage-profile/security/api-tokens\n');

  const baseUrl = await promptLine(`${prefix}_BASE_URL (https://your-domain.atlassian.net): `);
  if (!baseUrl) { console.log('Skipped — you can run `node index.js setup` anytime.'); return false; }
  const email = await promptLine('Email: ');
  const token = await promptLine('API token (PAT): ');
  if (!email || !token) { console.log('Skipped — incomplete credentials.'); return false; }

  process.env[`${prefix}_BASE_URL`] = baseUrl;
  process.env[`${prefix}_EMAIL`] = email;
  process.env[`${prefix}_API_TOKEN`] = token;
  // Confluence usually shares the same site + credentials
  if (prefix === 'JIRA') {
    process.env.CONFLUENCE_BASE_URL ||= baseUrl;
    process.env.ATLASSIAN_EMAIL ||= email;
    process.env.ATLASSIAN_API_TOKEN ||= token;
  }

  const saved = persistToEnv({
    [`${prefix}_BASE_URL`]: baseUrl,
    [`${prefix}_EMAIL`]: email,
    [`${prefix}_API_TOKEN`]: token,
    ...(prefix === 'JIRA' ? { CONFLUENCE_BASE_URL: baseUrl } : {}),
  });
  console.log(saved ? '✅ Saved to .env — future sessions will use these automatically.\n'
                    : '⚠️ Using for this session only (could not write .env).\n');
  return true;
}

function trimUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function getAuthHeader({ user, token }) {
  if (!user || !token) return null;
  return `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
}

function requireConfig(kind) {
  const prefix = kind === 'jira' ? 'JIRA' : 'CONFLUENCE';
  const baseUrl = process.env[`${prefix}_BASE_URL`];
  const user = process.env[`${prefix}_EMAIL`] || process.env.ATLASSIAN_EMAIL;
  const token = process.env[`${prefix}_API_TOKEN`] || process.env.ATLASSIAN_API_TOKEN;
  const auth = getAuthHeader({ user, token });

  if (!baseUrl) {
    return { error: `${prefix}_BASE_URL is not set. Add it to .env (example: https://your-domain.atlassian.net)` };
  }
  if (!auth) {
    return { error: `${prefix}_EMAIL and ${prefix}_API_TOKEN are required (or ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN)` };
  }

  return { baseUrl: trimUrl(baseUrl), auth };
}

async function requestJson(kind, path, { method = 'GET', body, query } = {}) {
  let config = requireConfig(kind);
  if (config.error) {
    // First use without credentials → ask the user interactively
    const prefix = kind === 'jira' ? 'JIRA' : 'CONFLUENCE';
    const configured = await promptForCredentials(prefix);
    config = configured ? requireConfig(kind) : config;
    if (config.error) return { error: config.error + ' — run `node index.js setup` to configure interactively.' };
  }

  const url = new URL(`${config.baseUrl}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
  }

  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: config.auth,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });

  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!resp.ok) {
    return { error: data?.errorMessages?.join(', ') || data?.message || `HTTP ${resp.status}`, status: resp.status, details: data };
  }
  return data;
}

function compactIssue(issue) {
  return {
    key: issue.key,
    summary: issue.fields?.summary,
    status: issue.fields?.status?.name,
    priority: issue.fields?.priority?.name,
    assignee: issue.fields?.assignee?.displayName || null,
    reporter: issue.fields?.reporter?.displayName || null,
    project: issue.fields?.project?.key,
    updated: issue.fields?.updated,
    url: issue.self,
  };
}

function compactPage(page) {
  return {
    id: page.id,
    title: page.title,
    type: page.type,
    status: page.status,
    version: page.version?.number,
    space: page.space?.key || page.space?.name,
    url: page._links?.webui ? `${page._links?.base || ''}${page._links.webui}` : null,
  };
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToText).join('');
  if (node.type === 'text') return node.text || '';
  const children = (node.content || []).map(adfToText).join('');
  switch (node.type) {
    case 'paragraph':
      return `${children}\n`;
    case 'heading':
      return `\n${children}\n`;
    case 'bulletList':
    case 'orderedList':
      return `\n${children}\n`;
    case 'listItem':
      return `- ${children.replace(/\n+/g, ' ').trim()}\n`;
    case 'blockquote':
      return `> ${children.replace(/\n+/g, ' ').trim()}\n`;
    default:
      return children;
  }
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTaskBreakdown(text) {
  const lines = normalizeText(text).split('\n').map(line => line.trim()).filter(Boolean);
  const bullets = lines
    .filter(line => /^([-*•]|\d+[.)])\s+/.test(line))
    .map(line => line.replace(/^([-*•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);

  if (bullets.length > 0) return bullets.slice(0, 10);

  const sections = [];
  const sectionMarkers = ['acceptance criteria', 'requirements', 'scope', 'definition of done'];
  for (const marker of sectionMarkers) {
    const idx = lines.findIndex(line => line.toLowerCase().includes(marker));
    if (idx >= 0) {
      for (let i = idx + 1; i < Math.min(lines.length, idx + 8); i++) {
        const line = lines[i];
        if (/^[A-Z][A-Za-z0-9 _-]+:/.test(line)) break;
        if (line) sections.push(line.replace(/^([-*•]|\d+[.)])\s+/, '').trim());
      }
      if (sections.length > 0) break;
    }
  }

  return sections.filter(Boolean).slice(0, 8);
}

function buildTaskBreakdown(issue) {
  const detailText = normalizeText(adfToText(issue.description));
  const extracted = extractTaskBreakdown(detailText);
  if (extracted.length > 0) return extracted;

  return [
    'Review the ticket and confirm acceptance criteria',
    'Identify impacted modules, interfaces, and data flow',
    'Implement the code change with the smallest safe surface area',
    'Add or update tests for the new behavior',
    'Update documentation or Confluence notes for the change',
  ];
}

function buildTechnicalDesign({ issue, tasks, notes = [] }) {
  const title = issue.summary || 'Feature';
  const description = normalizeText(adfToText(issue.description));
  const keywords = [
    ...(issue.labels || []),
    ...String(title).split(/\s+/).filter(Boolean),
    ...description.split(/\s+/).slice(0, 12),
  ].slice(0, 16);

  const scope = tasks.length > 0 ? tasks.slice(0, 5) : ['Implement the Jira requirement', 'Add validation and tests'];

  return {
    goal: `Deliver ${title}`,
    context: description || 'No Jira description was provided, so the design is based on the ticket summary.',
    assumptions: [
      'Existing architecture should be preserved unless the ticket requires a change.',
      'The solution should be backwards compatible by default.',
      'Tests must cover the new behavior and the main failure path.',
    ],
    approach: [
      `Use the existing module boundaries and extend the smallest set of files possible.`,
      `Key implementation keywords inferred from the ticket: ${keywords.filter(Boolean).slice(0, 8).join(', ') || 'none'}.`,
      `Break the work into: ${scope.join(' → ')}.`,
    ],
    components: [
      'Product/UI layer or API entry point',
      'Business logic / domain service',
      'Data access / integration layer if required',
      'Test coverage for the happy path and failure cases',
    ],
    dataFlow: [
      'Receive the request from the existing entry point.',
      'Validate inputs and map them into a domain-level request.',
      'Execute the core business logic with injected dependencies.',
      'Persist or return the result, then surface errors clearly.',
    ],
    testing: [
      'Unit tests for the new business rules',
      'Integration tests for API or repository boundaries if touched',
      'Regression coverage for the ticket’s original failure mode',
    ],
    risks: [
      'Hidden coupling to existing modules',
      'Breaking backward compatibility',
      'Insufficient test coverage around edge cases',
    ],
    openQuestions: notes.length > 0 ? notes : ['Confirm any missing acceptance criteria with the ticket owner.'],
  };
}

function buildConfluenceStorage({ issue, tasks, notes = [] }) {
  const description = normalizeText(adfToText(issue.description));
  const taskItems = tasks.map(task => `<li>${htmlEscape(task)}</li>`).join('');
  const noteItems = notes.map(note => `<li>${htmlEscape(note)}</li>`).join('');
  const tech = buildTechnicalDesign({ issue, tasks, notes });

  const list = (items) => `<ul>${items.map(item => `<li>${htmlEscape(item)}</li>`).join('')}</ul>`;

  return `
<h1>${htmlEscape(issue.key)} — ${htmlEscape(issue.summary || 'Development brief')}</h1>
<p><strong>Jira:</strong> <a href="${htmlEscape(issue.url || '')}">${htmlEscape(issue.key)}</a></p>
<h2>Overview</h2>
<p>${htmlEscape(description || 'No description provided.')}</p>
<h2>Task Breakdown</h2>
<ul>${taskItems}</ul>
<h2>Technical Design</h2>
<h3>Goal</h3>
<p>${htmlEscape(tech.goal)}</p>
<h3>Context</h3>
<p>${htmlEscape(tech.context)}</p>
<h3>Assumptions</h3>
${list(tech.assumptions)}
<h3>Approach</h3>
${list(tech.approach)}
<h3>Components</h3>
${list(tech.components)}
<h3>Data Flow</h3>
${list(tech.dataFlow)}
<h3>Testing</h3>
${list(tech.testing)}
<h3>Risks</h3>
${list(tech.risks)}
<h3>Open Questions</h3>
${list(tech.openQuestions)}
${noteItems ? `<h2>Notes</h2><ul>${noteItems}</ul>` : ''}
<h2>Implementation Notes</h2>
<ul>
  <li>Keep changes aligned with the existing architecture.</li>
  <li>Prefer small, reviewable commits.</li>
  <li>Verify the change with tests before merging.</li>
</ul>`.trim();
}

// ── Jira ───────────────────────────────────────────────────────────────────────

export async function searchJiraIssues(jql, { maxResults = 10 } = {}) {
  printTool(`Jira search: ${jql}`);
  const data = await requestJson('jira', '/rest/api/3/search', {
    query: { jql, maxResults: String(maxResults), fields: 'summary,status,priority,assignee,reporter,project,updated' },
  });
  if (data?.error) return data;
  return {
    jql,
    total: data.total || 0,
    issues: (data.issues || []).map(compactIssue),
  };
}

export async function getJiraIssue(issueKey) {
  printTool(`Jira issue: ${issueKey}`);
  const data = await requestJson('jira', `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
    query: { fields: 'summary,description,status,priority,assignee,reporter,project,labels,created,updated' },
  });
  if (data?.error) return data;
  return {
    key: data.key,
    summary: data.fields?.summary,
    description: data.fields?.description,
    status: data.fields?.status?.name,
    priority: data.fields?.priority?.name,
    assignee: data.fields?.assignee?.displayName || null,
    reporter: data.fields?.reporter?.displayName || null,
    project: data.fields?.project?.key,
    labels: data.fields?.labels || [],
    created: data.fields?.created,
    updated: data.fields?.updated,
    url: data.self,
    raw: data,
  };
}

export async function createJiraIssue({ projectKey, issueType, summary, description, priority, labels }) {
  printTool(`Jira create issue: ${projectKey} / ${summary}`);
  const payload = {
    fields: {
      project: { key: projectKey },
      summary,
      issuetype: { name: issueType },
    },
  };
  if (description) payload.fields.description = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }] };
  if (priority) payload.fields.priority = { name: priority };
  if (labels) payload.fields.labels = labels.split(',').map(s => s.trim()).filter(Boolean);

  return requestJson('jira', '/rest/api/3/issue', { method: 'POST', body: payload });
}

export async function addJiraComment(issueKey, comment) {
  printTool(`Jira comment: ${issueKey}`);
  return requestJson('jira', `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
    method: 'POST',
    body: { body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }] } },
  });
}

export async function getJiraTransitions(issueKey) {
  printTool(`Jira transitions: ${issueKey}`);
  const data = await requestJson('jira', `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`);
  if (data?.error) return data;
  return { issueKey, transitions: (data.transitions || []).map(t => ({ id: t.id, name: t.name, to: t.to?.name })) };
}

export async function transitionJiraIssue(issueKey, transitionId) {
  printTool(`Jira transition: ${issueKey} -> ${transitionId}`);
  return requestJson('jira', `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
    method: 'POST',
    body: { transition: { id: transitionId } },
  });
}

// ── Confluence ────────────────────────────────────────────────────────────────

export async function searchConfluencePages(cql, { limit = 10 } = {}) {
  printTool(`Confluence search: ${cql}`);
  const data = await requestJson('confluence', '/wiki/rest/api/content/search', {
    query: { cql, limit: String(limit), expand: 'version,space' },
  });
  if (data?.error) return data;
  return {
    cql,
    size: data.size || 0,
    results: (data.results || []).map(compactPage),
  };
}

export async function getConfluencePage(pageId) {
  printTool(`Confluence page: ${pageId}`);
  const data = await requestJson('confluence', `/wiki/rest/api/content/${encodeURIComponent(pageId)}`, {
    query: { expand: 'body.storage,version,space,_links' },
  });
  if (data?.error) return data;
  return {
    ...compactPage(data),
    body: data.body?.storage?.value,
    raw: data,
  };
}

export async function createConfluencePage({ spaceKey, title, body, parentPageId }) {
  printTool(`Confluence create page: ${title}`);
  const payload = {
    type: 'page',
    title,
    space: { key: spaceKey },
    body: { storage: { value: body, representation: 'storage' } },
  };
  if (parentPageId) payload.ancestors = [{ id: String(parentPageId) }];
  return requestJson('confluence', '/wiki/rest/api/content', { method: 'POST', body: payload });
}

export async function updateConfluencePage({ pageId, title, body, currentVersion }) {
  printTool(`Confluence update page: ${pageId}`);
  const payload = {
    id: String(pageId),
    type: 'page',
    title,
    version: { number: Number(currentVersion) + 1 },
    body: { storage: { value: body, representation: 'storage' } },
  };
  return requestJson('confluence', `/wiki/rest/api/content/${encodeURIComponent(pageId)}`, { method: 'PUT', body: payload });
}

export async function getConfluenceChildPages(pageId, { limit = 25 } = {}) {
  printTool(`Confluence child pages: ${pageId}`);
  const data = await requestJson('confluence', `/wiki/rest/api/content/${encodeURIComponent(pageId)}/child/page`, {
    query: { limit: String(limit), expand: 'version,space' },
  });
  if (data?.error) return data;
  return {
    pageId,
    results: (data.results || []).map(compactPage),
  };
}

export async function getRecentConfluencePages() {
  printTool('Confluence recent pages');
  const data = await requestJson('confluence', '/wiki/rest/api/content/search', {
    query: { cql: 'type = page ORDER BY lastmodified DESC', limit: '10', expand: 'version,space' },
  });
  if (data?.error) return data;
  return { results: (data.results || []).map(compactPage) };
}

export async function developFromJira(issueKey, { spaceKey, parentPageId, pageTitle, createPage = true, commentJira = true } = {}) {
  printTool(`Jira dev brief: ${issueKey}`);
  const issue = await getJiraIssue(issueKey);
  if (issue?.error) return issue;

  const tasks = buildTaskBreakdown(issue);
  const notes = [
    `Summary: ${issue.summary || 'n/a'}`,
    `Status: ${issue.status || 'n/a'}`,
    `Priority: ${issue.priority || 'n/a'}`,
    ...(issue.labels?.length ? [`Labels: ${issue.labels.join(', ')}`] : []),
  ];

  let page = null;
  if (createPage) {
    if (!spaceKey) return { error: 'spaceKey is required when createPage is enabled' };
    const title = pageTitle || `${issue.key} — Development brief`;
    const body = buildConfluenceStorage({ issue, tasks, notes });
    page = await createConfluencePage({ spaceKey, title, body, parentPageId });
    if (page?.error) return page;

    if (commentJira) {
      const pageLink = page?._links?.webui ? `${trimUrl(process.env.CONFLUENCE_BASE_URL || '')}${page._links.webui}` : `Confluence page ${page?.id || ''}`;
      await addJiraComment(issue.key, `Development brief created in Confluence: ${pageLink}`);
    }
  }

  return {
    issue: {
      key: issue.key,
      summary: issue.summary,
      status: issue.status,
      priority: issue.priority,
      assignee: issue.assignee,
      labels: issue.labels,
      created: issue.created,
      updated: issue.updated,
      url: issue.url,
    },
    tasks,
    notes,
    page,
  };
}
