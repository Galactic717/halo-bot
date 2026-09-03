package com.halo.bot.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import com.halo.bot.Halo
import com.halo.bot.core.Agent
import com.halo.bot.core.Attachment
import com.halo.bot.core.ApprovalDecision
import com.halo.bot.core.ApprovalRequest
import com.halo.bot.core.Message
import com.halo.bot.core.Role
import com.halo.bot.core.ToolCallRecord
import com.halo.bot.core.Widget
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/*
 * Punctuation the layout uses as text. Named rather than inlined so a search for "why is there a
 * paperclip in the composer" lands on one line, and so nothing in the layout depends on an editor
 * getting an emoji through a patch intact.
 */
private const val CLIP_GLYPH = "\uD83D\uDCCE"
private const val CROSS_GLYPH = "\u00D7"
private const val SLASH = "/"

/** What a long press offers. Six is a row on the narrowest phone Halo supports. */
private val REACTIONS = listOf("\uD83D\uDC4D", "\uD83C\uDF89", "\u2764\uFE0F", "\uD83D\uDE02", "\uD83E\uDD14", "\uD83D\uDC40")

@Composable
fun ChatScreen(model: HaloViewModel, conversationId: String, onBack: () -> Unit) {
    val colors = LocalHaloColors.current
    val agent = model.agent(conversationId)
    val channel = model.channel(conversationId)
    val messages = model.messages(conversationId)
    val listState = rememberLazyListState()
    var details by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf("") }
    var showActivity by remember { mutableStateOf(false) }
    var menuFor by remember { mutableStateOf<Message?>(null) }
    var attachments by remember { mutableStateOf(listOf<Attachment>()) }
    val keyboard = LocalSoftwareKeyboardController.current
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current

    /*
     * An attachment is copied into the bot's box before it is mentioned.
     *
     * A content uri from the picker is a one-shot grant this process holds and the bot cannot open
     * with Read; a file in its own box is one it can. So the copy is the attachment, and the message
     * names a path the bot can actually act on.
     */
    val attach = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            runCatching {
                val name = Halo.storage.describe(uri.toString())?.name
                    ?: uri.lastPathSegment.orEmpty().substringAfterLast(SLASH).ifBlank { "attachment" }
                val dest = File(Halo.store.boxDir(conversationId), "incoming/" + name)
                dest.parentFile?.mkdirs()
                context.contentResolver.openInputStream(uri)?.use { input ->
                    dest.outputStream().use { output -> input.copyTo(output) }
                }
                attachments = attachments + Attachment(dest.absolutePath, name, dest.length())
            }
        }
    }

    val approval = model.approvals.firstOrNull { it.agentId == conversationId || channel?.memberIds?.contains(it.agentId) == true }

    /*
     * The transcript is a conversation, not a log.
     *
     * The desktop build hides the tool cards behind one toggle and shows only what the bot actually
     * said; the phone was showing every call inline, which on a small screen buries the answer under
     * the machinery that produced it. Same toggle, same default.
     */
    val visible = messages.filter {
        showActivity || it.text.isNotBlank() || it.event != null || it.widget != null ||
            it.images.isNotEmpty() || it.toolCalls.isNotEmpty()
    }

    LaunchedEffect(visible.size, showActivity) {
        if (visible.isNotEmpty()) listState.animateScrollToItem(visible.size - 1)
    }

    Column(modifier = Modifier.fillMaxSize().background(colors.bgBase)) {
        // ---- header
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .height(56.dp)
                .padding(horizontal = Halo1),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = colors.textSecondary)
            }
            Row(
                modifier = Modifier.weight(1f).clickable { details = true },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (agent != null) {
                    Avatar(agent, size = 32.dp, showStatus = true)
                    Spacer(Modifier.width(Halo2))
                }
                Column {
                    Text(
                        agent?.name ?: channel?.name ?: "Chat",
                        style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                        color = colors.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    val subtitle = when {
                        agent != null && model.busy(conversationId) -> "working…"
                        agent != null -> agent.title.ifEmpty { "idle" }
                        channel != null -> channel.memberIds.mapNotNull { model.agent(it)?.name }.joinToString(", ")
                        else -> ""
                    }
                    if (subtitle.isNotEmpty()) {
                        Text(subtitle, style = MaterialTheme.typography.bodySmall, color = colors.textTertiary, maxLines = 1)
                    }
                }
            }
            IconButton(onClick = { showActivity = !showActivity }) {
                Icon(
                    Icons.AutoMirrored.Filled.List,
                    "Show what the bot is doing step by step",
                    tint = if (showActivity) colors.accent else colors.textSecondary,
                )
            }
            if (agent != null) {
                IconButton(onClick = { details = true }) {
                    Icon(Icons.Default.Tune, "Details", tint = colors.textSecondary)
                }
            }
        }

        // ---- transcript
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                start = Halo3, end = Halo3, top = Halo2, bottom = Halo4,
            ),
            verticalArrangement = Arrangement.spacedBy(Halo1),
        ) {
            if (visible.isEmpty()) {
                item { EmptyChat(agent) { idea -> draft = idea } }
            }
            itemsIndexed(visible, key = { _, m -> m.id }) { index, message ->
                MessageRow(
                    message = message,
                    previous = visible.getOrNull(index - 1),
                    fromAgent = message.fromAgentId?.let { model.agent(it) },
                    inChannel = channel != null,
                    showActivity = showActivity,
                    onAnswer = { value -> model.answerWidget(conversationId, message.id, value) },
                    onLongPress = { menuFor = message },
                )
            }
        }

        // ---- the working line, under the transcript exactly as on the desktop
        AnimatedVisibility(visible = model.busy(conversationId)) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = Halo4, vertical = Halo2),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                androidx.compose.material3.CircularProgressIndicator(
                    color = colors.accent,
                    strokeWidth = 2.dp,
                    modifier = Modifier.size(14.dp),
                )
                Spacer(Modifier.width(Halo2))
                Text(
                    (agent?.name ?: "The room") + " is working",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textTertiary,
                )
            }
        }

        // ---- the approval bar, above the composer exactly as on the desktop
        AnimatedVisibility(visible = approval != null) {
            approval?.let { ApprovalCard(it) { decision -> model.respond(it.id, decision) } }
        }

        // ---- composer
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(colors.bgSubtle)
                .imePadding()
                .navigationBarsPadding(),
        ) {
        if (attachments.isNotEmpty()) {
            FlowRow(
                modifier = Modifier.fillMaxWidth().padding(start = Halo3, end = Halo3, top = Halo2),
                horizontalArrangement = Arrangement.spacedBy(Halo1),
            ) {
                for (item in attachments) {
                    Row(
                        modifier = Modifier
                            .clip(RoundedCornerShape(Halo2))
                            .background(colors.bgElevated)
                            .clickable { attachments = attachments - item }
                            .padding(horizontal = Halo2, vertical = Halo1),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            CLIP_GLYPH + " " + item.name + "  " + CROSS_GLYPH,
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.textSecondary,
                        )
                    }
                }
            }
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = Halo3, vertical = Halo2),
            verticalAlignment = Alignment.Bottom,
        ) {
            IconButton(onClick = { attach.launch(arrayOf("*/*")) }) {
                Icon(Icons.Default.AttachFile, "Attach a file", tint = colors.textSecondary)
            }
            Box(
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(Halo5))
                    .background(colors.bgElevated)
                    .padding(horizontal = Halo4, vertical = Halo3),
            ) {
                if (draft.isEmpty()) {
                    Text(
                        "Message ${agent?.name ?: channel?.name ?: ""}",
                        style = MaterialTheme.typography.bodyLarge,
                        color = colors.textTertiary,
                    )
                }
                BasicTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.textPrimary),
                    cursorBrush = androidx.compose.ui.graphics.SolidColor(colors.accent),
                    modifier = Modifier.fillMaxWidth().heightIn(max = 160.dp),
                )
            }
            Spacer(Modifier.width(Halo2))
            val busy = model.busy(conversationId)
            Box(
                modifier = Modifier
                    .size(TouchTarget)
                    .clip(RoundedCornerShape(50))
                    .background(if (busy) colors.fillSecondary else colors.fillPrimary)
                    .clickable {
                        if (busy) {
                            model.stop(conversationId)
                        } else if (draft.isNotBlank() || attachments.isNotEmpty()) {
                            model.send(conversationId, draft.trim(), attachments)
                            draft = ""
                            attachments = emptyList()
                            keyboard?.hide()
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (busy) Icons.Default.Stop else Icons.AutoMirrored.Filled.Send,
                    if (busy) "Stop" else "Send",
                    tint = if (busy) colors.textPrimary else colors.textOnPrimary,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
        }
    }

    if (details && agent != null) {
        DetailsSheet(model, agent) { details = false }
    }

    menuFor?.let { message ->
        MessageMenuSheet(
            message = message,
            onDismiss = { menuFor = null },
            onCopy = {
                clipboard.setText(AnnotatedString(message.text))
                menuFor = null
            },
            onQuote = {
                draft = "> " + message.text.replace("\n", "\n> ").take(500) + "\n" + draft
                menuFor = null
            },
            onReact = { emoji ->
                model.react(conversationId, message.id, emoji)
                menuFor = null
            },
            onDelete = {
                model.deleteMessage(conversationId, message.id)
                menuFor = null
            },
        )
    }
}

/** Copy, quote, react, delete - where a phone puts the desktop's hover row. */
@Composable
private fun MessageMenuSheet(
    message: Message,
    onDismiss: () -> Unit,
    onCopy: () -> Unit,
    onQuote: () -> Unit,
    onReact: (String) -> Unit,
    onDelete: () -> Unit,
) {
    val colors = LocalHaloColors.current
    HaloSheet(onDismiss) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Halo4, vertical = Halo3),
            horizontalArrangement = Arrangement.spacedBy(Halo2),
        ) {
            for (emoji in REACTIONS) {
                Box(
                    modifier = Modifier
                        .size(44.dp)
                        .clip(RoundedCornerShape(50))
                        .background(if (emoji in message.reactions) colors.accentSubtle else colors.bgSubtle)
                        .clickable { onReact(emoji) },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(emoji, style = MaterialTheme.typography.titleMedium)
                }
            }
        }
        SheetAction("Copy text", onClick = onCopy)
        SheetAction("Quote in a reply", onClick = onQuote)
        SheetAction("Delete from the transcript", danger = true, onClick = onDelete)
        Spacer(Modifier.height(Halo4))
    }
}

/** The three openers the desktop build offers, because a blank chat is the hardest screen to start on. */
private val OPENERS = listOf(
    "Search the web for X and send me a short sourced summary.",
    "Open my browser, sign in where needed, and pull the data I asked for.",
    "Every weekday at 09:00, check X and send me one line.",
)

@Composable
private fun EmptyChat(agent: Agent?, onPick: (String) -> Unit) {
    val colors = LocalHaloColors.current
    Column(
        modifier = Modifier.fillMaxWidth().padding(Halo6),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (agent != null) Avatar(agent, size = 64.dp)
        Spacer(Modifier.height(Halo3))
        Text(
            agent?.name ?: "New conversation",
            style = MaterialTheme.typography.titleLarge,
            color = colors.textPrimary,
        )
        Text(
            agent?.description?.takeIf { it.isNotBlank() }
                ?: "Give it a task. It has its own workspace, browser, memory and routines.",
            modifier = Modifier.padding(top = Halo2),
            style = MaterialTheme.typography.bodyMedium,
            color = colors.textTertiary,
        )
        Spacer(Modifier.height(Halo4))
        for (idea in OPENERS) {
            Box(
                modifier = Modifier
                    .padding(vertical = Halo1)
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(Halo3))
                    .background(colors.bgSubtle)
                    .clickable { onPick(idea) }
                    .padding(Halo3),
            ) {
                Text(idea, style = MaterialTheme.typography.bodySmall, color = colors.textSecondary)
            }
        }
    }
}

/** A dated line between two days of transcript, the way the desktop build separates them. */
@Composable
private fun DayDivider(at: Long) {
    val colors = LocalHaloColors.current
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = Halo2),
        horizontalArrangement = Arrangement.Center,
    ) {
        Text(
            dayLabel(at),
            style = MaterialTheme.typography.labelSmall,
            color = colors.textTertiary,
        )
    }
}

private val DAY = SimpleDateFormat("d MMM yyyy", Locale.getDefault())

private fun dayLabel(at: Long): String {
    val now = System.currentTimeMillis()
    val day = 86_400_000L
    fun startOf(t: Long): Long {
        val c = java.util.Calendar.getInstance()
        c.timeInMillis = t
        c.set(java.util.Calendar.HOUR_OF_DAY, 0)
        c.set(java.util.Calendar.MINUTE, 0)
        c.set(java.util.Calendar.SECOND, 0)
        c.set(java.util.Calendar.MILLISECOND, 0)
        return c.timeInMillis
    }
    return when (startOf(at)) {
        startOf(now) -> "Today"
        startOf(now - day) -> "Yesterday"
        else -> DAY.format(Date(at))
    }
}

private fun sameDay(a: Long, b: Long): Boolean {
    val c1 = java.util.Calendar.getInstance().apply { timeInMillis = a }
    val c2 = java.util.Calendar.getInstance().apply { timeInMillis = b }
    return c1.get(java.util.Calendar.YEAR) == c2.get(java.util.Calendar.YEAR) &&
        c1.get(java.util.Calendar.DAY_OF_YEAR) == c2.get(java.util.Calendar.DAY_OF_YEAR)
}

// ------------------------------------------------------------------- messages

@Composable
private fun MessageRow(
    message: Message,
    previous: Message?,
    fromAgent: Agent?,
    inChannel: Boolean,
    showActivity: Boolean,
    onAnswer: (String) -> Unit,
    onLongPress: () -> Unit,
) {
    val colors = LocalHaloColors.current

    if (previous == null || !sameDay(previous.createdAt, message.createdAt)) DayDivider(message.createdAt)

    message.event?.let { event ->
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = Halo2),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                event.label + (event.chip?.let { " · $it" } ?: ""),
                style = MaterialTheme.typography.bodySmall,
                color = when (event.kind) {
                    "permission" -> colors.textWarning
                    "routine" -> colors.textSecondary
                    else -> colors.textTertiary
                },
                modifier = Modifier
                    .clip(RoundedCornerShape(Halo3))
                    .background(colors.bgSubtle)
                    .padding(horizontal = Halo3, vertical = Halo1),
            )
        }
        return
    }

    val mine = message.role == Role.USER
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = Halo1),
        horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
    ) {
        if (inChannel && !mine && fromAgent != null) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 2.dp)) {
                Avatar(fromAgent, size = 18.dp)
                Spacer(Modifier.width(Halo1))
                Text(fromAgent.name, style = MaterialTheme.typography.labelSmall, color = colors.textTertiary)
            }
        }

        var stepsOpen by remember(message.id) { mutableStateOf(false) }
        if (message.toolCalls.isNotEmpty()) {
            /*
             * Quiet by default, the way the desktop transcript is: one line saying work happened,
             * naming the tools, expandable in place. The full cards are what the activity toggle in
             * the header turns on for the whole conversation.
             */
            if (!showActivity) {
                val names = message.toolCalls.map { it.name }.distinct().take(4).joinToString(", ")
                val count = message.toolCalls.size
                Text(
                    (if (stepsOpen) "\u2304 " else "\u203A ") + count + " step" + (if (count == 1) "" else "s") +
                        (if (names.isNotEmpty()) " \u00B7 " + names else ""),
                    modifier = Modifier
                        .padding(bottom = Halo1)
                        .clip(RoundedCornerShape(Halo2))
                        .clickable { stepsOpen = !stepsOpen }
                        .padding(horizontal = Halo2, vertical = Halo1),
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.textTertiary,
                )
            }
            if (showActivity || stepsOpen) {
                Column(
                    modifier = Modifier.widthIn(max = 460.dp).padding(bottom = Halo1),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    for (call in message.toolCalls.sortedBy { it.startedAt }) ToolCard(call)
                }
            }
        }

        if (message.text.isNotBlank()) {
            Box(
                modifier = Modifier
                    .widthIn(max = 460.dp)
                    .combinedClick(onClick = {}, onLongClick = onLongPress)
                    .clip(
                        RoundedCornerShape(
                            topStart = Halo4,
                            topEnd = Halo4,
                            bottomStart = if (mine) Halo4 else Halo1,
                            bottomEnd = if (mine) Halo1 else Halo4,
                        ),
                    )
                    .background(if (mine) colors.bubbleUser else colors.bubbleAgent)
                    .padding(horizontal = Halo3, vertical = Halo2),
            ) {
                MarkdownText(
                    message.text,
                    color = if (mine && !colors.isDark) Color.White else colors.textPrimary,
                )
            }
        }

        for (image in message.images) {
            val bitmap = remember(image.path) {
                runCatching { android.graphics.BitmapFactory.decodeFile(image.path) }.getOrNull()
            }
            if (bitmap != null) {
                Image(
                    bitmap = bitmap.asImageBitmap(),
                    contentDescription = image.alt,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier
                        .padding(top = Halo1)
                        .widthIn(max = 320.dp)
                        .clip(RoundedCornerShape(Halo3)),
                )
            }
        }

        message.widget?.let { widget -> WidgetCard(widget, onAnswer) }

        if (message.reactions.isNotEmpty()) {
            Text(
                message.reactions.joinToString(" "),
                modifier = Modifier.padding(top = 2.dp),
                style = MaterialTheme.typography.bodySmall,
            )
        }

        if (message.text.isNotBlank()) {
            Text(
                TIME.format(Date(message.createdAt)),
                modifier = Modifier.padding(top = 2.dp),
                style = MaterialTheme.typography.labelSmall,
                color = colors.textTertiary,
            )
        }

        for (attachment in message.attachments) {
            Text(
                "📎 " + attachment.name,
                modifier = Modifier.padding(top = 2.dp),
                style = MaterialTheme.typography.labelSmall,
                color = colors.textTertiary,
            )
        }
    }
}

private val TIME = SimpleDateFormat("HH:mm", Locale.getDefault())

@Composable
private fun ToolCard(call: ToolCallRecord) {
    val colors = LocalHaloColors.current
    var open by remember { mutableStateOf(false) }
    val tint = when (call.status) {
        "error" -> colors.textDanger
        "denied" -> colors.textWarning
        "running" -> colors.accent
        else -> colors.textTertiary
    }
    val mark = when (call.status) {
        "error" -> "✕"
        "denied" -> "⃠"
        "running" -> "•"
        else -> "✓"
    }

    Column(
        modifier = Modifier
            .clip(RoundedCornerShape(Halo2))
            .background(colors.bgSubtle)
            .clickable { open = !open }
            .padding(horizontal = Halo3, vertical = Halo2),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(mark, style = MaterialTheme.typography.labelMedium, color = tint)
            Spacer(Modifier.width(Halo2))
            Text(
                buildAnnotatedString {
                    append(call.name)
                    val summary = argSummary(call)
                    if (summary.isNotEmpty()) {
                        val start = length
                        append("  $summary")
                        addStyle(SpanStyle(color = colors.textTertiary), start, length)
                    }
                },
                style = MaterialTheme.typography.labelMedium.copy(fontFamily = FontFamily.Monospace),
                color = colors.textSecondary,
                maxLines = if (open) 4 else 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }
        if (open) {
            val body = call.error ?: call.result.orEmpty()
            if (body.isNotBlank()) {
                Text(
                    body.take(4000),
                    modifier = Modifier.padding(top = Halo2),
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    color = if (call.error != null) colors.textDanger else colors.textTertiary,
                )
            }
        }
    }
}

/** One line of the arguments, enough to tell two calls of the same tool apart. */
private fun argSummary(call: ToolCallRecord): String {
    val interesting = listOf("command", "path", "url", "query", "name", "action", "text", "description", "box_path", "source")
    for (key in interesting) {
        val value = (call.args[key] as? kotlinx.serialization.json.JsonPrimitive)?.content
        if (!value.isNullOrBlank()) return value.replace(Regex("\\s+"), " ").take(80)
    }
    return ""
}

@Composable
private fun WidgetCard(widget: Widget, onAnswer: (String) -> Unit) {
    val colors = LocalHaloColors.current
    Column(
        modifier = Modifier
            .padding(top = Halo1)
            .widthIn(max = 460.dp)
            .clip(RoundedCornerShape(Halo4))
            .background(colors.bgSubtle)
            .padding(Halo3),
    ) {
        Text(widget.prompt, style = MaterialTheme.typography.bodyLarge, color = colors.textPrimary)
        Spacer(Modifier.height(Halo2))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(Halo2), verticalArrangement = Arrangement.spacedBy(Halo2)) {
            for (option in widget.options) {
                val answered = widget.answered != null
                val picked = widget.answered == option.value
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(Halo2))
                        .background(
                            when {
                                picked -> colors.accentSubtle
                                answered -> colors.fillSecondary
                                option.style == "danger" -> colors.dangerSubtle
                                option.style == "primary" -> colors.fillPrimary
                                else -> colors.fillSecondary
                            },
                        )
                        .clickable(enabled = !answered) { onAnswer(option.value) }
                        .heightIn(min = 40.dp)
                        .padding(horizontal = Halo3),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        option.label,
                        style = MaterialTheme.typography.labelLarge,
                        color = when {
                            picked -> colors.accent
                            answered -> colors.textTertiary
                            option.style == "danger" -> colors.textDanger
                            option.style == "primary" -> colors.textOnPrimary
                            else -> colors.textPrimary
                        },
                    )
                }
            }
        }
        if (widget.allowCustom && widget.answered == null) {
            Text(
                "…or just type your own answer.",
                modifier = Modifier.padding(top = Halo2),
                style = MaterialTheme.typography.bodySmall,
                color = colors.textTertiary,
            )
        }
    }
}

// ------------------------------------------------------------------- approvals

@Composable
fun ApprovalCard(request: ApprovalRequest, onDecide: (ApprovalDecision) -> Unit) {
    val colors = LocalHaloColors.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Halo3, vertical = Halo2)
            .clip(RoundedCornerShape(Halo4))
            .background(colors.warningSubtle)
            .padding(Halo3),
    ) {
        Text(request.question, style = MaterialTheme.typography.titleSmall, color = colors.textPrimary)
        Text(
            request.summary,
            modifier = Modifier.padding(top = Halo1),
            style = MaterialTheme.typography.bodyMedium,
            color = colors.textPrimary,
        )
        if (request.detail.isNotBlank() && request.detail != request.summary) {
            Text(
                request.detail.take(600),
                modifier = Modifier
                    .padding(top = Halo2)
                    .clip(RoundedCornerShape(Halo2))
                    .background(colors.bgBase)
                    .padding(Halo2),
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                color = colors.textSecondary,
            )
        }
        Text(
            request.reason,
            modifier = Modifier.padding(top = Halo2),
            style = MaterialTheme.typography.bodySmall,
            color = colors.textSecondary,
        )
        Row(modifier = Modifier.padding(top = Halo3), horizontalArrangement = Arrangement.spacedBy(Halo2)) {
            HaloButton("Never", { onDecide(ApprovalDecision.NEVER) }, Modifier.weight(1f), danger = true)
            HaloButton("Always", { onDecide(ApprovalDecision.ALWAYS) }, Modifier.weight(1f))
            HaloButton("Allow once", { onDecide(ApprovalDecision.ONCE) }, Modifier.weight(1.2f), primary = true)
        }
        Text(
            // The desktop build's own wording. It matters that "Always" is scoped, and a user who does
            // not know that will use it as if it were not.
            "\"Always\" remembers this kind of action" +
                (request.command?.let { ", for commands starting \"" + com.halo.bot.core.commandPrefixOf(it) + "\"" } ?: "") +
                ". Everything gated is recorded in Settings → Activity.",
            modifier = Modifier.padding(top = Halo2),
            style = MaterialTheme.typography.labelSmall,
            color = colors.textTertiary,
        )
    }
}
