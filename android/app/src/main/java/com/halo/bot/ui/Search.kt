package com.halo.bot.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import com.halo.bot.Halo
import com.halo.bot.core.Message
import com.halo.bot.core.Role
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.rememberScrollState

/**
 * The desktop's Ctrl+K, as a screen.
 *
 * A phone has no global shortcut and no room for a floating palette, so the same thing becomes a
 * full surface reached from the list. The search itself is the store's, scanning every transcript on
 * disk rather than only what happens to be loaded: what makes this worth having is finding the
 * message from three weeks ago, and that one is never in memory.
 */
/**
 * The tabs the desktop palette has, in the same order and with the same names.
 *
 * The desktop's Ctrl+K is not only a message search — it is how somebody reaches a bot, a routine or
 * a screen without leaving the keyboard. A phone version that searched only messages would be a
 * different feature wearing the same name.
 */
private val SEARCH_TABS = listOf("all" to "All", "messages" to "Messages", "bots" to "Bots", "routines" to "Routines")

@Composable
fun SearchScreen(model: HaloViewModel, onBack: () -> Unit, onOpen: (String) -> Unit) {
    val colors = LocalHaloColors.current
    var query by remember { mutableStateOf("") }
    var tab by remember { mutableStateOf("all") }
    var hits by remember { mutableStateOf<List<Pair<String, Message>>>(emptyList()) }
    val focus = remember { FocusRequester() }

    // Debounced: a full-disk scan on every keystroke would stutter the keyboard on a long history.
    LaunchedEffect(query, tab) {
        if (query.trim().length < 2 || (tab != "all" && tab != "messages")) {
            hits = emptyList()
            return@LaunchedEffect
        }
        delay(180)
        hits = Halo.store.search(query.trim(), limit = 60)
    }

    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    Column(modifier = Modifier.fillMaxSize().background(colors.bgBase).imePadding()) {
        HaloTopBar("Search", onBack = onBack)
        HaloField(
            "Search every conversation",
            query,
            { query = it },
            modifier = Modifier.focusRequester(focus),
            placeholder = "a word you remember",
        )

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = Halo3, vertical = Halo1),
            horizontalArrangement = Arrangement.spacedBy(Halo1),
        ) {
            for ((value, label) in SEARCH_TABS) {
                val active = value == tab
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(Halo3))
                        .background(if (active) colors.fillGhostSelected else Color.Transparent)
                        .clickable { tab = value }
                        .heightIn(min = 38.dp)
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
        }

        val needle = query.trim().lowercase()
        val bots = if (tab == "all" || tab == "bots") {
            model.agents.filter { needle.isEmpty() || it.name.lowercase().contains(needle) || it.title.lowercase().contains(needle) }
        } else {
            emptyList()
        }
        val routines = if (tab == "all" || tab == "routines") {
            model.routines.filter { needle.isEmpty() || it.name.lowercase().contains(needle) || it.prompt.lowercase().contains(needle) }
        } else {
            emptyList()
        }

        if (needle.length >= 2 && hits.isEmpty() && bots.isEmpty() && routines.isEmpty()) {
            InfoCard("Nothing matches \"${query.trim()}\".")
        }

        LazyColumn(modifier = Modifier.weight(1f)) {
            if (bots.isNotEmpty()) {
                item { SearchLabel("Bots") }
                items(bots, key = { "bot-" + it.id }) { agent ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onOpen(agent.id) }
                            .padding(horizontal = Halo4, vertical = Halo3),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Avatar(agent, size = 32.dp, showStatus = true)
                        Spacer(Modifier.width(Halo3))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(agent.name, style = MaterialTheme.typography.titleSmall, color = colors.textPrimary)
                            if (agent.title.isNotBlank()) {
                                Text(
                                    agent.title,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = colors.textTertiary,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }
            }

            if (routines.isNotEmpty()) {
                item { SearchLabel("Routines") }
                items(routines, key = { "routine-" + it.id }) { routine ->
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onOpen(routine.agentId) }
                            .padding(horizontal = Halo4, vertical = Halo3),
                    ) {
                        Text(routine.name, style = MaterialTheme.typography.titleSmall, color = colors.textPrimary)
                        Text(
                            (model.agent(routine.agentId)?.name ?: "a deleted bot") + " · " +
                                com.halo.bot.core.describeTriggers(routine.triggers) +
                                (if (routine.enabled) "" else " (paused)"),
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.textTertiary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }

            if (hits.isNotEmpty()) item { SearchLabel("Messages") }
            items(hits, key = { it.second.id }) { (conversationId, message) ->
                val name = model.agent(conversationId)?.name
                    ?: model.channel(conversationId)?.name
                    ?: "a deleted bot"
                SearchRow(
                    who = if (message.role == Role.USER) "You · $name" else name,
                    text = message.text,
                    query = query.trim(),
                    at = message.createdAt,
                ) { onOpen(conversationId) }
            }
        }
    }
}

@Composable
private fun SearchRow(who: String, text: String, query: String, at: Long, onClick: () -> Unit) {
    val colors = LocalHaloColors.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = Halo4, vertical = Halo3),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                who,
                style = MaterialTheme.typography.labelMedium,
                color = colors.textSecondary,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.width(Halo2))
            Text(
                SimpleDateFormat("d MMM HH:mm", Locale.getDefault()).format(Date(at)),
                style = MaterialTheme.typography.labelSmall,
                color = colors.textTertiary,
            )
        }
        Text(
            highlight(snippet(text, query), query, colors.accent),
            style = MaterialTheme.typography.bodyMedium,
            color = colors.textPrimary,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
    }
    Box(modifier = Modifier.fillMaxWidth().padding(start = Halo4).background(colors.borderSubtle))
}

/** Enough context around the match to recognise it, rather than the first line of a long message. */
private fun snippet(text: String, query: String): String {
    val flat = text.replace(Regex("\\s+"), " ").trim()
    val at = flat.indexOf(query, ignoreCase = true)
    if (at < 0) return flat.take(160)
    val start = (at - 48).coerceAtLeast(0)
    val end = (at + query.length + 112).coerceAtMost(flat.length)
    return (if (start > 0) "…" else "") + flat.substring(start, end) + (if (end < flat.length) "…" else "")
}

private fun highlight(text: String, query: String, accent: androidx.compose.ui.graphics.Color) =
    buildAnnotatedString {
        if (query.isEmpty()) {
            append(text)
            return@buildAnnotatedString
        }
        var index = 0
        while (index < text.length) {
            val at = text.indexOf(query, index, ignoreCase = true)
            if (at < 0) {
                append(text.substring(index))
                break
            }
            append(text.substring(index, at))
            withStyle(SpanStyle(color = accent, fontWeight = FontWeight.SemiBold)) {
                append(text.substring(at, at + query.length))
            }
            index = at + query.length
        }
    }


@Composable
private fun SearchLabel(text: String) {
    Text(
        text.uppercase(),
        modifier = Modifier.padding(start = Halo4, top = Halo4, bottom = Halo1),
        style = MaterialTheme.typography.labelSmall,
        color = LocalHaloColors.current.textTertiary,
    )
}
