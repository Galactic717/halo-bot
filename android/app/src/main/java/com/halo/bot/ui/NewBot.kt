package com.halo.bot.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.LaunchedEffect
import com.halo.bot.Halo
import com.halo.bot.core.ModelInfo
import com.halo.bot.core.PERSONAS
import com.halo.bot.core.listModelsDetailed

/** What the create form hands back. Everything but the name has a sensible default. */
data class NewBotDraft(
    val name: String,
    val title: String = "",
    val description: String = "",
    val color: String = "blue",
    val personaId: String? = null,
    val persona: String? = null,
    /** Null means "whatever Settings says". Anything else overrides it for this bot alone. */
    val model: String? = null,
)

/**
 * A template is a whole bot, not a name.
 *
 * Making a bot used to be a name, a role and a colour, which is fast and tells the model nothing: a
 * bot with no brief spends its first turn asking what it is for. Every template fills the role, the
 * brief and a voice that suits the job, and then leaves every field editable — a template that
 * cannot be adjusted is a menu rather than a starting point. Kept in step with the desktop build's
 * list in src/components/Onboarding.tsx.
 */
private data class Template(val draft: NewBotDraft, val blurb: String)

private val TEMPLATES = listOf(
    Template(
        NewBotDraft(
            name = "Scout",
            title = "General assistant",
            description = "A general-purpose teammate. Give it anything and it works out how.",
            color = "blue",
            personaId = "colleague",
        ),
        "Anything and everything",
    ),
    Template(
        NewBotDraft(
            name = "Researcher",
            title = "Digs into any question across the web",
            description = "Searches, reads primary sources, and comes back with a short sourced brief. " +
                "Never guesses a number or a quote; says plainly when something is not findable.",
            color = "green",
            personaId = "analyst",
        ),
        "Sourced answers, no guessing",
    ),
    Template(
        NewBotDraft(
            name = "Lookout",
            title = "Watches a site and tells you when it changes",
            description = "Keeps a routine per watched page, opens it in the browser on schedule, compares " +
                "against what it saw last time, and messages only on a real change.",
            color = "cyan",
            personaId = "terse",
        ),
        "Tells you when something moves",
    ),
    Template(
        NewBotDraft(
            name = "Tutor",
            title = "Teaches whatever you are trying to learn",
            description = "Explains a topic at the level the user is actually at, sets small exercises, checks " +
                "the answers, and keeps track of what has stuck in memory.",
            color = "yellow",
            personaId = "mentor",
        ),
        "Explains and quizzes you",
    ),
    Template(
        NewBotDraft(
            name = "Build Bot",
            title = "Writes and runs code in its own box",
            description = "Scripts, builds and tests in its workspace, runs long jobs in the background, and " +
                "reports what actually passed rather than what should have.",
            color = "purple",
            personaId = "senior",
        ),
        "Code, builds, tests",
    ),
    Template(
        NewBotDraft(
            name = "Morning Brief",
            title = "One short digest before you are properly awake",
            description = "Runs on a routine early, gathers whatever the user asked it to watch, and leaves one " +
                "short message. Nothing new means it stays quiet rather than repeating yesterday.",
            color = "orange",
            personaId = "terse",
        ),
        "One digest, on a schedule",
    ),
    Template(
        NewBotDraft(
            name = "Shopper",
            title = "Gathers options into a clear comparison",
            description = "Collects prices and specs from real listings, puts them in one table with links, and " +
                "flags the tradeoff rather than just picking the cheapest.",
            color = "magenta",
            personaId = "analyst",
        ),
        "One table, real links",
    ),
)

/**
 * The picker, shared by the create sheet and a bot's own settings.
 *
 * `selected` is the preset id, or null when the bot carries a hand-written voice — the Custom chip is
 * the one lit in that case, and the text box below is what is actually in use.
 */
@Composable
fun PersonaPicker(
    selectedId: String?,
    custom: String?,
    onPreset: (String) -> Unit,
    onCustom: (String) -> Unit,
) {
    val colors = LocalHaloColors.current
    val isCustom = !custom.isNullOrBlank()

    SectionLabel("How it talks")
    FlowRow(
        modifier = Modifier.padding(horizontal = Halo4).fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(Halo1),
        verticalArrangement = Arrangement.spacedBy(Halo1),
    ) {
        for (persona in PERSONAS) {
            val active = !isCustom && (selectedId ?: "colleague") == persona.id
            Row(
                modifier = Modifier
                    .clip(RoundedCornerShape(Halo3))
                    .background(if (active) colors.accentSubtle else colors.bgSubtle)
                    .border(
                        1.dp,
                        if (active) colors.accent else Color.Transparent,
                        RoundedCornerShape(Halo3),
                    )
                    .clickable { onPreset(persona.id) }
                    .heightIn(min = 38.dp)
                    .padding(horizontal = Halo3),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(persona.glyph, style = MaterialTheme.typography.labelMedium)
                Spacer(Modifier.width(Halo1))
                Text(
                    persona.label,
                    style = MaterialTheme.typography.labelMedium,
                    color = if (active) colors.accent else colors.textSecondary,
                )
            }
        }
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(Halo3))
                .background(if (isCustom) colors.accentSubtle else colors.bgSubtle)
                .border(1.dp, if (isCustom) colors.accent else Color.Transparent, RoundedCornerShape(Halo3))
                .clickable { onCustom(custom.orEmpty().ifBlank { " " }) }
                .heightIn(min = 38.dp)
                .padding(horizontal = Halo3),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("✎", style = MaterialTheme.typography.labelMedium)
            Spacer(Modifier.width(Halo1))
            Text(
                "Custom",
                style = MaterialTheme.typography.labelMedium,
                color = if (isCustom) colors.accent else colors.textSecondary,
            )
        }
    }

    if (isCustom) {
        HaloField(
            "Its voice, in your words",
            custom.orEmpty().trim(),
            onCustom,
            singleLine = false,
            placeholder = "Talk like a 1940s newsreel announcer. Keep every fact, path and number exact.",
        )
    } else {
        Text(
            PERSONAS.firstOrNull { it.id == (selectedId ?: "colleague") }?.blurb.orEmpty(),
            modifier = Modifier.padding(start = Halo4, end = Halo4, top = Halo2),
            style = MaterialTheme.typography.bodySmall,
            color = colors.textTertiary,
        )
    }
    Text(
        "A voice changes how it sounds, never what it is allowed to do. The approval gate and Halo's floor " +
            "are the same whichever one you pick.",
        modifier = Modifier.padding(start = Halo4, end = Halo4, top = Halo1),
        style = MaterialTheme.typography.labelSmall,
        color = colors.textTertiary,
    )
}

@Composable
fun NewBotSheet(onDismiss: () -> Unit, onCreate: (NewBotDraft) -> Unit) {
    val colors = LocalHaloColors.current
    var name by remember { mutableStateOf("") }
    var title by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var color by remember { mutableStateOf(AVATAR_COLORS.keys.random()) }
    var personaId by remember { mutableStateOf("colleague") }
    var custom by remember { mutableStateOf("") }
    var more by remember { mutableStateOf(false) }
    val defaultModel = Halo.store.getSettings().provider.model
    var model by remember { mutableStateOf("") }
    var models by remember { mutableStateOf<List<ModelInfo>>(emptyList()) }

    // What the configured server actually serves. A failure is silent: the field still takes a typed
    // id, which is the case that matters for a server whose /models endpoint is not a list.
    LaunchedEffect(Unit) {
        models = runCatching { listModelsDetailed(Halo.store.getSettings().provider) }.getOrDefault(emptyList())
    }

    HaloSheet(onDismiss) {
        Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
            SheetTitle("New bot")

            SectionLabel("Start from a template")
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = Halo3),
                horizontalArrangement = Arrangement.spacedBy(Halo2),
            ) {
                for (template in TEMPLATES) {
                    Column(
                        modifier = Modifier
                            .widthIn(min = 168.dp, max = 168.dp)
                            .clip(RoundedCornerShape(Halo3))
                            .background(colors.bgSubtle)
                            .clickable {
                                // Fills the form rather than creating outright, so it can be adjusted.
                                name = template.draft.name
                                title = template.draft.title
                                description = template.draft.description
                                color = template.draft.color
                                personaId = template.draft.personaId ?: "colleague"
                                custom = ""
                                more = true
                            }
                            .padding(Halo3),
                    ) {
                        Box(
                            modifier = Modifier
                                .size(26.dp)
                                .clip(RoundedCornerShape(50))
                                .background(avatarColor(template.draft.color)),
                        )
                        Spacer(Modifier.height(Halo2))
                        Text(
                            template.draft.name,
                            style = MaterialTheme.typography.titleSmall,
                            color = colors.textPrimary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            template.blurb,
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.textTertiary,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }

            HaloField("Name", name, { name = it }, placeholder = "Scout")

            SectionLabel("Colour")
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
                                width = if (option == color) 2.dp else 0.dp,
                                color = if (option == color) colors.textPrimary else Color.Transparent,
                                shape = RoundedCornerShape(50),
                            )
                            .clickable { color = option },
                    )
                }
            }

            PersonaPicker(
                selectedId = personaId,
                custom = custom.takeIf { it.isNotBlank() },
                onPreset = { personaId = it; custom = "" },
                onCustom = { custom = it },
            )

            SectionLabel("Model")
            HaloWrapChoice(
                "Which model this bot runs on",
                "The first is whatever Settings says. The second is any other model the server offers - a " +
                    "heavy bot can run a bigger one than a watcher.",
                listOf(
                    "" to ("Default" + if (defaultModel.isNotBlank()) " - " + defaultModel else ""),
                    "custom" to "Another model",
                ),
                if (model.isBlank()) "" else "custom",
            ) { value ->
                model = if (value.isBlank()) "" else model.ifBlank { models.firstOrNull()?.id ?: defaultModel }
            }

            if (model.isNotBlank()) {
                if (models.isNotEmpty()) {
                    HaloWrapChoice(
                        "On this server",
                        null,
                        models.take(24).map { it.id to it.id },
                        model,
                    ) { model = it }
                }
                HaloField(
                    "Model id",
                    model,
                    { model = it },
                    placeholder = defaultModel.ifBlank { "gpt-4o-mini" },
                    hint = "Anything the server at Settings - Model will answer for.",
                )
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { more = !more }
                    .padding(horizontal = Halo4, vertical = Halo3),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    (if (more) "⌄ " else "› ") + "Role and brief" + if (more) "" else " (optional)",
                    style = MaterialTheme.typography.labelLarge,
                    color = colors.textSecondary,
                )
            }

            if (more) {
                HaloField("Role", title, { title = it }, placeholder = "Research")
                HaloField(
                    "What it is for",
                    description,
                    { description = it },
                    singleLine = false,
                    hint = "Goes into its system prompt, so write it as instructions rather than as a label. " +
                        "A bot created with one takes a short first pass on its own.",
                )
            }

            Row(modifier = Modifier.padding(Halo4), horizontalArrangement = Arrangement.spacedBy(Halo2)) {
                HaloButton("Cancel", onDismiss, Modifier.weight(1f))
                HaloButton(
                    "Create",
                    {
                        onCreate(
                            NewBotDraft(
                                name = name.trim().ifEmpty { "New bot" },
                                title = title.trim(),
                                description = description.trim(),
                                color = color,
                                personaId = personaId.takeIf { custom.isBlank() },
                                persona = custom.trim().takeIf { it.isNotEmpty() },
                                model = model.trim().takeIf { it.isNotEmpty() },
                            ),
                        )
                    },
                    Modifier.weight(1f),
                    primary = true,
                    enabled = name.isNotBlank(),
                )
            }
            Spacer(Modifier.height(Halo4))
        }
    }
}
