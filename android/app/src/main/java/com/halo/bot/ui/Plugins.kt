package com.halo.bot.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.halo.bot.Halo
import com.halo.bot.core.CatalogEntry
import com.halo.bot.core.McpServerStatus
import com.halo.bot.core.OAUTH_ONLY
import com.halo.bot.core.PLUGIN_CATEGORIES
import com.halo.bot.core.PluginSpec
import com.halo.bot.core.missingFields
import com.halo.bot.core.parseMcpConfig
import com.halo.bot.core.searchCatalog
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The marketplace and the installed shelf, in one screen.
 *
 * The desktop build gives this a two-pane modal with category rails; a phone gets one column, a chip
 * row and a bottom sheet for the install form. What is behind it is the same: a spec is written into
 * settings, `McpManager.sync` brings the running set in line, and the tools appear to every bot as
 * `mcp__<server>__<tool>` a turn later.
 */
@Composable
fun PluginsScreen(model: HaloViewModel, onBack: () -> Unit) {
    val colors = LocalHaloColors.current
    var query by remember { mutableStateOf("") }
    var category by remember { mutableStateOf<String?>(null) }
    var installing by remember { mutableStateOf<PluginSpec?>(null) }
    var pasting by remember { mutableStateOf(false) }
    var detail by remember { mutableStateOf<PluginSpec?>(null) }
    var statuses by remember { mutableStateOf<List<McpServerStatus>>(emptyList()) }

    // The manager starts servers off the main thread, so the shelf catches up rather than blocking.
    LaunchedEffect(model.settings.plugins) {
        repeat(10) {
            statuses = Halo.mcp.statuses()
            delay(600)
        }
    }

    val installed = model.settings.plugins
    val results = searchCatalog(query, category).filter { entry -> installed.none { it.id == entry.spec.id } }

    Column(modifier = Modifier.fillMaxSize().background(colors.bgBase).imePadding()) {
        HaloTopBar("Plugins", onBack = onBack)

        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding(),
        ) {
            Text(
                "Plugins are MCP servers your bots can call. On a phone they are reached over the network — " +
                    "there is nothing here to install a package into — so anything listed is a hosted server.",
                modifier = Modifier.padding(horizontal = Halo4, vertical = Halo2),
                style = MaterialTheme.typography.bodySmall,
                color = colors.textTertiary,
            )

            if (installed.isNotEmpty()) {
                SectionLabel("Installed")
                for (spec in installed) {
                    val status = statuses.firstOrNull { it.id == spec.id }
                    InstalledRow(
                        spec = spec,
                        status = status,
                        onToggle = { enabled ->
                            model.saveSettings { s ->
                                s.copy(plugins = s.plugins.map { if (it.id == spec.id) it.copy(enabled = enabled) else it })
                            }
                        },
                        onEdit = { installing = spec },
                        onDetail = { detail = spec },
                        onRemove = {
                            model.saveSettings { s -> s.copy(plugins = s.plugins.filterNot { it.id == spec.id }) }
                        },
                    )
                }
            }

            SectionLabel("Add one")
            HaloField("Search", query, { query = it }, placeholder = "github, docs, search…")
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = Halo3, vertical = Halo1),
                horizontalArrangement = Arrangement.spacedBy(Halo1),
            ) {
                Chip("All", category == null) { category = null }
                for (name in PLUGIN_CATEGORIES) {
                    Chip(name, category == name) { category = if (category == name) null else name }
                }
            }

            for (entry in results) {
                CatalogRow(entry) { installing = entry.spec }
            }
            if (results.isEmpty()) {
                InfoCard("Nothing matches that. You can still add any MCP server by its URL below.")
            }

            SectionLabel("Your own server")
            Text(
                "Any server speaking MCP over Streamable HTTP works — one you run yourself, one on your network, " +
                    "or a hosted one that takes a token.",
                modifier = Modifier.padding(horizontal = Halo4),
                style = MaterialTheme.typography.bodySmall,
                color = colors.textTertiary,
            )
            Row(modifier = Modifier.padding(Halo4), horizontalArrangement = Arrangement.spacedBy(Halo2)) {
                HaloButton(
                    "Add by URL",
                    {
                        installing = PluginSpec(
                            id = "custom-" + System.currentTimeMillis().toString(36),
                            name = "",
                            description = "A server you added yourself.",
                            category = "Your own",
                            url = "",
                        )
                    },
                    Modifier.weight(1f),
                    primary = true,
                )
                HaloButton("Paste its config", { pasting = true }, Modifier.weight(1f))
            }
            Text(
                "\"Paste its config\" takes the JSON snippet from a server's own README - the one written for " +
                    "Claude Desktop, Cursor or VS Code - and reads the address and the token out of it.",
                modifier = Modifier.padding(horizontal = Halo4),
                style = MaterialTheme.typography.bodySmall,
                color = colors.textTertiary,
            )

            SectionLabel("Automation")
            Text(
                "n8n is not a plugin here: Halo talks to it directly. Turn it on in Settings - General - " +
                    "Automation and your bots get N8nWorkflows, N8nWorkflow, N8nSaveWorkflow, " +
                    "N8nActivateWorkflow, N8nRunWorkflow and N8nExecutions - the same six the Windows build has.",
                modifier = Modifier.padding(horizontal = Halo4, vertical = Halo2),
                style = MaterialTheme.typography.bodySmall,
                color = colors.textTertiary,
            )

            SectionLabel("Not supported yet")
            Text(
                OAUTH_ONLY.joinToString(", ") + " publish hosted MCP servers, but they sign you in through a " +
                    "browser rather than with a token you can paste. Halo sends one static credential per server, " +
                    "so those cannot work here yet and are left out rather than listed and broken.",
                modifier = Modifier.padding(horizontal = Halo4, vertical = Halo2),
                style = MaterialTheme.typography.bodySmall,
                color = colors.textTertiary,
            )
            Spacer(Modifier.height(Halo6))
        }
    }

    if (pasting) {
        PasteConfigSheet(
            taken = installed.map { it.id }.toSet(),
            onDismiss = { pasting = false },
            onAdd = { specs ->
                pasting = false
                model.saveSettings { s ->
                    s.copy(plugins = s.plugins.filterNot { p -> specs.any { it.id == p.id } } + specs)
                }
            },
        )
    }

    detail?.let { spec ->
        PluginDetailSheet(spec, statuses.firstOrNull { it.id == spec.id }) { detail = null }
    }

    installing?.let { spec ->
        InstallSheet(
            spec = spec,
            onDismiss = { installing = null },
            onSave = { next ->
                installing = null
                model.saveSettings { s ->
                    val rest = s.plugins.filterNot { it.id == next.id }
                    s.copy(plugins = rest + next)
                }
            },
        )
    }
}

@Composable
private fun Chip(label: String, active: Boolean, onClick: () -> Unit) {
    val colors = LocalHaloColors.current
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(Halo3))
            .background(if (active) colors.fillGhostSelected else colors.bgSubtle)
            .clickable(onClick = onClick)
            .heightIn(min = 36.dp)
            .padding(horizontal = Halo3),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = if (active) colors.textPrimary else colors.textSecondary,
        )
    }
}

@Composable
private fun CatalogRow(entry: CatalogEntry, onInstall: () -> Unit) {
    val colors = LocalHaloColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onInstall)
            .padding(horizontal = Halo4, vertical = Halo3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Monogram(entry.spec.name)
        Spacer(Modifier.width(Halo3))
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    entry.spec.name,
                    style = MaterialTheme.typography.titleSmall,
                    color = colors.textPrimary,
                )
                if (entry.spec.featured) {
                    Spacer(Modifier.width(Halo2))
                    Text("featured", style = MaterialTheme.typography.labelSmall, color = colors.accent)
                }
            }
            Text(entry.spec.description, style = MaterialTheme.typography.bodySmall, color = colors.textSecondary)
            Text(entry.access, style = MaterialTheme.typography.labelSmall, color = colors.textTertiary)
        }
        Spacer(Modifier.width(Halo2))
        Text("Add", style = MaterialTheme.typography.labelLarge, color = colors.accent)
    }
}

@Composable
private fun InstalledRow(
    spec: PluginSpec,
    status: McpServerStatus?,
    onToggle: (Boolean) -> Unit,
    onEdit: () -> Unit,
    onDetail: () -> Unit,
    onRemove: () -> Unit,
) {
    val colors = LocalHaloColors.current
    val missing = missingFields(spec)
    val state = when {
        !spec.enabled -> "off" to colors.textTertiary
        missing.isNotEmpty() -> "needs ${missing.first().label}" to colors.textWarning
        status == null -> "starting…" to colors.textTertiary
        status.state == "ready" -> "${status.toolCount} tools" to colors.textSuccess
        status.state == "error" -> (status.error ?: "failed").take(90) to colors.textDanger
        else -> status.state to colors.textTertiary
    }

    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = Halo4, vertical = Halo2)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Monogram(spec.name)
            Spacer(Modifier.width(Halo3))
            Column(modifier = Modifier.weight(1f)) {
                Text(spec.name, style = MaterialTheme.typography.titleSmall, color = colors.textPrimary)
                Text(state.first, style = MaterialTheme.typography.bodySmall, color = state.second)
            }
            Text(
                if (spec.enabled) "Turn off" else "Turn on",
                modifier = Modifier.clickable { onToggle(!spec.enabled) },
                style = MaterialTheme.typography.labelMedium,
                color = colors.textSecondary,
            )
        }
        Row(modifier = Modifier.padding(top = Halo1), horizontalArrangement = Arrangement.spacedBy(Halo4)) {
            Text(
                "Tools",
                modifier = Modifier.clickable(onClick = onDetail),
                style = MaterialTheme.typography.labelMedium,
                color = colors.accent,
            )
            Text(
                "Edit",
                modifier = Modifier.clickable(onClick = onEdit),
                style = MaterialTheme.typography.labelMedium,
                color = colors.accent,
            )
            Text(
                "Remove",
                modifier = Modifier.clickable(onClick = onRemove),
                style = MaterialTheme.typography.labelMedium,
                color = colors.textDanger,
            )
        }
    }
}

/** A letter in a tinted square. The desktop shows brand marks; bundling 74 SVGs onto a phone is not worth it. */
@Composable
private fun Monogram(name: String) {
    val colors = LocalHaloColors.current
    Box(
        modifier = Modifier
            .size(36.dp)
            .clip(RoundedCornerShape(Halo2))
            .background(colors.fillSecondary),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            name.trim().take(1).uppercase().ifEmpty { "?" },
            style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
            color = colors.textSecondary,
        )
    }
}

@Composable
private fun InstallSheet(spec: PluginSpec, onDismiss: () -> Unit, onSave: (PluginSpec) -> Unit) {
    val colors = LocalHaloColors.current
    var name by remember { mutableStateOf(spec.name) }
    var url by remember { mutableStateOf(spec.url) }
    var authHeader by remember { mutableStateOf(spec.authHeader.orEmpty()) }
    val answers = remember {
        mutableStateOf(spec.requires.associate { it.key to spec.env[it.key].orEmpty() })
    }

    HaloSheet(onDismiss) {
        Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
            SheetTitle(if (spec.name.isBlank()) "Add a server" else spec.name)
            if (spec.description.isNotBlank()) {
                Text(
                    spec.description,
                    modifier = Modifier.padding(horizontal = Halo4, vertical = Halo1),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textSecondary,
                )
            }

            HaloField("Name", name, { name = it }, placeholder = "My server")
            HaloField(
                "Server URL",
                url,
                { url = it },
                placeholder = "https://example.com/mcp",
                hint = "The MCP endpoint, spoken over Streamable HTTP.",
            )

            for (field in spec.requires) {
                HaloField(
                    field.label,
                    answers.value[field.key].orEmpty(),
                    { value -> answers.value = answers.value + (field.key to value) },
                    hint = field.hint,
                )
            }
            if (spec.requires.isEmpty()) {
                HaloField(
                    "Token (optional)",
                    answers.value["token"].orEmpty(),
                    { value -> answers.value = answers.value + ("token" to value) },
                    hint = "Sent as Authorization: Bearer, and sealed with the keystore before it reaches disk.",
                )
            }
            HaloField(
                "Header for the token",
                authHeader,
                { authHeader = it },
                placeholder = "Authorization",
                hint = "Leave blank for the usual Authorization: Bearer. Some servers want their own header.",
            )

            spec.source?.let {
                Text(
                    it,
                    modifier = Modifier.padding(horizontal = Halo4, vertical = Halo2),
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    color = colors.textTertiary,
                )
            }

            Row(modifier = Modifier.padding(Halo4), horizontalArrangement = Arrangement.spacedBy(Halo2)) {
                HaloButton("Cancel", onDismiss, Modifier.weight(1f))
                HaloButton(
                    "Save",
                    {
                        onSave(
                            spec.copy(
                                name = name.trim().ifEmpty { url.trim().substringAfter("//").substringBefore('/') },
                                url = url.trim(),
                                env = answers.value.filterValues { it.isNotBlank() },
                                authHeader = authHeader.trim().takeIf { it.isNotEmpty() },
                                enabled = true,
                            ),
                        )
                    },
                    Modifier.weight(1f),
                    primary = true,
                    enabled = url.trim().startsWith("http"),
                )
            }
            Spacer(Modifier.height(Halo4))
        }
    }
}


/**
 * What one plugin actually exposes, which is the desktop marketplace's detail page.
 *
 * Worth its own surface for the same reason it is worth one there: "3 tools" is a health check, and
 * *which* three is what tells somebody whether the plugin does the job they installed it for.
 */
@Composable
private fun PluginDetailSheet(spec: PluginSpec, status: McpServerStatus?, onDismiss: () -> Unit) {
    val colors = LocalHaloColors.current
    val tools = remember(spec.id, status?.toolCount) { Halo.mcp.tools(spec.id) }

    HaloSheet(onDismiss) {
        Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
            SheetTitle(spec.name)
            if (spec.description.isNotBlank()) {
                Text(
                    spec.description,
                    modifier = Modifier.padding(horizontal = Halo4),
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textSecondary,
                )
            }
            SectionLabel("Runs")
            Text(
                spec.url.ifBlank { "no address" },
                modifier = Modifier.padding(horizontal = Halo4),
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                color = colors.textTertiary,
            )
            SectionLabel(if (tools.isEmpty()) "Tools" else tools.size.toString() + " tools")
            if (tools.isEmpty()) {
                InfoCard(
                    when (status?.state) {
                        "error" -> status.error ?: "The server did not start."
                        "ready" -> "It started but exposes no tools."
                        else -> "Not running yet. Turn it on and give it a moment."
                    },
                    tone = if (status?.state == "error") "danger" else "neutral",
                )
            }
            for (tool in tools) {
                Column(modifier = Modifier.padding(horizontal = Halo4, vertical = Halo2)) {
                    Text(
                        "mcp__" + spec.id + "__" + tool.name,
                        style = MaterialTheme.typography.labelMedium.copy(fontFamily = FontFamily.Monospace),
                        color = colors.textPrimary,
                    )
                    if (tool.description.isNotBlank()) {
                        Text(
                            tool.description.lineSequence().first().take(200),
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.textTertiary,
                        )
                    }
                }
            }
            Spacer(Modifier.height(Halo6))
        }
    }
}

/** One paste, however the server's own page writes it. See core/PluginConfig.kt. */
@Composable
private fun PasteConfigSheet(taken: Set<String>, onDismiss: () -> Unit, onAdd: (List<PluginSpec>) -> Unit) {
    val colors = LocalHaloColors.current
    var text by remember { mutableStateOf("") }
    val parsed = remember(text) { if (text.isBlank()) null else parseMcpConfig(text, taken) }

    HaloSheet(onDismiss) {
        Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
            SheetTitle("Paste a server config")
            HaloField(
                "Config",
                text,
                { text = it },
                singleLine = false,
                placeholder = "{ \"mcpServers\": { \"my-server\": { \"url\": \"https://example.com/mcp\" } } }",
                hint = "The snippet from the server's own README. Several servers in one block are all added.",
            )
            parsed?.error?.let { InfoCard(it, tone = "danger") }
            for (reason in parsed?.skipped.orEmpty()) InfoCard(reason, tone = "warning")
            if (!parsed?.servers.isNullOrEmpty()) {
                SectionLabel("Will be added")
                for (spec in parsed.servers) {
                    Text(
                        spec.name + "  -  " + spec.url,
                        modifier = Modifier.padding(horizontal = Halo4, vertical = 2.dp),
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.textSecondary,
                    )
                }
            }
            Row(modifier = Modifier.padding(Halo4), horizontalArrangement = Arrangement.spacedBy(Halo2)) {
                HaloButton("Cancel", onDismiss, Modifier.weight(1f))
                HaloButton(
                    "Add",
                    { parsed?.servers?.takeIf { it.isNotEmpty() }?.let(onAdd) },
                    Modifier.weight(1f),
                    primary = true,
                    enabled = !parsed?.servers.isNullOrEmpty(),
                )
            }
            Spacer(Modifier.height(Halo4))
        }
    }
}
