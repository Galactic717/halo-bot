package com.halo.bot.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.filled.PanTool
import androidx.compose.material.icons.filled.School
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.halo.bot.Halo
import com.halo.bot.core.Agent
import com.halo.bot.core.clampTrigger
import com.halo.bot.core.Routine
import com.halo.bot.core.RoutineTrigger
import com.halo.bot.core.describeTriggers
import com.halo.bot.core.shortUri
import com.halo.bot.platform.teachPrompt
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.UUID

private enum class DetailTab(val label: String) {
    ABOUT("About"),
    COMPUTER("Computer"),
    ROUTINES("Routines"),
    SKILLS("Skills"),
    SETTINGS("Settings"),
}

@Composable
fun DetailsSheet(model: HaloViewModel, agent: Agent, onDismiss: () -> Unit) {
    val colors = LocalHaloColors.current
    var tab by remember { mutableStateOf(DetailTab.ABOUT) }

    HaloSheet(onDismiss) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Halo4, vertical = Halo2),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Avatar(agent, size = 40.dp, showStatus = true)
            Spacer(Modifier.width(Halo3))
            Column(modifier = Modifier.weight(1f)) {
                Text(agent.name, style = MaterialTheme.typography.titleMedium, color = colors.textPrimary)
                Text(
                    agent.title.ifEmpty { agent.status.name.lowercase() },
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textTertiary,
                )
            }
        }

        Row(
            modifier = Modifier
                .padding(horizontal = Halo4)
                .fillMaxWidth()
                .clip(RoundedCornerShape(Halo2))
                .background(colors.bgSubtle)
                .padding(Halo1),
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            for (option in DetailTab.entries) {
                val active = option == tab
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(Halo1 + 2.dp))
                        .background(if (active) colors.fillGhostSelected else Color.Transparent)
                        .clickable { tab = option }
                        .heightIn(min = 38.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        option.label,
                        style = MaterialTheme.typography.labelMedium,
                        color = if (active) colors.textPrimary else colors.textSecondary,
                    )
                }
            }
        }

        Column(modifier = Modifier.heightIn(max = 560.dp).verticalScroll(rememberScrollState())) {
            when (tab) {
                DetailTab.ABOUT -> AboutTab(model, agent)
                DetailTab.COMPUTER -> ComputerTab(model, agent)
                DetailTab.ROUTINES -> RoutinesTab(model, agent)
                DetailTab.SKILLS -> SkillsTab(agent)
                DetailTab.SETTINGS -> BotSettingsTab(model, agent)
            }
            Spacer(Modifier.height(Halo6))
        }
    }
}

// ------------------------------------------------------------------------ about

@Composable
private fun AboutTab(model: HaloViewModel, agent: Agent) {
    val colors = LocalHaloColors.current
    var memory by remember(agent.id) { mutableStateOf(Halo.runner.memory(agent.id).exportText()) }
    var editing by remember { mutableStateOf(false) }
    val tasks = remember(agent.id) { Halo.runner.listTasks(agent.id) }

    if (agent.description.isNotBlank()) {
        SectionLabel("What it is for")
        Text(
            agent.description,
            modifier = Modifier.padding(horizontal = Halo4),
            style = MaterialTheme.typography.bodyMedium,
            color = colors.textSecondary,
        )
    }

    SectionLabel("Its box")
    Text(
        Halo.store.boxDir(agent.id).absolutePath,
        modifier = Modifier.padding(horizontal = Halo4),
        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
        color = colors.textTertiary,
    )

    if (tasks.isNotEmpty()) {
        SectionLabel("Running now")
        for (task in tasks) {
            Row(modifier = Modifier.fillMaxWidth().padding(horizontal = Halo4, vertical = Halo1)) {
                Text(
                    "${task["kind"]} · ${task["description"]}",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textSecondary,
                    modifier = Modifier.weight(1f),
                )
                Text("${task["seconds"]}s", style = MaterialTheme.typography.labelSmall, color = colors.textTertiary)
            }
        }
    }

    SectionLabel("Memory")
    if (editing) {
        HaloField("Facts, one per line as tier: fact", memory, { memory = it }, singleLine = false)
        Row(modifier = Modifier.padding(Halo4), horizontalArrangement = Arrangement.spacedBy(Halo2)) {
            HaloButton("Cancel", { editing = false; memory = Halo.runner.memory(agent.id).exportText() }, Modifier.weight(1f))
            HaloButton(
                "Save",
                {
                    Halo.runner.memory(agent.id).importText(memory)
                    editing = false
                },
                Modifier.weight(1f),
                primary = true,
            )
        }
    } else {
        Text(
            memory.ifBlank { "Nothing remembered yet. It fills in on its own after the first few exchanges." },
            modifier = Modifier.padding(horizontal = Halo4),
            style = MaterialTheme.typography.bodySmall,
            color = colors.textTertiary,
        )
        Row(modifier = Modifier.padding(Halo4)) {
            HaloButton("Edit memory", { editing = true })
        }
    }
}

// --------------------------------------------------------------------- computer

@Composable
private fun ComputerTab(model: HaloViewModel, agent: Agent) {
    val colors = LocalHaloColors.current
    val scope = rememberCoroutineScope()
    val control = model.control[agent.id]
    val human = control?.holder == "human"
    val teaching = model.teaching?.first == agent.id

    LaunchedEffect(agent.id) { Halo.computer.ensureView(agent.id) }
    LaunchedEffect(agent.id) {
        Halo.computer.visibleAgentId = agent.id
    }

    control?.instruction?.takeIf { control.requested }?.let { instruction ->
        InfoCard("$instruction — the browser is yours until you hand it back.", tone = "warning")
    }

    Box(
        modifier = Modifier
            .padding(horizontal = Halo4, vertical = Halo2)
            .fillMaxWidth()
            .height(320.dp)
            .clip(RoundedCornerShape(Halo3))
            .border(1.dp, colors.borderWeak, RoundedCornerShape(Halo3))
            .background(colors.bgBase),
    ) {
        AndroidView(
            modifier = Modifier.fillMaxWidth().height(320.dp),
            factory = { context ->
                // The bot's WebView itself, not a screenshot of it: the point of the pane is that the
                // user can watch the real page and take the wheel on it.
                val view = Halo.computer.viewFor(agent.id) ?: android.webkit.WebView(context)
                (view.parent as? android.view.ViewGroup)?.removeView(view)
                view
            },
            update = { view ->
                // While the bot has the wheel the pane is a window, not a control surface. Letting a
                // stray tap land on the page mid-turn is the same failure as the desktop build's "one
                // browser has one driver", from the other side.
                view.isEnabled = human
                view.setOnTouchListener { _, _ -> !human }
            },
        )
    }

    Text(
        model.browserUrl[agent.id].orEmpty().ifEmpty { "about:blank" },
        modifier = Modifier.padding(horizontal = Halo4),
        style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
        color = colors.textTertiary,
        maxLines = 1,
    )

    Row(
        modifier = Modifier.padding(Halo4).fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(Halo2),
    ) {
        HaloButton(
            if (human) "Give it back" else "Take over",
            {
                if (human) Halo.computer.releaseControl(agent.id) else Halo.computer.takeControl(agent.id)
            },
            Modifier.weight(1f),
            primary = !human,
        )
        HaloButton(
            if (teaching) "Stop recording" else "Teach a task",
            {
                scope.launch {
                    if (teaching) {
                        val result = Halo.computer.stopTeaching()
                        if (result != null) {
                            Halo.runner.submitSystemTurn(
                                result.first,
                                teachPrompt(result.second),
                                "Task demonstration finished",
                            )
                        }
                    } else {
                        Halo.computer.takeControl(agent.id)
                        Halo.computer.startTeaching(agent.id)
                    }
                }
            },
            Modifier.weight(1f),
        )
    }

    if (teaching) {
        InfoCard(
            "Recording. Do the task once in the pane above, then press stop — Halo hands the trace to " +
                agent.name + " and it saves the steps as a skill. Passwords are never recorded.",
            tone = "success",
        )
    }
}

// --------------------------------------------------------------------- routines

@Composable
private fun RoutinesTab(model: HaloViewModel, agent: Agent) {
    val colors = LocalHaloColors.current
    val routines = model.routines.filter { it.agentId == agent.id }
    var editing by remember { mutableStateOf<Routine?>(null) }

    if (routines.isEmpty()) {
        Text(
            "No routines. A routine fires on a schedule and runs a prompt as if you had sent it.",
            modifier = Modifier.padding(Halo4),
            style = MaterialTheme.typography.bodyMedium,
            color = colors.textTertiary,
        )
    }

    for (routine in routines) {
        Column(
            modifier = Modifier
                .padding(horizontal = Halo4, vertical = Halo1)
                .fillMaxWidth()
                .clip(RoundedCornerShape(Halo3))
                .background(colors.bgSubtle)
                .clickable { editing = routine }
                .padding(Halo3),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    routine.name,
                    style = MaterialTheme.typography.titleSmall,
                    color = if (routine.enabled) colors.textPrimary else colors.textTertiary,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    describeTriggers(routine.triggers),
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textTertiary,
                )
            }
            Text(
                routine.prompt.take(120),
                modifier = Modifier.padding(top = Halo1),
                style = MaterialTheme.typography.bodySmall,
                color = colors.textTertiary,
            )
            routine.runs.lastOrNull()?.let { run ->
                Text(
                    (if (run.status == "ok") "last run ok" else "last run failed") + (run.note?.let { " — " + it.take(80) } ?: ""),
                    modifier = Modifier.padding(top = Halo1),
                    style = MaterialTheme.typography.labelSmall,
                    color = if (run.status == "ok") colors.textTertiary else colors.textDanger,
                )
            }
            if (!routine.enabled) {
                Text(
                    "Paused — tap to look at it and turn it back on.",
                    modifier = Modifier.padding(top = Halo1),
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textWarning,
                )
            }
        }
    }

    Row(modifier = Modifier.padding(Halo4)) {
        HaloButton("New routine", {
            editing = Routine(
                id = UUID.randomUUID().toString(),
                agentId = agent.id,
                name = "",
                prompt = "",
                triggers = listOf(RoutineTrigger(kind = "daily", hour = 9, minute = 0)),
                createdAt = System.currentTimeMillis(),
            )
        })
    }

    editing?.let { routine ->
        RoutineEditor(
            model = model,
            routine = routine,
            onDismiss = { editing = null },
        )
    }
}

@Composable
private fun RoutineEditor(model: HaloViewModel, routine: Routine, onDismiss: () -> Unit) {
    val colors = LocalHaloColors.current
    var name by remember { mutableStateOf(routine.name) }
    var prompt by remember { mutableStateOf(routine.prompt) }
    var kind by remember { mutableStateOf(routine.triggers.firstOrNull()?.kind ?: "daily") }
    var minutes by remember { mutableStateOf((routine.triggers.firstOrNull()?.everyMinutes ?: 60).toString()) }
    var time by remember {
        val t = routine.triggers.firstOrNull()
        mutableStateOf(String.format("%02d:%02d", t?.hour ?: 9, t?.minute ?: 0))
    }
    var enabled by remember { mutableStateOf(routine.enabled) }
    var continuity by remember { mutableStateOf(routine.continuity) }
    var weekday by remember { mutableStateOf(routine.triggers.firstOrNull { it.kind == "weekly" }?.weekday ?: 1) }
    var cap by remember { mutableStateOf((routine.maxRunsPerDay ?: 24).toString()) }
    val token = remember { routine.triggers.firstOrNull { it.kind == "webhook" }?.token ?: UUID.randomUUID().toString().replace("-", "") }

    fun trigger(): RoutineTrigger {
        val (h, m) = time.split(":").let { (it.getOrNull(0)?.toIntOrNull() ?: 9) to (it.getOrNull(1)?.toIntOrNull() ?: 0) }
        return when (kind) {
            "interval" -> clampTrigger(RoutineTrigger(kind = "interval", everyMinutes = minutes.toIntOrNull() ?: 60))
            "webhook" -> RoutineTrigger(kind = "webhook", token = token)
            "weekly" -> RoutineTrigger(kind = "weekly", weekday = weekday, hour = h, minute = m)
            "weekdays" -> RoutineTrigger(kind = "weekdays", hour = h, minute = m)
            else -> RoutineTrigger(kind = "daily", hour = h, minute = m)
        }
    }

    HaloSheet(onDismiss) {
        SheetTitle(if (routine.name.isBlank()) "New routine" else routine.name)
        HaloField("Name", name, { name = it }, placeholder = "Morning check")
        HaloField(
            "What it does",
            prompt,
            { prompt = it },
            singleLine = false,
            hint = "Written to your future self. It arrives as a message from the system, not from the user.",
        )
        HaloWrapChoice(
            "When",
            null,
            listOf(
                "daily" to "Daily",
                "weekdays" to "Weekdays",
                "weekly" to "Weekly",
                "interval" to "Every N min",
                "webhook" to "Webhook",
            ),
            kind,
        ) { kind = it }

        when (kind) {
            "interval" -> HaloField("Every N minutes", minutes, { minutes = it }, numeric = true)
            "webhook" -> {
                val url = Halo.webhooks.url(token)
                InfoCard(
                    if (url.isBlank()) {
                        "The listener could not bind a port, so this routine has no address yet."
                    } else {
                        "Anything on this phone that can make an HTTP request starts it — Tasker, MacroDroid, a Shortcut:\n\n$url\n\nLoopback only: nothing off this phone can reach it, and the token is the whole address."
                    },
                )
            }

            else -> {
                if (kind == "weekly") {
                    HaloWrapChoice(
                        "Day",
                        null,
                        listOf(
                            "1" to "Mon", "2" to "Tue", "3" to "Wed", "4" to "Thu",
                            "5" to "Fri", "6" to "Sat", "0" to "Sun",
                        ),
                        weekday.toString(),
                    ) { weekday = it.toIntOrNull() ?: 1 }
                }
                HaloField("Time (HH:MM)", time, { time = it }, placeholder = "09:00")
            }
        }

        HaloField(
            "Most runs per day",
            cap,
            { cap = it },
            numeric = true,
            hint = "A safety valve: a misconfigured routine cannot fire more than this in a day, and pauses itself " +
                "with one line rather than spending the allowance in an hour.",
        )

        HaloSwitchRow("Enabled", null, enabled) { enabled = it }
        HaloSwitchRow(
            "Feed it its own last report",
            "So a watcher says \"still down\" once instead of every hour.",
            continuity,
        ) { continuity = it }

        if (routine.runs.isNotEmpty()) {
            SectionLabel("Run history")
            for (run in routine.runs.takeLast(8).reversed()) {
                Text(
                    (if (run.status == "ok") "✓ " else "✕ ") +
                        java.text.SimpleDateFormat("dd MMM HH:mm", java.util.Locale.getDefault()).format(java.util.Date(run.at)) +
                        (run.note?.let { " — " + it.take(90) } ?: ""),
                    modifier = Modifier.padding(horizontal = Halo4, vertical = 2.dp),
                    style = MaterialTheme.typography.labelSmall,
                    color = if (run.status == "ok") colors.textTertiary else colors.textDanger,
                )
            }
        }

        Row(modifier = Modifier.padding(Halo4), horizontalArrangement = Arrangement.spacedBy(Halo2)) {
            if (routine.name.isNotBlank()) {
                HaloButton("Delete", { model.deleteRoutine(routine.id); onDismiss() }, Modifier.weight(1f), danger = true)
            }
            HaloButton("Run now", { model.runRoutineNow(routine.id); onDismiss() }, Modifier.weight(1f))
            HaloButton(
                "Save",
                {
                    model.saveRoutine(
                        routine.copy(
                            name = name.trim().ifEmpty { "Routine" },
                            prompt = prompt.trim(),
                            triggers = listOf(trigger()),
                            enabled = enabled,
                            continuity = continuity,
                            maxRunsPerDay = cap.toIntOrNull()?.coerceAtLeast(1) ?: 24,
                            failureStreak = 0,
                            nextRunAt = null,
                        ),
                    )
                    onDismiss()
                },
                Modifier.weight(1f),
                primary = true,
                enabled = prompt.isNotBlank(),
            )
        }
    }
}

// ----------------------------------------------------------------------- skills

@Composable
private fun SkillsTab(agent: Agent) {
    val colors = LocalHaloColors.current
    var skills by remember(agent.id) { mutableStateOf(Halo.runner.skills(agent.id).list()) }

    if (skills.isEmpty()) {
        Text(
            "No skills yet. A bot saves one when it works out how to do something it will be asked for again — " +
                "or you can show it once with Teach a task on the Computer tab.",
            modifier = Modifier.padding(Halo4),
            style = MaterialTheme.typography.bodyMedium,
            color = colors.textTertiary,
        )
    }

    for (skill in skills) {
        var open by remember(skill.id) { mutableStateOf(false) }
        Column(
            modifier = Modifier
                .padding(horizontal = Halo4, vertical = Halo1)
                .fillMaxWidth()
                .clip(RoundedCornerShape(Halo3))
                .background(colors.bgSubtle)
                .clickable { open = !open }
                .padding(Halo3),
        ) {
            Text(skill.name, style = MaterialTheme.typography.titleSmall, color = colors.textPrimary)
            Text(skill.description, style = MaterialTheme.typography.bodySmall, color = colors.textTertiary)
            if (open) {
                MarkdownText(skill.body, modifier = Modifier.padding(top = Halo2), color = colors.textSecondary)
                Row(modifier = Modifier.padding(top = Halo2)) {
                    HaloButton(
                        "Delete",
                        {
                            Halo.runner.skills(agent.id).delete(skill.id)
                            skills = Halo.runner.skills(agent.id).list()
                        },
                        danger = true,
                    )
                }
            }
        }
    }
}

// --------------------------------------------------------------- per-bot settings

@Composable
private fun BotSettingsTab(model: HaloViewModel, agent: Agent) {
    val colors = LocalHaloColors.current
    var name by remember(agent.id) { mutableStateOf(agent.name) }
    var title by remember(agent.id) { mutableStateOf(agent.title) }
    var description by remember(agent.id) { mutableStateOf(agent.description) }
    var modelId by remember(agent.id) { mutableStateOf(agent.model.orEmpty()) }
    var endpoint by remember(agent.id) { mutableStateOf(agent.endpoint.orEmpty()) }
    var deleting by remember(agent.id) { mutableStateOf(false) }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri != null) {
            Halo.storage.persist(uri)
            model.updateAgent(agent.id) { it.copy(allowedPaths = (it.allowedPaths + uri.toString()).distinct()) }
        }
    }

    HaloField("Name", name, { name = it })
    HaloField("Role", title, { title = it })
    HaloField("What it is for", description, { description = it }, singleLine = false)

    SectionLabel("Avatar")
    Row(
        modifier = Modifier.padding(horizontal = Halo4).fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(Halo2),
    ) {
        for (option in AVATAR_COLORS.keys) {
            Box(
                modifier = Modifier
                    .size(30.dp)
                    .clip(RoundedCornerShape(50))
                    .background(avatarColor(option))
                    .border(
                        width = if (option == agent.avatar.color) 2.dp else 0.dp,
                        color = if (option == agent.avatar.color) colors.textPrimary else Color.Transparent,
                        shape = RoundedCornerShape(50),
                    )
                    .clickable { model.updateAgent(agent.id) { it.copy(avatar = it.avatar.copy(color = option)) } },
            )
        }
    }

    PersonaPicker(
        selectedId = agent.personaId,
        custom = agent.persona,
        onPreset = { id -> model.updateAgent(agent.id) { it.copy(personaId = id, persona = null) } },
        onCustom = { text -> model.updateAgent(agent.id) { it.copy(persona = text) } },
    )

    SectionLabel("On your phone")
    HaloChoiceRow(
        "What this bot may do outside its box",
        "Overrides the global setting for this bot alone.",
        listOf("inherit" to "Global", "ask" to "Ask", "allow" to "Allow", "never" to "Never"),
        agent.localExecution ?: "inherit",
    ) { value ->
        model.updateAgent(agent.id) { it.copy(localExecution = if (value == "inherit") null else value) }
    }

    SectionLabel("Folders it may use freely")
    Text(
        "Anything inside these runs without an approval prompt; everything else still asks. Android holds the " +
            "grant, so a folder you have not picked is unreachable whatever a bot tries.",
        modifier = Modifier.padding(horizontal = Halo4),
        style = MaterialTheme.typography.bodySmall,
        color = colors.textTertiary,
    )
    for (path in agent.allowedPaths) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Halo4, vertical = Halo1),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(shortUri(path), style = MaterialTheme.typography.bodyMedium, color = colors.textPrimary, modifier = Modifier.weight(1f))
            Text(
                "Remove",
                modifier = Modifier.clickable {
                    model.updateAgent(agent.id) { it.copy(allowedPaths = it.allowedPaths - path) }
                },
                style = MaterialTheme.typography.labelMedium,
                color = colors.textDanger,
            )
        }
    }
    Row(modifier = Modifier.padding(Halo4)) {
        HaloButton("Grant a folder", { picker.launch(null) })
    }

    SectionLabel("Model")
    HaloField(
        "Model for this bot",
        modelId,
        { modelId = it },
        placeholder = model.settings.provider.model,
        hint = "Blank uses the global model. A heavy bot can run a bigger model than a watcher.",
    )

    SectionLabel("Somebody else's agent")
    HaloField(
        "AG-UI endpoint",
        endpoint,
        { endpoint = it },
        placeholder = "https://…/agent",
        hint = "Blank means Halo runs this bot's turns itself. With an endpoint, the agent on the other end " +
            "runs them on any framework — and every tool call it makes still comes back through this phone's " +
            "approval gate and audit trail.",
    )

    SectionLabel("Notifications")
    HaloSwitchRow(
        "Tell me when this bot sends something",
        "Only while Halo is not the app on screen.",
        agent.notifications,
    ) { value -> model.updateAgent(agent.id) { it.copy(notifications = value) } }

    Row(modifier = Modifier.padding(Halo4), horizontalArrangement = Arrangement.spacedBy(Halo2)) {
        HaloButton(
            "Save",
            {
                model.updateAgent(agent.id) {
                    it.copy(
                        name = name.trim().ifEmpty { it.name },
                        title = title.trim(),
                        description = description.trim(),
                        model = modelId.trim().takeIf { m -> m.isNotEmpty() },
                        endpoint = endpoint.trim().takeIf { e -> e.isNotEmpty() },
                    )
                }
            },
            Modifier.weight(1f),
            primary = true,
        )
    }

    SectionLabel("Box")
    Text(
        Halo.store.boxDir(agent.id).absolutePath,
        modifier = Modifier.padding(horizontal = Halo4),
        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
        color = colors.textTertiary,
    )

    if (deleting) {
        InfoCard(
            "Deleting ${agent.name} removes its chat, memory, skills and box. This cannot be undone.",
            tone = "danger",
        )
        Row(modifier = Modifier.padding(Halo4), horizontalArrangement = Arrangement.spacedBy(Halo2)) {
            HaloButton("Keep it", { deleting = false }, Modifier.weight(1f))
            HaloButton("Delete ${agent.name}", { model.deleteAgent(agent.id) }, Modifier.weight(1f), danger = true)
        }
    } else {
        Row(modifier = Modifier.padding(Halo4)) {
            HaloButton("Delete bot…", { deleting = true }, danger = true)
        }
    }
}
