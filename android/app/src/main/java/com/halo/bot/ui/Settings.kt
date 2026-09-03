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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material3.Icon
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.halo.bot.Halo
import com.halo.bot.core.AuditRow
import com.halo.bot.core.AutoReviewRule
import com.halo.bot.core.ModelInfo
import com.halo.bot.core.REPLY_LANGUAGES
import com.halo.bot.core.listModelsDetailed
import com.halo.bot.platform.HaloService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

/**
 * The desktop's Settings modal, unfolded onto a phone.
 *
 * Same five tabs and the same wording, because the two builds are meant to be one product: somebody
 * who has used the Windows version should not have to re-learn what "Dry run" means. The differences
 * are the ones the platform forces — "Start with Windows" and "Close to tray" become one switch for
 * the foreground service, and "execution on your computer" is about shared storage rather than a
 * shell, because there is no shell outside the box on Android.
 */
private enum class SettingsTab(val label: String) {
    GENERAL("General"),
    MODEL("Model"),
    ACTIVITY("Activity"),
    USAGE("Usage"),
    ABOUT("About"),
}

@Composable
fun SettingsScreen(model: HaloViewModel, onBack: () -> Unit, onPlugins: () -> Unit) {
    val colors = LocalHaloColors.current
    var tab by remember { mutableStateOf(SettingsTab.GENERAL) }

    Column(modifier = Modifier.fillMaxSize().background(colors.bgBase).imePadding()) {
        HaloTopBar("Settings", onBack = onBack)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = Halo3, vertical = Halo1),
            horizontalArrangement = Arrangement.spacedBy(Halo1),
        ) {
            for (option in SettingsTab.entries) {
                val active = option == tab
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(Halo3))
                        .background(if (active) colors.fillGhostSelected else Color.Transparent)
                        .clickable { tab = option }
                        .heightIn(min = 40.dp)
                        .padding(horizontal = Halo3),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        option.label,
                        style = MaterialTheme.typography.labelLarge,
                        color = if (active) colors.textPrimary else colors.textSecondary,
                    )
                }
            }
        }

        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding(),
        ) {
            when (tab) {
                SettingsTab.GENERAL -> GeneralTab(model, onPlugins)
                SettingsTab.MODEL -> ModelTab(model)
                SettingsTab.ACTIVITY -> ActivityTab()
                SettingsTab.USAGE -> UsageTab(model)
                SettingsTab.ABOUT -> AboutTab()
            }
            Spacer(Modifier.height(Halo6))
        }
    }
}

// ------------------------------------------------------------------------ general

@Composable
private fun GeneralTab(model: HaloViewModel, onPlugins: () -> Unit) {
    val colors = LocalHaloColors.current
    val context = LocalContext.current
    val settings = model.settings
    var ruleWhen by remember { mutableStateOf("") }
    var ruleDecision by remember { mutableStateOf("allow") }

    SectionLabel("Appearance")
    HaloChoiceRow(
        "Theme",
        null,
        listOf("system" to "System", "dark" to "Dark", "light" to "Light"),
        settings.theme,
    ) { value -> model.saveSettings { it.copy(theme = value) } }

    SectionLabel("Bots")
    HaloWrapChoice(
        "Reply language",
        "What your bots answer in. Matching follows each message rather than the conversation, so a bot " +
            "switches with you mid-thread. Code, paths and error strings are never translated.",
        REPLY_LANGUAGES,
        settings.replyLanguage,
    ) { value -> model.saveSettings { it.copy(replyLanguage = value) } }

    HaloField(
        "Timezone",
        settings.timezone,
        { value -> model.saveSettings { it.copy(timezone = value) } },
        hint = "Used for routines and for telling a bot what time it is.",
    )

    HaloChoiceRow(
        "Work outside the box",
        "Reading and writing the folders you granted, rather than a bot's own private storage.",
        listOf("ask" to "Ask", "allow" to "Allow", "never" to "Never"),
        settings.localExecution,
    ) { value -> model.saveSettings { it.copy(localExecution = value) } }

    HaloSwitchRow(
        "Auto-review",
        "Halo checks each action before it runs and asks you when it matters.",
        settings.autoReview,
    ) { value -> model.saveSettings { it.copy(autoReview = value) } }

    if (settings.autoReview) {
        HaloChoiceRow(
            "Review depth",
            "Rules only is instant. Smart also asks the model about anything that touches your files.",
            listOf("rules" to "Rules only", "smart" to "Smart"),
            settings.autoReviewMode,
        ) { value -> model.saveSettings { it.copy(autoReviewMode = value) } }
    }

    HaloChoiceRow(
        "What a refusal does",
        "Dry run decides and writes it to Activity without stopping the bot, so you can watch a new rule work " +
            "before it starts refusing things. Halo's own floor still refuses in both.",
        listOf("enforce" to "Refuse", "dry-run" to "Dry run"),
        settings.policyMode,
    ) { value -> model.saveSettings { it.copy(policyMode = value) } }

    SectionLabel("Automation")
    HaloSwitchRow(
        "Connect n8n",
        "Lets your bots read, write and fire workflows on your own n8n. Every service you have connected there " +
            "becomes something a bot can use, and those credentials stay in n8n rather than coming in here. " +
            "Writing, activating and firing a workflow all ask you first.",
        settings.n8n.enabled,
    ) { value -> model.saveSettings { it.copy(n8n = it.n8n.copy(enabled = value)) } }

    if (settings.n8n.enabled) {
        HaloField(
            "Address",
            settings.n8n.baseUrl,
            { value -> model.saveSettings { it.copy(n8n = it.n8n.copy(baseUrl = value)) } },
            placeholder = "http://localhost:5678",
            hint = "Where n8n is. On this phone that is a machine on your wifi, not localhost.",
        )
        HaloField(
            "API key",
            settings.n8n.apiKey,
            { value -> model.saveSettings { it.copy(n8n = it.n8n.copy(apiKey = value)) } },
            hint = "n8n - Settings - n8n API - Create an API key. Sealed with this phone's keystore before it reaches disk.",
        )
    }

    SectionLabel("This phone")
    HaloSwitchRow(
        "Keep working in the background",
        "A quiet notification keeps the process alive so routines still fire and long jobs still finish " +
            "with Halo off screen. Turn it off and bots only run while you are looking.",
        settings.backgroundService,
    ) { value ->
        model.saveSettings { it.copy(backgroundService = value) }
        HaloService.sync(context, value)
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onPlugins)
            .padding(horizontal = Halo4, vertical = Halo3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Default.Extension, null, tint = colors.textSecondary, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(Halo3))
        Column(modifier = Modifier.weight(1f)) {
            Text("Plugins", style = MaterialTheme.typography.bodyLarge, color = colors.textPrimary)
            Text(
                "${settings.plugins.count { it.enabled }} installed",
                style = MaterialTheme.typography.bodySmall,
                color = colors.textTertiary,
            )
        }
    }

    val hidden = model.agents.filter { it.hidden }
    if (hidden.isNotEmpty()) {
        SectionLabel("Hidden bots")
        for (bot in hidden) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = Halo4, vertical = Halo2),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(bot.name, style = MaterialTheme.typography.bodyLarge, color = colors.textPrimary, modifier = Modifier.weight(1f))
                HaloButton("Show again", { model.updateAgent(bot.id) { it.copy(hidden = false) } })
            }
        }
    }

    SectionLabel("Auto-review rules")
    Text(
        "One short rule per action. \"Ask first\" wins when rules conflict, and a deny always beats an allow.",
        modifier = Modifier.padding(horizontal = Halo4),
        style = MaterialTheme.typography.bodySmall,
        color = colors.textTertiary,
    )
    for (rule in settings.rules) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Halo4, vertical = Halo2),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(rule.trigger, style = MaterialTheme.typography.bodyMedium, color = colors.textPrimary)
                // What the rule actually covers, so a scoped one does not read as a blanket.
                val scope = rule.commandPrefix?.let { "only commands starting \"$it\"" }
                    ?: rule.expression?.let { "expression: $it" }
                    ?: rule.surface?.wire?.replace('_', ' ')?.let { "only $it" }
                if (scope != null) {
                    Text(scope, style = MaterialTheme.typography.bodySmall, color = colors.textTertiary)
                }
            }
            Text(rule.decision, style = MaterialTheme.typography.labelMedium, color = colors.textSecondary)
            Spacer(Modifier.width(Halo3))
            Text(
                "Remove",
                modifier = Modifier.clickable {
                    model.saveSettings { s -> s.copy(rules = s.rules.filterNot { it.id == rule.id }) }
                },
                style = MaterialTheme.typography.labelMedium,
                color = colors.textDanger,
            )
        }
    }
    HaloField("When a bot wants to…", ruleWhen, { ruleWhen = it }, placeholder = "read files from Downloads")
    HaloChoiceRow(
        "and Halo should",
        null,
        listOf("allow" to "Allow", "ask" to "Ask", "deny" to "Never"),
        ruleDecision,
    ) { ruleDecision = it }
    Row(modifier = Modifier.padding(Halo4)) {
        HaloButton(
            "Add rule",
            {
                val text = ruleWhen.trim()
                if (text.isNotEmpty()) {
                    model.saveSettings { s ->
                        s.copy(rules = s.rules + AutoReviewRule(UUID.randomUUID().toString(), text, ruleDecision))
                    }
                    ruleWhen = ""
                }
            },
            enabled = ruleWhen.isNotBlank(),
        )
    }
}

// -------------------------------------------------------------------------- model

@Composable
private fun ModelTab(model: HaloViewModel) {
    val colors = LocalHaloColors.current
    val scope = rememberCoroutineScope()
    val provider = model.settings.provider

    var baseUrl by remember(provider.baseUrl) { mutableStateOf(provider.baseUrl) }
    var apiKey by remember(provider.apiKey) { mutableStateOf(provider.apiKey) }
    var modelId by remember(provider.model) { mutableStateOf(provider.model) }
    var helperModel by remember(provider.helperModel) { mutableStateOf(provider.helperModel) }
    var imageBaseUrl by remember(provider.imageBaseUrl) { mutableStateOf(provider.imageBaseUrl) }
    var imageModel by remember(provider.imageModel) { mutableStateOf(provider.imageModel) }
    var contextBudget by remember(provider.contextBudget) { mutableStateOf(provider.contextBudget.toString()) }
    var maxSteps by remember(provider.maxSteps) { mutableStateOf(provider.maxSteps.toString()) }

    var found by remember { mutableStateOf<List<ModelInfo>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    /**
     * Saves, unless the address could not possibly work.
     *
     * A blank or schemeless address is accepted by every field on this screen and then fails on every
     * turn with OkHttp complaining about URL schemes, which reads like a bug in Halo rather than an
     * empty box on this screen. The setup screen cannot reach this state because it will not let you
     * past without a server that answered; this screen is the one that can, so it checks here.
     */
    fun commit(): Boolean {
        val address = baseUrl.trim()
        if (!address.startsWith("http://", ignoreCase = true) && !address.startsWith("https://", ignoreCase = true)) {
            error = if (address.isEmpty()) {
                "Enter the address of your model server, for example http://192.168.1.10:11434/v1 or https://api.x.ai/v1."
            } else {
                "The server address has to start with http:// or https://."
            }
            return false
        }
        error = null
        model.saveSettings { s ->
            s.copy(
                provider = s.provider.copy(
                    baseUrl = baseUrl.trim(),
                    apiKey = apiKey.trim(),
                    model = modelId.trim(),
                    helperModel = helperModel.trim(),
                    imageBaseUrl = imageBaseUrl.trim(),
                    imageModel = imageModel.trim(),
                    contextBudget = contextBudget.toIntOrNull()?.coerceAtLeast(2000) ?: s.provider.contextBudget,
                    maxSteps = maxSteps.toIntOrNull()?.coerceIn(1, 100) ?: s.provider.maxSteps,
                ),
            )
        }
        return true
    }

    Text(
        "Any OpenAI-compatible endpoint works: Ollama or LM Studio on your network, x.ai, OpenRouter, DeepSeek. " +
            "The model needs tool calling.",
        modifier = Modifier.padding(horizontal = Halo4, vertical = Halo2),
        style = MaterialTheme.typography.bodySmall,
        color = colors.textTertiary,
    )

    HaloField("Server address", baseUrl, { baseUrl = it })
    HaloField("API key", apiKey, { apiKey = it }, hint = "Sealed with this phone's keystore before it reaches disk.")
    HaloField("Model", modelId, { modelId = it })

    Row(modifier = Modifier.padding(horizontal = Halo4, vertical = Halo2), horizontalArrangement = Arrangement.spacedBy(Halo2)) {
        HaloButton(
            if (loading) "Looking…" else "Load list",
            {
                loading = true
                error = null
                scope.launch {
                    runCatching {
                        withContext(Dispatchers.IO) {
                            listModelsDetailed(model.settings.provider.copy(baseUrl = baseUrl.trim(), apiKey = apiKey.trim()))
                        }
                    }
                        .onSuccess { found = it }
                        .onFailure { error = (it.message ?: it.toString()).take(200) }
                    loading = false
                }
            },
            enabled = !loading,
        )
        HaloButton("Save", { if (commit()) model.refreshProvider() }, primary = true)
    }

    error?.let { InfoCard(it, tone = "danger") }
    if (found.isNotEmpty()) {
        SectionLabel("${found.size} models on that server")
        for (info in found.take(60)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { modelId = info.id }
                    .padding(horizontal = Halo4, vertical = Halo2),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    info.id,
                    style = MaterialTheme.typography.bodyMedium.copy(
                        fontWeight = if (info.id == modelId) FontWeight.SemiBold else FontWeight.Normal,
                    ),
                    color = if (info.id == modelId) colors.accent else colors.textPrimary,
                    modifier = Modifier.weight(1f),
                )
                if (info.capabilities.isNotEmpty() && "tools" !in info.capabilities) {
                    Text("no tools", style = MaterialTheme.typography.labelSmall, color = colors.textWarning)
                }
            }
        }
    }

    SectionLabel("Helper")
    HaloField(
        "Helper model",
        helperModel,
        { helperModel = it },
        placeholder = "same as above",
        hint = "Memory extraction, safety review and summarising. A smaller, faster model is ideal.",
    )

    SectionLabel("Vision and images")
    HaloSwitchRow(
        "Send images to the model",
        "Screenshots and attached pictures go into the prompt. Needs a vision model.",
        provider.vision,
    ) { value -> model.saveSettings { it.copy(provider = it.provider.copy(vision = value)) } }
    HaloField(
        "Image endpoint",
        imageBaseUrl,
        { imageBaseUrl = it },
        placeholder = "https://api.openai.com/v1",
        hint = "Optional. Enables GenerateImage against any OpenAI-compatible /images/generations.",
    )
    HaloField("Image model", imageModel, { imageModel = it }, placeholder = "gpt-image-1")

    SectionLabel("Limits")
    HaloField(
        "Context budget (tokens)",
        contextBudget,
        { contextBudget = it.filter { c -> c.isDigit() } },
        numeric = true,
        hint = "Past this, older turns fold into a summary. Keep it under what your model can hold.",
    )
    HaloField(
        "Max tool steps per turn",
        maxSteps,
        { maxSteps = it.filter { c -> c.isDigit() } },
        numeric = true,
    )
    Row(modifier = Modifier.padding(Halo4)) {
        HaloButton("Save", { if (commit()) model.refreshProvider() }, Modifier.fillMaxWidth(), primary = true)
    }
}

// ----------------------------------------------------------------------- activity

/**
 * What the bots were allowed to do, what they were refused, and what then failed.
 *
 * The refusals are the interesting rows and they are otherwise invisible: a denied tool call is one
 * muted line in a transcript nobody scrolls back through, and a rule quietly refusing work every day
 * looks like a bot being unhelpful.
 */
@Composable
private fun ActivityTab() {
    val colors = LocalHaloColors.current
    var outcome by remember { mutableStateOf("") }
    var query by remember { mutableStateOf("") }
    var rows by remember { mutableStateOf<List<AuditRow>>(emptyList()) }
    var totals by remember { mutableStateOf(Triple(0, 0, 0)) }
    var open by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(outcome, query) {
        withContext(Dispatchers.IO) {
            val log = Halo.runner.audit
            val next = log.read(
                limit = 200,
                outcome = outcome.takeIf { it.isNotEmpty() },
                query = query.trim().takeIf { it.isNotEmpty() },
            )
            val summary = log.summary(7)
            withContext(Dispatchers.Main) {
                rows = next
                totals = summary
            }
        }
    }

    Text(
        "Every action that went through the approval gate, decided before it ran. Last seven days: " +
            "${totals.first} allowed, ${totals.second} refused, ${totals.third} failed.",
        modifier = Modifier.padding(horizontal = Halo4, vertical = Halo2),
        style = MaterialTheme.typography.bodySmall,
        color = colors.textTertiary,
    )
    HaloField("Search the trail", query, { query = it })
    HaloChoiceRow(
        "Show",
        null,
        listOf("" to "All", "refused" to "Refused", "failed" to "Failed", "allowed" to "Allowed"),
        outcome,
    ) { outcome = it }

    if (rows.isEmpty()) {
        InfoCard("Nothing on the trail yet.")
    }
    for ((index, row) in rows.withIndex()) {
        val id = "${row.at}-$index"
        val tone = when (row.outcome) {
            "refused" -> colors.textDanger
            "failed" -> colors.textWarning
            else -> colors.textSuccess
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { open = if (open == id) null else id }
                .padding(horizontal = Halo4, vertical = Halo2),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(modifier = Modifier.size(8.dp).clip(RoundedCornerShape(50)).background(tone))
                Spacer(Modifier.width(Halo2))
                Text(row.agentName, style = MaterialTheme.typography.labelMedium, color = colors.textSecondary)
                Spacer(Modifier.weight(1f))
                Text(
                    SimpleDateFormat("d MMM HH:mm", Locale.getDefault()).format(Date(row.at)),
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textTertiary,
                )
            }
            Text(row.summary, style = MaterialTheme.typography.bodyMedium, color = colors.textPrimary)
            if (open == id) {
                Text(
                    listOfNotNull(
                        row.tool,
                        row.surface,
                        row.intent,
                        row.outcome,
                        if (row.dryRun) "dry run — recorded, not blocked" else null,
                    ).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textTertiary,
                )
                row.matched?.let {
                    Text(
                        (if (row.outcome == "refused") "Refused by " else "Decided by ") + row.source + ": " + it,
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.textSecondary,
                    )
                }
                row.failure?.let {
                    Text("Failed: $it", style = MaterialTheme.typography.bodySmall, color = colors.textDanger)
                }
                if (row.detail.isNotBlank()) {
                    Text(
                        row.detail,
                        modifier = Modifier
                            .padding(top = Halo1)
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(Halo2))
                            .background(colors.bgSubtle)
                            .padding(Halo2),
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        color = colors.textSecondary,
                    )
                }
            }
        }
    }
}

// -------------------------------------------------------------------------- usage

@Composable
private fun UsageTab(model: HaloViewModel) {
    val colors = LocalHaloColors.current
    var days by remember { mutableStateOf(7) }
    var rows by remember { mutableStateOf<List<com.halo.bot.core.UsageRow>>(emptyList()) }

    LaunchedEffect(days) {
        val since = System.currentTimeMillis() - days * 86_400_000L
        rows = withContext(Dispatchers.IO) { Halo.store.usage(since) }
    }

    val prompt = rows.sumOf { it.promptTokens.toLong() }
    val completion = rows.sumOf { it.completionTokens.toLong() }
    val seconds = rows.sumOf { it.seconds }

    Text(
        "Counted from what your model server reports. A local model costs nothing but time — the seconds are " +
            "the column that matters there.",
        modifier = Modifier.padding(horizontal = Halo4, vertical = Halo2),
        style = MaterialTheme.typography.bodySmall,
        color = colors.textTertiary,
    )
    HaloChoiceRow("Window", null, listOf("1" to "Today", "7" to "7 days", "30" to "30 days"), days.toString()) {
        days = it.toIntOrNull() ?: 7
    }

    KeyValueRow("Tokens generated", short(completion), bold = true)
    KeyValueRow("Tokens read", short(prompt))
    KeyValueRow("Model calls", rows.size.toString())
    KeyValueRow("Thinking time", "${Math.round(seconds / 60.0)}m")

    SectionLabel("By bot")
    val byAgent = rows.groupBy { it.agentId }
    if (byAgent.isEmpty()) {
        InfoCard("Nothing in this window yet.")
    }
    for ((agentId, agentRows) in byAgent.entries.sortedByDescending { it.value.sumOf { r -> r.completionTokens } }) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Halo4, vertical = Halo2),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    model.agent(agentId)?.name ?: "a deleted bot",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textPrimary,
                )
                Text(
                    "${agentRows.size} calls · ${Math.round(agentRows.sumOf { it.seconds })}s",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textTertiary,
                )
            }
            Text(
                short(agentRows.sumOf { it.promptTokens.toLong() }) + " in / " +
                    short(agentRows.sumOf { it.completionTokens.toLong() }) + " out",
                style = MaterialTheme.typography.bodySmall,
                color = colors.textSecondary,
            )
        }
    }
}

private fun short(n: Long): String = when {
    n >= 1_000_000 -> String.format(Locale.US, "%.1fM", n / 1_000_000.0)
    n >= 1_000 -> String.format(Locale.US, "%.1fk", n / 1_000.0)
    else -> n.toString()
}

// -------------------------------------------------------------------------- about

@Composable
private fun AboutTab() {
    val colors = LocalHaloColors.current
    Text(
        "Halo Bot — AI teammates that run on this phone. Each bot has its own box, memory, skills and routines, " +
            "and asks before it touches anything outside that box.",
        modifier = Modifier.padding(Halo4),
        style = MaterialTheme.typography.bodyMedium,
        color = colors.textSecondary,
    )
    KeyValueRow("Version", "0.1.0")
    KeyValueRow("Runs on", "Any OpenAI-compatible model with tool calling")
    KeyValueRow("Storage", Halo.store.root.absolutePath)
    KeyValueRow("Webhook listener", Halo.webhooks.url("…").ifEmpty { "not running" })
    KeyValueRow("Plugins", "MCP servers over Streamable HTTP")
    Text(
        "The Windows build is the same app: the same bots, the same memory, the same approval gate and the same " +
            "files on disk. A bot exported there imports here and keeps its voice, its memory and its routines.",
        modifier = Modifier.padding(Halo4),
        style = MaterialTheme.typography.bodySmall,
        color = colors.textTertiary,
    )
}
