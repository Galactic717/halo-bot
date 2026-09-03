package com.halo.bot.core

/**
 * The marketplace, rebuilt for a client that cannot fork a process.
 *
 * The desktop catalogue is 74 npm packages Halo spawns over stdio. None of that exists here: there
 * is no node on a phone and no way to install one, so every entry is a **remote** MCP server reached
 * over Streamable HTTP — the transport the specification added for exactly this case. That rules out
 * most of the desktop shelf and it would be dishonest to list it anyway: an entry that cannot
 * possibly start is worse than a shorter list.
 *
 * It also rules out, for now, the hosted servers that authenticate by opening a browser and running
 * OAuth (Linear, Notion, Atlassian, Canva, Asana, Vercel, PayPal). Halo sends one static credential
 * on every request; it does not yet do an authorisation-code flow. Those are named in the Plugins
 * screen as not-yet-supported rather than listed as installable and then failing on first call.
 *
 * What is here either needs no credential at all or takes one the user can paste.
 *
 * ponytail: a static list in the binary. It is a dozen entries and it changes when the app does;
 * fetching it would add a network dependency to a screen that has to work offline.
 */

val PLUGIN_CATEGORIES = listOf(
    "Research",
    "Developer",
    "Data Analytics",
    "Payments",
)

data class CatalogEntry(
    val spec: PluginSpec,
    /** One line under the tile saying what signing in involves. */
    val access: String,
)

/** A credential the user pastes, sent as `Authorization: Bearer <value>` unless a header is named. */
private fun key(label: String, hint: String) = listOf(McpField(key = "token", label = label, hint = hint))

val MCP_CATALOG: List<CatalogEntry> = listOf(
    // ------------------------------------------------------------------ Research
    CatalogEntry(
        PluginSpec(
            id = "deepwiki",
            name = "DeepWiki",
            description = "Ask questions about any public GitHub repository and get answers with the source it read.",
            category = "Research",
            url = "https://mcp.deepwiki.com/mcp",
            featured = true,
            source = "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
        ),
        access = "No account needed.",
    ),
    CatalogEntry(
        PluginSpec(
            id = "context7",
            name = "Context7",
            description = "Up-to-date documentation and code examples for a library, fetched at the version you name.",
            category = "Research",
            url = "https://mcp.context7.com/mcp",
            featured = true,
            source = "https://context7.com",
        ),
        access = "Works without a key; a free key raises the rate limit.",
    ),
    CatalogEntry(
        PluginSpec(
            id = "huggingface",
            name = "Hugging Face",
            description = "Search models, datasets and Spaces on the Hub, and run inference on them.",
            category = "Research",
            url = "https://huggingface.co/mcp",
            source = "https://huggingface.co/docs/huggingface_hub/guides/mcp",
        ),
        access = "Public content works signed out. A token from huggingface.co/settings/tokens adds your own.",
    ),
    CatalogEntry(
        PluginSpec(
            id = "exa",
            name = "Exa Search",
            description = "Neural web search built for agents: full page contents rather than a list of links.",
            category = "Research",
            url = "https://mcp.exa.ai/mcp",
            requires = key("Exa API key", "From dashboard.exa.ai. Sent as a bearer token."),
            source = "https://docs.exa.ai/reference/exa-mcp",
        ),
        access = "Needs a key from dashboard.exa.ai.",
    ),
    CatalogEntry(
        PluginSpec(
            id = "firecrawl",
            name = "Firecrawl",
            description = "Turn a site into clean markdown — crawl, scrape, and extract structured fields from a page.",
            category = "Research",
            url = "https://api.firecrawl.dev/mcp",
            requires = key("Firecrawl API key", "From firecrawl.dev/app/api-keys."),
            source = "https://docs.firecrawl.dev/mcp-server",
        ),
        access = "Needs a key from firecrawl.dev.",
    ),

    // ----------------------------------------------------------------- Developer
    CatalogEntry(
        PluginSpec(
            id = "github",
            name = "GitHub",
            description = "Issues, pull requests, code search and file contents across the repositories you can reach.",
            category = "Developer",
            url = "https://api.githubcopilot.com/mcp/",
            featured = true,
            requires = key(
                "GitHub personal access token",
                "github.com/settings/tokens. Give it only the scopes you want a bot to have.",
            ),
            source = "https://github.com/github/github-mcp-server",
        ),
        access = "Needs a personal access token.",
    ),
    CatalogEntry(
        PluginSpec(
            id = "cloudflare-docs",
            name = "Cloudflare Docs",
            description = "Search Cloudflare's documentation and get the current answer rather than a remembered one.",
            category = "Developer",
            url = "https://docs.mcp.cloudflare.com/mcp",
            source = "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
        ),
        access = "No account needed.",
    ),
    CatalogEntry(
        PluginSpec(
            id = "gitmcp",
            name = "GitMCP",
            description = "Point a bot at one public repository's docs and source, so it answers from that repo alone.",
            category = "Developer",
            url = "https://gitmcp.io/docs",
            source = "https://gitmcp.io",
        ),
        access = "No account needed. Change the URL to gitmcp.io/<owner>/<repo> for one repository.",
    ),

    // ------------------------------------------------------------ Data Analytics
    CatalogEntry(
        PluginSpec(
            id = "neon",
            name = "Neon",
            description = "Create branches, run queries and manage serverless Postgres projects on Neon.",
            category = "Data Analytics",
            url = "https://mcp.neon.tech/mcp",
            requires = key("Neon API key", "From console.neon.tech → Account settings → API keys."),
            source = "https://neon.com/docs/ai/neon-mcp-server",
        ),
        access = "Needs an API key.",
    ),

    // ------------------------------------------------------------------ Payments
    CatalogEntry(
        PluginSpec(
            id = "stripe",
            name = "Stripe",
            description = "Customers, payments, invoices, subscriptions and the Stripe documentation.",
            category = "Payments",
            url = "https://mcp.stripe.com",
            requires = key(
                "Stripe restricted key",
                "dashboard.stripe.com/apikeys. Use a restricted key — a bot never needs the secret one.",
            ),
            source = "https://docs.stripe.com/mcp",
        ),
        access = "Needs a restricted API key.",
    ),
)

/** Hosted servers that exist but need a browser sign-in Halo cannot do yet. Named, not offered. */
val OAUTH_ONLY = listOf(
    "Linear", "Notion", "Jira & Confluence", "Asana", "Canva", "Sentry", "Vercel", "PayPal", "Square", "Intercom",
)

/**
 * Subsequence match with a score, the way the desktop marketplace behaves: an exact name wins, then
 * a prefix, then a name substring, then anything the query threads through in order.
 */
fun fuzzyScore(query: String, name: String, description: String = ""): Int {
    val needle = query.trim().lowercase()
    if (needle.isEmpty()) return 1
    val haystack = name.lowercase()

    if (haystack == needle) return 1000
    if (haystack.startsWith(needle)) return 900 - haystack.length
    if (haystack.contains(needle)) return 700 - haystack.indexOf(needle)
    if (description.lowercase().contains(needle)) return 500

    var at = 0
    var gaps = 0
    for (char in needle) {
        val found = haystack.indexOf(char, at)
        if (found < 0) return 0
        gaps += found - at
        at = found + 1
    }
    return maxOf(1, 300 - gaps)
}

fun searchCatalog(query: String, category: String?): List<CatalogEntry> {
    val scoped = MCP_CATALOG.filter { category == null || it.spec.category == category }
    if (query.isBlank()) return scoped
    return scoped
        .map { it to fuzzyScore(query, it.spec.name, it.spec.description) }
        .filter { it.second > 0 }
        .sortedWith(compareByDescending<Pair<CatalogEntry, Int>> { it.second }.thenBy { it.first.spec.name })
        .map { it.first }
}
