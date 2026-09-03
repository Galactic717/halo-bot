import type { McpServerSpec } from './mcp.ts';
import type { PluginCategory } from './plugins.ts';

export type { PluginCategory };

const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

/** A published npm server, launched through npx. */
function npm(pkg: string, ...extra: string[]): Pick<McpServerSpec, 'command' | 'args' | 'source'> {
  return { command: NPX, args: ['-y', pkg, ...extra], source: `https://www.npmjs.com/package/${pkg}` };
}

/**
 * A hosted server bridged to stdio by mcp-remote. Signing in happens in a browser window the
 * bridge opens itself, so these need no key pasted into Halo.
 */
function remote(url: string, source: string): Pick<McpServerSpec, 'command' | 'args' | 'source' | 'remote'> {
  return { command: NPX, args: ['-y', 'mcp-remote', url], source, remote: true };
}

/**
 * Every entry is a real, published MCP server: an npm package that exists on the registry, or a
 * documented hosted endpoint. Nothing here is a placeholder.
 */
export const MCP_CATALOG: McpServerSpec[] = [
  // ---------------------------------------------------------------- Agent Orchestration
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Structured step-by-step reasoning for problems that need to be broken down before they are solved.',
    category: 'Agent Orchestration',
    icon: 'modelcontextprotocol',
    ...npm('@modelcontextprotocol/server-sequential-thinking'),
  },
  {
    id: 'memory',
    name: 'Knowledge Graph',
    description: 'A persistent knowledge graph the bots write facts and relations into, and query later.',
    category: 'Agent Orchestration',
    icon: 'modelcontextprotocol',
    ...npm('@modelcontextprotocol/server-memory'),
  },
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Drive a full browser through the accessibility tree — clicks, forms and assertions without pixels.',
    category: 'Agent Orchestration',
    featured: true,
    ...npm('@playwright/mcp@latest'),
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    description: 'Headless Chrome automation: navigate, screenshot, fill forms and run scripts on a page.',
    category: 'Agent Orchestration',
    icon: 'puppeteer',
    ...npm('@modelcontextprotocol/server-puppeteer'),
  },
  {
    id: 'browserbase',
    name: 'Browserbase',
    description: 'Cloud browsers for agents: run sessions remotely, keep them alive, and watch the replay.',
    category: 'Agent Orchestration',
    requires: [
      { key: 'BROWSERBASE_API_KEY', label: 'Browserbase API key' },
      { key: 'BROWSERBASE_PROJECT_ID', label: 'Browserbase project id' },
    ],
    ...npm('@browserbasehq/mcp'),
  },
  {
    id: 'browser-tools',
    name: 'Browser Tools',
    description: 'Read console logs, network traffic and the DOM of a page you have open in Chrome.',
    category: 'Agent Orchestration',
    icon: 'googlechrome',
    ...npm('@agentdeskai/browser-tools-mcp@latest'),
  },
  {
    id: 'desktop-commander',
    name: 'Desktop Commander',
    description: 'Terminal, file edits and process control on this machine, with diff-based editing.',
    category: 'Agent Orchestration',
    ...npm('@wonderwhy-er/desktop-commander'),
  },

  // ---------------------------------------------------------------- Automation
  {
    id: 'n8n',
    name: 'n8n',
    description:
      'Build, validate and run n8n workflows from a chat: 500+ node schemas to write against, and the ' +
      'management API to create, update and execute the workflows on your own instance.',
    category: 'Automation',
    icon: 'n8n',
    featured: true,
    /*
     * Both optional, because n8n-mcp is two servers in one: without them it still serves the node
     * documentation and the workflow validator, which is the half a bot needs to *write* a workflow.
     * Demanding a key before it will start would block the useful half behind the risky one.
     */
    requires: [
      {
        key: 'N8N_API_URL',
        label: 'Your n8n address',
        optional: true,
        hint: 'The instance a bot should manage, e.g. http://localhost:5678.',
        placeholder: 'http://localhost:5678',
      },
      {
        key: 'N8N_API_KEY',
        label: 'n8n API key',
        optional: true,
        hint: 'n8n → Settings → n8n API → Create an API key. Only needed to create, update and run workflows.',
      },
    ],
    ...npm('n8n-mcp'),
  },

  // ---------------------------------------------------------------- Canvas
  {
    id: 'mermaid',
    name: 'Mermaid Diagrams',
    description: 'Turn a description into a rendered flowchart, sequence or state diagram.',
    category: 'Canvas',
    icon: 'mermaid',
    ...npm('mcp-mermaid'),
  },
  {
    id: 'antv-chart',
    name: 'Chart Renderer',
    description: 'Render 25 kinds of chart from data — line, bar, pie, sankey, treemap and more.',
    category: 'Canvas',
    icon: 'antdesign',
    ...npm('@antv/mcp-server-chart'),
  },
  {
    id: 'everart',
    name: 'EverArt',
    description: 'Generate images from a prompt with several models, straight into the conversation.',
    category: 'Canvas',
    requires: [{ key: 'EVERART_API_KEY', label: 'EverArt API key' }],
    ...npm('@modelcontextprotocol/server-everart'),
  },

  // ---------------------------------------------------------------- Customer Support
  {
    id: 'intercom',
    name: 'Intercom',
    description: 'Search conversations, contacts and Help Center articles in your Intercom workspace.',
    category: 'Customer Support',
    icon: 'intercom',
    ...remote('https://mcp.intercom.com/mcp', 'https://developers.intercom.com/docs/guides/mcp'),
  },
  {
    id: 'twilio',
    name: 'Twilio',
    description: 'Send and read SMS, manage numbers, and work with your Twilio account.',
    category: 'Customer Support',
    requires: [
      { key: 'TWILIO_ACCOUNT_SID', label: 'Twilio account SID' },
      { key: 'TWILIO_API_KEY', label: 'Twilio API key' },
      { key: 'TWILIO_API_SECRET', label: 'Twilio API secret' },
    ],
    ...npm('@twilio-alpha/mcp'),
  },

  // ---------------------------------------------------------------- Data Analytics
  {
    id: 'posthog',
    name: 'PostHog',
    description: 'Query product analytics, feature flags, session replays and error tracking.',
    category: 'Data Analytics',
    icon: 'posthog',
    requires: [{ key: 'POSTHOG_AUTH_HEADER', label: 'PostHog personal API key', hint: 'Sent as the Authorization header' }],
    ...npm('@posthog/mcp'),
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Read-only SQL against a Postgres database, with the schema inspected for you.',
    category: 'Data Analytics',
    icon: 'postgresql',
    setup: [{ key: 'connection', label: 'Connection string', placeholder: 'postgresql://user:pass@localhost/db' }],
    ...npm('@modelcontextprotocol/server-postgres'),
  },
  {
    id: 'mysql',
    name: 'MySQL',
    description: 'Query and inspect a MySQL database, with configurable read and write permissions.',
    category: 'Data Analytics',
    icon: 'mysql',
    requires: [
      { key: 'MYSQL_HOST', label: 'Host', hint: 'e.g. 127.0.0.1' },
      { key: 'MYSQL_USER', label: 'User' },
      { key: 'MYSQL_PASS', label: 'Password' },
      { key: 'MYSQL_DB', label: 'Database' },
    ],
    ...npm('@benborla29/mcp-server-mysql'),
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query and edit a local SQLite database file, including schema changes.',
    category: 'Data Analytics',
    icon: 'sqlite',
    setup: [{ key: 'database', label: 'Database file', placeholder: 'C:\\data\\app.db' }],
    ...npm('mcp-server-sqlite-npx'),
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    description: 'Explore collections, run aggregations and manage indexes on a MongoDB deployment.',
    category: 'Data Analytics',
    icon: 'mongodb',
    requires: [{ key: 'MDB_MCP_CONNECTION_STRING', label: 'Connection string', hint: 'mongodb+srv://…' }],
    ...npm('mongodb-mcp-server'),
  },
  {
    id: 'redis',
    name: 'Redis',
    description: 'Read and write keys, inspect types and run commands against a Redis instance.',
    category: 'Data Analytics',
    icon: 'redis',
    setup: [{ key: 'url', label: 'Redis URL', placeholder: 'redis://localhost:6379' }],
    ...npm('@modelcontextprotocol/server-redis'),
  },
  {
    id: 'elasticsearch',
    name: 'Elasticsearch',
    description: 'Search indices, inspect mappings and run ES|QL against an Elasticsearch cluster.',
    category: 'Data Analytics',
    icon: 'elasticsearch',
    requires: [
      { key: 'ES_URL', label: 'Cluster URL' },
      { key: 'ES_API_KEY', label: 'API key' },
    ],
    ...npm('@elastic/mcp-server-elasticsearch'),
  },
  {
    id: 'supabase',
    name: 'Supabase',
    description: 'Manage projects, run SQL, inspect tables and generate types on Supabase.',
    category: 'Data Analytics',
    icon: 'supabase',
    requires: [{ key: 'SUPABASE_ACCESS_TOKEN', label: 'Supabase personal access token' }],
    ...npm('@supabase/mcp-server-supabase@latest'),
  },
  {
    id: 'neon',
    name: 'Neon',
    description: 'Create branches, run queries and manage serverless Postgres projects on Neon.',
    category: 'Data Analytics',
    icon: 'postgresql',
    ...remote('https://mcp.neon.tech/mcp', 'https://neon.com/docs/ai/neon-mcp-server'),
  },
  {
    id: 'aws-kb',
    name: 'AWS Knowledge Base',
    description: 'Retrieve answers from an Amazon Bedrock knowledge base with source passages.',
    category: 'Data Analytics',
    requires: [
      { key: 'AWS_ACCESS_KEY_ID', label: 'AWS access key id' },
      { key: 'AWS_SECRET_ACCESS_KEY', label: 'AWS secret access key' },
      { key: 'AWS_REGION', label: 'AWS region', hint: 'e.g. us-east-1' },
    ],
    ...npm('@modelcontextprotocol/server-aws-kb-retrieval'),
  },

  // ---------------------------------------------------------------- Design
  {
    id: 'figma',
    name: 'Figma',
    description: 'Pull layout, styles and component structure out of a Figma file so a build matches the design.',
    category: 'Design',
    icon: 'figma',
    requires: [{ key: 'FIGMA_API_KEY', label: 'Figma personal access token' }],
    ...npm('figma-developer-mcp', '--stdio'),
  },
  {
    id: 'shadcn-ui',
    name: 'shadcn/ui',
    description: 'Browse the component registry and pull real source for shadcn/ui blocks and components.',
    category: 'Design',
    icon: 'shadcnui',
    ...npm('@jpisnice/shadcn-ui-mcp-server'),
  },
  {
    id: 'magic',
    name: 'Magic',
    description: 'Generate polished UI components from a description, in your own stack.',
    category: 'Design',
    requires: [{ key: 'API_KEY', label: '21st.dev API key' }],
    ...npm('@21st-dev/magic@latest'),
  },
  {
    id: 'canva',
    name: 'Canva',
    description: 'Search designs, create and export them, and work with your Canva brand assets.',
    category: 'Design',
    ...remote('https://mcp.canva.com/mcp', 'https://www.canva.dev/docs/apps/mcp-server/'),
  },

  // ---------------------------------------------------------------- Finance And Legal
  {
    id: 'excel',
    name: 'Excel',
    description: 'Read and write .xlsx workbooks — sheets, formulas, ranges and formatting.',
    category: 'Finance And Legal',
    ...npm('@negokaz/excel-mcp-server'),
  },

  // ---------------------------------------------------------------- Inbox And Collaboration
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Search, read, draft and manage email, with attachments and labels.',
    category: 'Inbox And Collaboration',
    icon: 'gmail',
    ...npm('@gongrzhe/server-gmail-autoauth-mcp'),
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Read channels, post messages and pull history from a Slack workspace.',
    category: 'Inbox And Collaboration',
    featured: true,
    requires: [
      { key: 'SLACK_BOT_TOKEN', label: 'Slack bot token', hint: 'Starts with xoxb-' },
      { key: 'SLACK_TEAM_ID', label: 'Slack team id', hint: 'Starts with T' },
    ],
    ...npm('@modelcontextprotocol/server-slack'),
  },
  {
    id: 'discord',
    name: 'Discord',
    description: 'Read and send messages, manage channels and work with a Discord server.',
    category: 'Inbox And Collaboration',
    icon: 'discord',
    requires: [{ key: 'DISCORD_TOKEN', label: 'Discord bot token' }],
    ...npm('mcp-discord'),
  },

  // ---------------------------------------------------------------- Infrastructure
  {
    id: 'github',
    name: 'GitHub',
    description: 'Issues, pull requests, code search and file contents across your repositories.',
    category: 'Infrastructure',
    icon: 'github',
    featured: true,
    requires: [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub personal access token' }],
    ...npm('@modelcontextprotocol/server-github'),
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    description: 'Projects, merge requests, issues and files on GitLab.com or a self-hosted instance.',
    category: 'Infrastructure',
    icon: 'gitlab',
    requires: [{ key: 'GITLAB_PERSONAL_ACCESS_TOKEN', label: 'GitLab personal access token' }],
    ...npm('@modelcontextprotocol/server-gitlab'),
  },
  {
    id: 'git',
    name: 'Git',
    description: 'History, diffs, blame, branches and commits in local repositories.',
    category: 'Infrastructure',
    icon: 'git',
    ...npm('@cyanheads/git-mcp-server'),
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Pull issues, stack traces and release health out of Sentry, and triage them.',
    category: 'Infrastructure',
    icon: 'sentry',
    ...remote('https://mcp.sentry.dev/mcp', 'https://docs.sentry.io/product/sentry-mcp/'),
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    description: 'Workers, KV, R2, D1 and DNS on your Cloudflare account.',
    category: 'Infrastructure',
    icon: 'cloudflare',
    ...npm('@cloudflare/mcp-server-cloudflare', 'init'),
  },
  {
    id: 'vercel',
    name: 'Vercel',
    description: 'Deployments, projects, logs and environment variables on Vercel.',
    category: 'Infrastructure',
    icon: 'vercel',
    ...remote('https://mcp.vercel.com', 'https://vercel.com/docs/mcp/vercel-mcp'),
  },
  {
    id: 'netlify',
    name: 'Netlify',
    description: 'Create sites, deploy, and manage environment variables and functions on Netlify.',
    category: 'Infrastructure',
    icon: 'netlify',
    ...npm('@netlify/mcp'),
  },
  {
    id: 'heroku',
    name: 'Heroku',
    description: 'Apps, dynos, add-ons, config vars and logs on the Heroku platform.',
    category: 'Infrastructure',
    requires: [{ key: 'HEROKU_API_KEY', label: 'Heroku API key' }],
    ...npm('@heroku/mcp-server'),
  },
  {
    id: 'kubernetes',
    name: 'Kubernetes',
    description: 'Inspect and operate a cluster: pods, deployments, logs, events and Helm releases.',
    category: 'Infrastructure',
    icon: 'kubernetes',
    ...npm('mcp-server-kubernetes'),
  },
  {
    id: 'e2b',
    name: 'E2B',
    description: 'Run code in a disposable cloud sandbox and get the output back.',
    category: 'Infrastructure',
    requires: [{ key: 'E2B_API_KEY', label: 'E2B API key' }],
    ...npm('@e2b/mcp-server'),
  },

  // ---------------------------------------------------------------- MCP
  {
    id: 'remote-server',
    name: 'Remote Server',
    description: 'Bridge any hosted MCP server into Halo. Paste its URL; sign-in opens in a browser.',
    category: 'MCP',
    icon: 'modelcontextprotocol',
    setup: [{ key: 'url', label: 'Server URL', placeholder: 'https://mcp.example.com/mcp' }],
    ...npm('mcp-remote'),
  },
  {
    id: 'everything',
    name: 'Everything',
    description: 'The reference server: every prompt, resource and tool type, for testing a client.',
    category: 'MCP',
    icon: 'modelcontextprotocol',
    ...npm('@modelcontextprotocol/server-everything'),
  },
  {
    id: 'inspector',
    name: 'Inspector',
    description: 'The official debugger for MCP servers — inspect tools, prompts and raw traffic.',
    category: 'MCP',
    icon: 'modelcontextprotocol',
    ...npm('@modelcontextprotocol/inspector'),
  },
  {
    id: 'smithery',
    name: 'Smithery',
    description: 'Search and run servers from the Smithery registry without wiring each one by hand.',
    category: 'MCP',
    ...npm('@smithery/cli', 'run'),
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read, write and search files in folders you choose, with the roots enforced.',
    category: 'MCP',
    featured: true,
    setup: [{ key: 'root', label: 'Folder the server may use', placeholder: 'C:\Users\you\Documents' }],
    ...npm('@modelcontextprotocol/server-filesystem'),
  },

  // ---------------------------------------------------------------- Payments
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Customers, payments, subscriptions, invoices and refunds on your Stripe account.',
    category: 'Payments',
    icon: 'stripe',
    requires: [{ key: 'STRIPE_SECRET_KEY', label: 'Stripe secret key', hint: 'Starts with sk_' }],
    ...npm('@stripe/mcp', '--tools=all'),
  },
  {
    id: 'paypal',
    name: 'PayPal',
    description: 'Invoices, orders, subscriptions, disputes and transaction reporting on PayPal.',
    category: 'Payments',
    icon: 'paypal',
    ...remote('https://mcp.paypal.com/mcp', 'https://www.paypal.ai/docs/tools/mcp-quickstart'),
  },
  {
    id: 'square',
    name: 'Square',
    description: 'Payments, catalog, orders, customers and inventory in a Square account.',
    category: 'Payments',
    icon: 'square',
    ...remote('https://mcp.squareup.com/sse', 'https://developer.squareup.com/docs/mcp'),
  },

  // ---------------------------------------------------------------- Productivity
  {
    id: 'google-classroom',
    name: 'Google Classroom',
    description:
      'Courses, coursework, announcements, rosters and submissions — so a bot can chase a deadline or ' +
      'draft an assignment where the class actually is.',
    category: 'Productivity',
    icon: 'googleclassroom',
    ...npm('gogcli-mcp-classroom'),
    source: 'https://github.com/chrischall/gogcli-mcp',
  },

  {
    id: 'notion',
    name: 'Notion',
    description: 'Search, read and update Notion pages and databases.',
    category: 'Productivity',
    icon: 'notion',
    featured: true,
    requires: [{ key: 'NOTION_TOKEN', label: 'Notion integration token', hint: 'Starts with ntn_' }],
    ...npm('@notionhq/notion-mcp-server'),
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    description: 'Read and search a local Obsidian vault, following links between notes.',
    category: 'Productivity',
    icon: 'obsidian',
    setup: [{ key: 'vault', label: 'Vault folder', placeholder: 'D:\\Obsidian V' }],
    ...npm('mcp-obsidian'),
  },
  {
    id: 'todoist',
    name: 'Todoist',
    description: 'Create, complete and reschedule tasks with natural-language dates.',
    category: 'Productivity',
    icon: 'todoist',
    requires: [{ key: 'TODOIST_API_TOKEN', label: 'Todoist API token' }],
    ...npm('@abhiz123/todoist-mcp-server'),
  },
  {
    id: 'clickup',
    name: 'ClickUp',
    description: 'Tasks, lists, docs and time tracking in a ClickUp workspace.',
    category: 'Productivity',
    icon: 'clickup',
    requires: [
      { key: 'CLICKUP_API_KEY', label: 'ClickUp API key' },
      { key: 'CLICKUP_TEAM_ID', label: 'ClickUp team id' },
    ],
    ...npm('@taazkareem/clickup-mcp-server@latest'),
  },
  {
    id: 'trello',
    name: 'Trello',
    description: 'Boards, lists and cards — move work along without opening the browser.',
    category: 'Productivity',
    icon: 'trello',
    requires: [
      { key: 'TRELLO_API_KEY', label: 'Trello API key' },
      { key: 'TRELLO_TOKEN', label: 'Trello token' },
    ],
    ...npm('@delorenj/mcp-server-trello'),
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Issues, projects and cycles in Linear, including comments and status changes.',
    category: 'Productivity',
    icon: 'linear',
    ...remote('https://mcp.linear.app/mcp', 'https://linear.app/docs/mcp'),
  },
  {
    id: 'asana',
    name: 'Asana',
    description: 'Tasks, projects and portfolios in Asana, with comments and assignees.',
    category: 'Productivity',
    icon: 'asana',
    ...remote('https://mcp.asana.com/sse', 'https://developers.asana.com/docs/using-asanas-mcp-server'),
  },
  {
    id: 'atlassian',
    name: 'Jira & Confluence',
    description: 'Search and update Jira issues and Confluence pages in your Atlassian site.',
    category: 'Productivity',
    icon: 'atlassian',
    ...remote('https://mcp.atlassian.com/v1/sse', 'https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/'),
  },
  {
    id: 'monday',
    name: 'monday.com',
    description: 'Boards, items and updates on monday.com, including creating and moving work.',
    category: 'Productivity',
    setup: [{ key: 'token', label: 'monday.com API token', flag: '--token' }],
    ...npm('@mondaydotcomorg/monday-api-mcp'),
  },

  // ---------------------------------------------------------------- Research
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    description: 'Scrape, crawl and search the web, and get clean markdown back instead of raw HTML.',
    category: 'Research',
    featured: true,
    requires: [{ key: 'FIRECRAWL_API_KEY', label: 'Firecrawl API key', hint: 'Starts with fc-' }],
    ...npm('firecrawl-mcp'),
  },
  {
    id: 'exa',
    name: 'Exa',
    description: 'Neural web search built for agents, with full page contents and similarity search.',
    category: 'Research',
    requires: [{ key: 'EXA_API_KEY', label: 'Exa API key' }],
    ...npm('exa-mcp-server'),
  },
  {
    id: 'tavily',
    name: 'Tavily',
    description: 'Search and extract, tuned for research: ranked answers with the sources kept.',
    category: 'Research',
    requires: [{ key: 'TAVILY_API_KEY', label: 'Tavily API key', hint: 'Starts with tvly-' }],
    ...npm('tavily-mcp@latest'),
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    description: 'Ask Perplexity a real-time question and get a cited answer back.',
    category: 'Research',
    icon: 'perplexity',
    requires: [{ key: 'PERPLEXITY_API_KEY', label: 'Perplexity API key' }],
    ...npm('server-perplexity-ask'),
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Web and local search through the Brave Search API, without the tracking.',
    category: 'Research',
    icon: 'brave',
    requires: [{ key: 'BRAVE_API_KEY', label: 'Brave Search API key' }],
    ...npm('@modelcontextprotocol/server-brave-search'),
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    description: 'Keyless web search with clean result text — a sensible default before you pay for one.',
    category: 'Research',
    icon: 'duckduckgo',
    ...npm('duckduckgo-mcp-server'),
  },
  {
    id: 'searxng',
    name: 'SearXNG',
    description: 'Search through your own SearXNG instance, so nothing leaves the network.',
    category: 'Research',
    requires: [{ key: 'SEARXNG_URL', label: 'SearXNG URL', hint: 'e.g. http://localhost:8080' }],
    ...npm('mcp-searxng'),
  },
  {
    id: 'context7',
    name: 'Context7',
    description: 'Up-to-date documentation and code examples for a library, at the version you use.',
    category: 'Research',
    icon: 'upstash',
    ...npm('@upstash/context7-mcp@latest'),
  },
  {
    id: 'apify',
    name: 'Apify',
    description: 'Run any of thousands of published scrapers and get structured data back.',
    category: 'Research',
    requires: [{ key: 'APIFY_TOKEN', label: 'Apify API token' }],
    ...npm('@apify/actors-mcp-server'),
  },
  {
    id: 'brightdata',
    name: 'Bright Data',
    description: 'Web search, structured extraction and browser automation that survives blocking.',
    category: 'Research',
    requires: [{ key: 'API_TOKEN', label: 'Bright Data API token' }],
    ...npm('@brightdata/mcp'),
  },
  {
    id: 'web-research',
    name: 'Web Research',
    description: 'Google search plus page reading in one loop, with screenshots of what it read.',
    category: 'Research',
    ...npm('@mzxrai/mcp-webresearch@latest'),
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    description: 'Search models, datasets and Spaces, and run inference on the Hub.',
    category: 'Research',
    icon: 'huggingface',
    ...remote('https://huggingface.co/mcp', 'https://huggingface.co/docs/huggingface_hub/guides/mcp'),
  },

  // ---------------------------------------------------------------- Sales
  {
    id: 'hubspot',
    name: 'HubSpot',
    description: 'Search and update contacts, companies, deals and tickets in your HubSpot CRM.',
    category: 'Sales',
    icon: 'hubspot',
    requires: [{ key: 'PRIVATE_APP_ACCESS_TOKEN', label: 'HubSpot private app token' }],
    ...npm('@hubspot/mcp-server'),
  },
  {
    id: 'airtable',
    name: 'Airtable',
    description: 'Read and write records, list bases and inspect table schemas in Airtable.',
    category: 'Sales',
    icon: 'airtable',
    requires: [{ key: 'AIRTABLE_API_KEY', label: 'Airtable personal access token', hint: 'Starts with pat' }],
    ...npm('airtable-mcp-server'),
  },
  {
    id: 'shopify',
    name: 'Shopify',
    description: 'Search the Shopify Admin API and Polaris docs while building against a store.',
    category: 'Sales',
    icon: 'shopify',
    ...npm('@shopify/dev-mcp@latest'),
  },

  // ---------------------------------------------------------------- Scheduling
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    description: 'Search events, check free time and schedule meetings across your calendars.',
    category: 'Scheduling',
    icon: 'googlecalendar',
    requires: [{ key: 'GOOGLE_OAUTH_CREDENTIALS', label: 'OAuth credentials file', hint: 'Path to gcp-oauth.keys.json' }],
    ...npm('@cocal/google-calendar-mcp'),
  },
  {
    id: 'time',
    name: 'Time',
    description: 'Current time and timezone conversion the model can trust instead of guessing.',
    category: 'Scheduling',
    ...npm('time-mcp'),
  },
];

export const CATALOG_BY_ID = new Map(MCP_CATALOG.map((spec) => [spec.id, spec]));
