package com.halo.bot.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.halo.bot.Halo
import com.halo.bot.core.Agent
import com.halo.bot.core.AgentStatus
import com.halo.bot.core.Role
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Which full-screen surface is in front. A phone has one window, so this is the whole router. */
sealed interface Screen {
    data object Setup : Screen
    data object List : Screen
    data class Chat(val id: String) : Screen
    data object Settings : Screen

    /** Carries where it was opened from: the plugin shelf is reachable from the list and from Settings. */
    data class Plugins(val back: Screen) : Screen
    data object Search : Screen
}

@Composable
fun HaloApp(model: HaloViewModel) {
    HaloTheme(model.settings.theme) {
        val colors = LocalHaloColors.current
        var screen: Screen by remember {
            mutableStateOf(if (model.settings.onboarded) Screen.List else Screen.Setup)
        }

        Box(modifier = Modifier.fillMaxSize().background(colors.bgBase)) {
            when (val current = screen) {
                is Screen.Setup -> SetupScreen(model) { screen = Screen.List }

                is Screen.List -> BotListScreen(
                    model = model,
                    onOpen = { id ->
                        model.select(id)
                        screen = Screen.Chat(id)
                    },
                    onSettings = { screen = Screen.Settings },
                    onPlugins = { screen = Screen.Plugins(Screen.List) },
                    onSearch = { screen = Screen.Search },
                )

                is Screen.Chat -> {
                    BackHandler { screen = Screen.List }
                    ChatScreen(model, current.id, onBack = { screen = Screen.List })
                }

                is Screen.Settings -> {
                    BackHandler { screen = Screen.List }
                    SettingsScreen(model, onBack = { screen = Screen.List }, onPlugins = { screen = Screen.Plugins(Screen.Settings) })
                }

                is Screen.Plugins -> {
                    BackHandler { screen = current.back }
                    PluginsScreen(model, onBack = { screen = current.back })
                }

                is Screen.Search -> {
                    BackHandler { screen = Screen.List }
                    SearchScreen(
                        model,
                        onBack = { screen = Screen.List },
                        onOpen = { id ->
                            model.select(id)
                            screen = Screen.Chat(id)
                        },
                    )
                }
            }
        }
    }
}

// --------------------------------------------------------------------- bot list

/**
 * The desktop's sidebar, as the phone's home screen.
 *
 * Everything the sidebar carries is here and carries the same meaning: pinned bots as a grid above
 * the list, user-made sections that collapse, a time and a preview per row, an unread dot, the rooms,
 * and the same right-click menu reached by a long press. The two builds are one product; a phone that
 * quietly dropped half of the first screen would not be.
 */
@Composable
private fun BotListScreen(
    model: HaloViewModel,
    onOpen: (String) -> Unit,
    onSettings: () -> Unit,
    onPlugins: () -> Unit,
    onSearch: () -> Unit,
) {
    val colors = LocalHaloColors.current
    val context = LocalContext.current
    var creating by remember { mutableStateOf(false) }
    var creatingChannel by remember { mutableStateOf(false) }
    var addMenu by remember { mutableStateOf(false) }
    var channelMenu by remember { mutableStateOf<com.halo.bot.core.Channel?>(null) }
    var exporting by remember { mutableStateOf<Agent?>(null) }
    var moving by remember { mutableStateOf<Agent?>(null) }

    /*
     * Export and import go through the system picker rather than a path.
     *
     * A `.halobot.json` is the same file the desktop build writes, so a bot really does move between
     * the two — but on Android the app cannot choose where it lands, and should not: the picker is the
     * grant.
     */
    val exportTo = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        val agent = exporting
        exporting = null
        if (uri != null && agent != null) {
            runCatching {
                context.contentResolver.openOutputStream(uri)?.use { it.write(Halo.exportBot(agent.id).toByteArray()) }
            }
        }
    }
    val importFrom = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            runCatching {
                val text = context.contentResolver.openInputStream(uri)?.use { String(it.readBytes()) }.orEmpty()
                Halo.importBot(text)?.let { model.refreshAgents(); onOpen(it.id) }
            }
        }
    }

    val visible = model.agents.filterNot { it.hidden }
    val pinned = visible.filter { it.pinned }
    val unpinned = visible.filterNot { it.pinned }
    val sections = model.settings.sections
    val sectioned = sections.flatMap { it.agentIds }.toSet()
    val loose = unpinned.filterNot { it.id in sectioned }
    val working = visible.count { it.status == AgentStatus.WORKING }

    Column(modifier = Modifier.fillMaxSize().statusBarsPadding()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = Halo4, end = Halo2, top = Halo2, bottom = Halo2),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Halo Bot", style = MaterialTheme.typography.titleLarge, color = colors.textPrimary)
                Text(
                    if (working > 0) "$working ${if (working == 1) "bot" else "bots"} working" else "All bots idle",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (working > 0) colors.textSuccess else colors.textTertiary,
                )
            }
            IconButton(onClick = onSearch) {
                Icon(Icons.Default.Search, "Search", tint = colors.textSecondary)
            }
            IconButton(onClick = { addMenu = true }) {
                Icon(Icons.Default.Add, "New bot, room or import", tint = colors.textSecondary)
            }
        }

        model.providerError?.let { error ->
            Column(
                modifier = Modifier
                    .padding(horizontal = Halo4, vertical = Halo1)
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(Halo3))
                    .background(colors.warningSubtle)
                    .padding(Halo3),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.WarningAmber, null, tint = colors.textWarning, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(Halo2))
                    Text(error, style = MaterialTheme.typography.bodySmall, color = colors.textWarning)
                }
                Row(modifier = Modifier.padding(top = Halo2), horizontalArrangement = Arrangement.spacedBy(Halo2)) {
                    HaloButton("Retry", { model.refreshProvider() })
                    HaloButton("Open settings", onSettings, primary = true)
                }
            }
        }

        LazyColumn(modifier = Modifier.weight(1f), contentPadding = PaddingValues(bottom = Halo4)) {
            if (pinned.isNotEmpty()) {
                item {
                    FlowRow(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = Halo3, vertical = Halo2),
                        horizontalArrangement = Arrangement.spacedBy(Halo2),
                        verticalArrangement = Arrangement.spacedBy(Halo2),
                    ) {
                        for (agent in pinned) {
                            Column(
                                modifier = Modifier
                                    .widthIn(min = 104.dp, max = 104.dp)
                                    .clip(RoundedCornerShape(Halo3))
                                    .background(colors.bgSubtle)
                                    .combinedClick(onClick = { onOpen(agent.id) }, onLongClick = { moving = agent })
                                    .padding(Halo3),
                                horizontalAlignment = Alignment.CenterHorizontally,
                            ) {
                                Avatar(agent, size = 36.dp, showStatus = true)
                                Spacer(Modifier.height(Halo1))
                                Text(
                                    if (agent.status == AgentStatus.WORKING) "working…" else agent.name,
                                    style = MaterialTheme.typography.labelMedium,
                                    color = if (agent.status == AgentStatus.WORKING) colors.textSuccess else colors.textPrimary,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }
            }

            if (model.channels.isNotEmpty()) {
                item { ListLabel("Rooms") }
                items(model.channels, key = { it.id }) { channel ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .combinedClick(onClick = { onOpen(channel.id) }, onLongClick = { channelMenu = channel })
                            .padding(horizontal = Halo4, vertical = Halo3),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Default.Forum, null, tint = colors.textTertiary, modifier = Modifier.size(24.dp))
                        Spacer(Modifier.width(Halo3))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(channel.name, style = MaterialTheme.typography.titleSmall, color = colors.textPrimary)
                            Text(
                                channel.memberIds.mapNotNull { model.agent(it)?.name }.joinToString(", ")
                                    .ifEmpty { "no members yet" },
                                style = MaterialTheme.typography.bodySmall,
                                color = colors.textTertiary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        Text(
                            timeLabel(channel.lastActivityAt),
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.textTertiary,
                        )
                        UnreadBadge(model.unread[channel.id] ?: 0)
                    }
                }
            }

            for (section in sections) {
                val members = section.agentIds.mapNotNull { id -> unpinned.firstOrNull { it.id == id } }
                if (members.isEmpty()) continue
                item(key = "section-" + section.id) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                model.saveSettings { s ->
                                    s.copy(
                                        sections = s.sections.map {
                                            if (it.id == section.id) it.copy(collapsed = !it.collapsed) else it
                                        },
                                    )
                                }
                            }
                            .padding(start = Halo3, end = Halo4, top = Halo3, bottom = Halo1),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            if (section.collapsed) Icons.Default.KeyboardArrowRight else Icons.Default.KeyboardArrowDown,
                            null,
                            tint = colors.textTertiary,
                            modifier = Modifier.size(18.dp),
                        )
                        Text(
                            section.name.uppercase(),
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.textTertiary,
                        )
                    }
                }
                if (!section.collapsed) {
                    items(members, key = { "s-" + it.id }) { agent ->
                        BotRow(model, agent, onOpen) { moving = agent }
                    }
                }
            }

            if (loose.isNotEmpty() && sections.any { it.agentIds.isNotEmpty() }) {
                item { ListLabel("Everything else") }
            }
            items(loose, key = { it.id }) { agent ->
                BotRow(model, agent, onOpen) { moving = agent }
            }

            if (visible.isEmpty() && model.channels.isEmpty()) {
                item {
                    Text(
                        "No bots yet. Tap + to make one.",
                        modifier = Modifier.fillMaxWidth().padding(Halo6),
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.textTertiary,
                    )
                }
            }
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(colors.bgSubtle)
                .navigationBarsPadding()
                .padding(horizontal = Halo2, vertical = Halo1),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FooterButton(Icons.Default.Extension, "Plugins", Modifier.weight(1f), onPlugins)
            FooterButton(Icons.Default.Settings, "Settings", Modifier.weight(1f), onSettings)
        }
    }

    if (addMenu) {
        HaloSheet({ addMenu = false }) {
            SheetTitle("Add")
            SheetAction("New bot") { addMenu = false; creating = true }
            SheetAction("New room") { addMenu = false; creatingChannel = true }
            SheetAction("Import a bot…") { addMenu = false; importFrom.launch(arrayOf("application/json", "*/*")) }
            Spacer(Modifier.height(Halo4))
        }
    }

    if (creating) {
        NewBotSheet(
            onDismiss = { creating = false },
            onCreate = { draft ->
                creating = false
                onOpen(model.createAgent(draft).id)
            },
        )
    }
    if (creatingChannel) {
        NewChannelSheet(
            agents = visible,
            onDismiss = { creatingChannel = false },
            onCreate = { name, members ->
                creatingChannel = false
                model.createChannel(name, members)
            },
        )
    }
    channelMenu?.let { channel ->
        ChannelSheet(model, channel) { channelMenu = null }
    }
    moving?.let { agent ->
        BotMenuSheet(
            agent = agent,
            sections = sections,
            onDismiss = { moving = null },
            onPin = { moving = null; model.updateAgent(agent.id) { it.copy(pinned = !it.pinned) } },
            onDuplicate = { moving = null; model.duplicateAgent(agent.id) },
            onHide = { moving = null; model.updateAgent(agent.id) { it.copy(hidden = true) } },
            onExport = { moving = null; exporting = agent; exportTo.launch(safeFileName(agent.name)) },
            onSection = { sectionId ->
                moving = null
                model.moveToSection(agent.id, sectionId)
            },
            onDelete = { moving = null; model.deleteAgent(agent.id) },
        )
    }
}

/** A file name a document picker will accept, from a bot name that might be anything. */
private fun safeFileName(name: String): String =
    name.replace(Regex("[^\\p{L}\\p{N} _-]"), "").trim().ifEmpty { "bot" } + ".halobot.json"

@Composable
private fun ListLabel(text: String) {
    Text(
        text.uppercase(),
        modifier = Modifier.padding(start = Halo4, top = Halo4, bottom = Halo1),
        style = MaterialTheme.typography.labelSmall,
        color = LocalHaloColors.current.textTertiary,
    )
}

/** Today shows a clock, anything older shows a date — the desktop sidebar's rule. */
private fun timeLabel(at: Long): String {
    if (at <= 0) return ""
    val now = java.util.Calendar.getInstance()
    val then = java.util.Calendar.getInstance().apply { timeInMillis = at }
    val sameDay = now.get(java.util.Calendar.YEAR) == then.get(java.util.Calendar.YEAR) &&
        now.get(java.util.Calendar.DAY_OF_YEAR) == then.get(java.util.Calendar.DAY_OF_YEAR)
    val format = if (sameDay) SimpleDateFormat("HH:mm", Locale.getDefault()) else SimpleDateFormat("dd/MM", Locale.getDefault())
    return format.format(Date(at))
}

private fun previewOf(model: HaloViewModel, id: String): String {
    val last = model.messages(id).lastOrNull { it.text.isNotBlank() && it.role != Role.SYSTEM } ?: return ""
    val prefix = if (last.role == Role.USER) "You: " else ""
    return prefix + last.text.replace(Regex("\\s+"), " ").take(90)
}

@Composable
private fun FooterButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    val colors = LocalHaloColors.current
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(Halo2))
            .clickable(onClick = onClick)
            .height(TouchTarget)
            .padding(horizontal = Halo3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        Icon(icon, null, tint = colors.textSecondary, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(Halo2))
        Text(label, style = MaterialTheme.typography.labelLarge, color = colors.textSecondary)
    }
}

@Composable
private fun BotRow(model: HaloViewModel, agent: Agent, onOpen: (String) -> Unit, onLongPress: () -> Unit) {
    val colors = LocalHaloColors.current
    val pending = model.approvals.firstOrNull { it.agentId == agent.id }
    val unread = model.unread[agent.id] ?: 0
    val preview = previewOf(model, agent.id)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClick(onClick = { onOpen(agent.id) }, onLongClick = onLongPress)
            .padding(horizontal = Halo4, vertical = Halo3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(agent, size = 44.dp, showStatus = true)
        Spacer(Modifier.width(Halo3))
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    agent.name,
                    style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                    color = colors.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Spacer(Modifier.weight(1f))
                Text(
                    timeLabel(agent.lastActivityAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textTertiary,
                )
            }
            Text(
                when {
                    pending != null -> "Permission required: " + pending.summary
                    agent.status == AgentStatus.WORKING -> "working…"
                    agent.status == AgentStatus.WAITING -> "waiting for you"
                    else -> preview.ifEmpty { agent.title.ifEmpty { "no messages yet" } }
                },
                style = MaterialTheme.typography.bodySmall,
                color = when {
                    pending != null -> colors.textWarning
                    agent.status == AgentStatus.WORKING -> colors.textSuccess
                    else -> colors.textTertiary
                },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        UnreadBadge(unread)
    }
}

@Composable
fun UnreadBadge(count: Int) {
    val colors = LocalHaloColors.current
    AnimatedVisibility(visible = count > 0) {
        Box(
            modifier = Modifier
                .clip(RoundedCornerShape(50))
                .background(colors.accent)
                .padding(horizontal = Halo2, vertical = 2.dp),
        ) {
            Text(
                if (count > 9) "9+" else count.toString(),
                style = MaterialTheme.typography.labelSmall,
                color = androidx.compose.ui.graphics.Color.White,
            )
        }
    }
}

/** The desktop's channel details pane, as a sheet: members in and out, and the delete. */
@Composable
private fun ChannelSheet(model: HaloViewModel, channel: com.halo.bot.core.Channel, onDismiss: () -> Unit) {
    val colors = LocalHaloColors.current
    var confirming by remember { mutableStateOf(false) }
    val members = channel.memberIds.mapNotNull { model.agent(it) }
    val candidates = model.agents.filterNot { it.id in channel.memberIds }

    HaloSheet(onDismiss) {
        SheetTitle(channel.name)
        SectionLabel("Members")
        for (member in members) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = Halo4, vertical = Halo2),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Avatar(member, size = 28.dp)
                Spacer(Modifier.width(Halo3))
                Text(member.name, style = MaterialTheme.typography.bodyMedium, color = colors.textPrimary, modifier = Modifier.weight(1f))
                Text(
                    "Remove",
                    modifier = Modifier.clickable { model.setChannelMembers(channel.id, channel.memberIds - member.id) },
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.textDanger,
                )
            }
        }
        if (candidates.isNotEmpty()) {
            SectionLabel("Add a bot")
            for (agent in candidates) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { model.setChannelMembers(channel.id, channel.memberIds + agent.id) }
                        .padding(horizontal = Halo4, vertical = Halo2),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Avatar(agent, size = 24.dp)
                    Spacer(Modifier.width(Halo3))
                    Text(agent.name, style = MaterialTheme.typography.bodyMedium, color = colors.textSecondary)
                }
            }
        }
        Text(
            "Mention a bot with @name to address it directly.",
            modifier = Modifier.padding(horizontal = Halo4, vertical = Halo2),
            style = MaterialTheme.typography.bodySmall,
            color = colors.textTertiary,
        )
        if (confirming) {
            InfoCard("Deleting \"${channel.name}\" removes the room and its transcript. The bots themselves stay.", tone = "danger")
            SheetAction("Yes, delete the room", danger = true) {
                model.deleteChannel(channel.id)
                onDismiss()
            }
        } else {
            SheetAction("Delete room…", danger = true) { confirming = true }
        }
        Spacer(Modifier.height(Halo4))
    }
}
