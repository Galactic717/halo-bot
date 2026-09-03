package com.halo.bot.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.halo.bot.core.Agent

/** Tap and long-press, which is where a phone puts the desktop's right-click menu. */
fun Modifier.combinedClick(onClick: () -> Unit, onLongClick: () -> Unit): Modifier =
    this.combinedClickable(onClick = onClick, onLongClick = onLongClick)

@Composable
fun HaloTopBar(title: String, onBack: (() -> Unit)? = null, actions: @Composable () -> Unit = {}) {
    val colors = LocalHaloColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.bgBase)
            .statusBarsPadding()
            .height(56.dp)
            .padding(horizontal = Halo1),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = colors.textSecondary)
            }
        } else {
            Spacer(Modifier.width(Halo3))
        }
        Text(
            title,
            style = MaterialTheme.typography.titleMedium,
            color = colors.textPrimary,
            modifier = Modifier.weight(1f),
        )
        actions()
    }
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(),
        modifier = modifier.padding(start = Halo4, top = Halo5, bottom = Halo2),
        style = MaterialTheme.typography.labelSmall,
        color = LocalHaloColors.current.textTertiary,
    )
}

@Composable
fun HaloField(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    hint: String? = null,
    singleLine: Boolean = true,
    numeric: Boolean = false,
) {
    val colors = LocalHaloColors.current
    Column(modifier = modifier.padding(horizontal = Halo4, vertical = Halo1)) {
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            label = { Text(label) },
            placeholder = { if (placeholder.isNotEmpty()) Text(placeholder, color = colors.textTertiary) },
            singleLine = singleLine,
            keyboardOptions = if (numeric) KeyboardOptions(keyboardType = KeyboardType.Number) else KeyboardOptions.Default,
            modifier = Modifier.fillMaxWidth(),
            colors = TextFieldDefaults.colors(
                focusedContainerColor = colors.bgSubtle,
                unfocusedContainerColor = colors.bgSubtle,
                focusedIndicatorColor = colors.accent,
                unfocusedIndicatorColor = colors.borderWeak,
                focusedTextColor = colors.textPrimary,
                unfocusedTextColor = colors.textPrimary,
                focusedLabelColor = colors.accent,
                unfocusedLabelColor = colors.textTertiary,
                cursorColor = colors.accent,
            ),
        )
        if (hint != null) {
            Text(
                hint,
                modifier = Modifier.padding(top = Halo1, start = Halo1),
                style = MaterialTheme.typography.bodySmall,
                color = colors.textTertiary,
            )
        }
    }
}

@Composable
fun HaloSwitchRow(title: String, description: String?, checked: Boolean, onChange: (Boolean) -> Unit) {
    val colors = LocalHaloColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onChange(!checked) }
            .padding(horizontal = Halo4, vertical = Halo3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = colors.textPrimary)
            if (description != null) {
                Text(description, style = MaterialTheme.typography.bodySmall, color = colors.textTertiary)
            }
        }
        Spacer(Modifier.width(Halo3))
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            colors = SwitchDefaults.colors(
                checkedTrackColor = colors.accent,
                checkedThumbColor = Color.White,
                uncheckedTrackColor = colors.fillSecondary,
                uncheckedThumbColor = colors.textTertiary,
            ),
        )
    }
}

/** A row of mutually exclusive choices — the phone's version of the desktop's segmented control. */
@Composable
fun HaloChoiceRow(title: String, description: String?, options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    val colors = LocalHaloColors.current
    Column(modifier = Modifier.padding(horizontal = Halo4, vertical = Halo2)) {
        Text(title, style = MaterialTheme.typography.bodyLarge, color = colors.textPrimary)
        if (description != null) {
            Text(description, style = MaterialTheme.typography.bodySmall, color = colors.textTertiary)
        }
        Row(
            modifier = Modifier
                .padding(top = Halo2)
                .fillMaxWidth()
                .clip(RoundedCornerShape(Halo2))
                .background(colors.bgSubtle)
                .padding(Halo1),
            horizontalArrangement = Arrangement.spacedBy(Halo1),
        ) {
            for ((value, label) in options) {
                val active = value == selected
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(Halo1 + 2.dp))
                        .background(if (active) colors.fillGhostSelected else Color.Transparent)
                        .clickable { onSelect(value) }
                        .heightIn(min = 40.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        label,
                        style = MaterialTheme.typography.labelLarge,
                        color = if (active) colors.textPrimary else colors.textSecondary,
                    )
                }
            }
        }
    }
}

/**
 * The same choice as `HaloChoiceRow`, wrapped rather than squeezed.
 *
 * A segmented row is right for three options and wrong for eight: at eight, every label is truncated
 * to two characters and the control stops being readable. This one wraps onto as many lines as it
 * needs, which is the honest shape for a list that grows.
 */
@Composable
fun HaloWrapChoice(
    title: String,
    description: String?,
    options: List<Pair<String, String>>,
    selected: String,
    onSelect: (String) -> Unit,
) {
    val colors = LocalHaloColors.current
    Column(modifier = Modifier.padding(horizontal = Halo4, vertical = Halo2)) {
        Text(title, style = MaterialTheme.typography.bodyLarge, color = colors.textPrimary)
        if (description != null) {
            Text(description, style = MaterialTheme.typography.bodySmall, color = colors.textTertiary)
        }
        androidx.compose.foundation.layout.FlowRow(
            modifier = Modifier.padding(top = Halo2).fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(Halo1),
            verticalArrangement = Arrangement.spacedBy(Halo1),
        ) {
            for ((value, label) in options) {
                val active = value == selected
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(Halo3))
                        .background(if (active) colors.accentSubtle else colors.bgSubtle)
                        .border(
                            1.dp,
                            if (active) colors.accent else Color.Transparent,
                            RoundedCornerShape(Halo3),
                        )
                        .clickable { onSelect(value) }
                        .heightIn(min = 38.dp)
                        .padding(horizontal = Halo3),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        label,
                        style = MaterialTheme.typography.labelMedium,
                        color = if (active) colors.accent else colors.textSecondary,
                    )
                }
            }
        }
    }
}

@Composable
fun HaloButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    primary: Boolean = false,
    danger: Boolean = false,
    enabled: Boolean = true,
) {
    val colors = LocalHaloColors.current
    val background = when {
        !enabled -> colors.fillSecondary
        danger -> colors.dangerSubtle
        primary -> colors.fillPrimary
        else -> colors.fillSecondary
    }
    val foreground = when {
        !enabled -> colors.textTertiary
        danger -> colors.textDanger
        primary -> colors.textOnPrimary
        else -> colors.textPrimary
    }
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(Halo2))
            .background(background)
            .clickable(enabled = enabled, onClick = onClick)
            .heightIn(min = TouchTarget)
            .padding(horizontal = Halo4),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = foreground)
    }
}

@Composable
fun InfoCard(text: String, tone: String = "neutral", modifier: Modifier = Modifier) {
    val colors = LocalHaloColors.current
    val background = when (tone) {
        "warning" -> colors.warningSubtle
        "danger" -> colors.dangerSubtle
        "success" -> colors.successSubtle
        else -> colors.bgSubtle
    }
    val foreground = when (tone) {
        "warning" -> colors.textWarning
        "danger" -> colors.textDanger
        "success" -> colors.textSuccess
        else -> colors.textSecondary
    }
    Box(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = Halo4, vertical = Halo2)
            .clip(RoundedCornerShape(Halo3))
            .background(background)
            .padding(Halo3),
    ) {
        Text(text, style = MaterialTheme.typography.bodySmall, color = foreground)
    }
}

// ------------------------------------------------------------------------ sheets

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun HaloSheet(onDismiss: () -> Unit, content: @Composable () -> Unit) {
    val colors = LocalHaloColors.current
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = colors.bgElevated,
        contentColor = colors.textPrimary,
        scrimColor = colors.bgScrim,
    ) {
        Column(modifier = Modifier.navigationBarsPadding()) { content() }
    }
}

@Composable
fun SheetTitle(text: String) {
    Text(
        text,
        modifier = Modifier.padding(horizontal = Halo4, vertical = Halo2),
        style = MaterialTheme.typography.titleMedium,
        color = LocalHaloColors.current.textPrimary,
    )
}

@Composable
fun SheetAction(label: String, danger: Boolean = false, onClick: () -> Unit) {
    val colors = LocalHaloColors.current
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .heightIn(min = TouchTarget)
            .padding(horizontal = Halo4),
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.bodyLarge,
            color = if (danger) colors.textDanger else colors.textPrimary,
        )
    }
}

@Composable
fun BotMenuSheet(
    agent: Agent,
    sections: List<com.halo.bot.core.Section>,
    onDismiss: () -> Unit,
    onPin: () -> Unit,
    onDuplicate: () -> Unit,
    onHide: () -> Unit,
    onExport: () -> Unit,
    onSection: (String?) -> Unit,
    onDelete: () -> Unit,
) {
    var confirming by remember { mutableStateOf(false) }
    var moving by remember { mutableStateOf(false) }
    var newSection by remember { mutableStateOf("") }
    HaloSheet(onDismiss) {
        SheetTitle(agent.name)
        SheetAction(if (agent.pinned) "Unpin" else "Pin to the top", onClick = onPin)
        SheetAction(if (moving) "Move to section" else "Move to section…") { moving = !moving }
        if (moving) {
            for (section in sections) {
                SheetAction("   " + section.name) { onSection(section.name) }
            }
            if (sections.any { agent.id in it.agentIds }) {
                SheetAction("   Take out of its section") { onSection(null) }
            }
            HaloField("New section", newSection, { newSection = it }, placeholder = "Watchers")
            if (newSection.isNotBlank()) {
                SheetAction("   Create \"" + newSection.trim() + "\" and move here") { onSection(newSection.trim()) }
            }
        }
        SheetAction("Duplicate", onClick = onDuplicate)
        SheetAction("Export to a file…", onClick = onExport)
        SheetAction("Hide from the list", onClick = onHide)
        if (confirming) {
            InfoCard(
                "Deleting ${agent.name} removes its chat, memory, skills and box. This cannot be undone.",
                tone = "danger",
            )
            SheetAction("Yes, delete ${agent.name}", danger = true, onClick = onDelete)
        } else {
            SheetAction("Delete…", danger = true) { confirming = true }
        }
        Spacer(Modifier.height(Halo4))
    }
}

@Composable
fun NewChannelSheet(agents: List<Agent>, onDismiss: () -> Unit, onCreate: (String, List<String>) -> Unit) {
    val colors = LocalHaloColors.current
    var name by remember { mutableStateOf("") }
    val members = remember { mutableStateOf(setOf<String>()) }

    HaloSheet(onDismiss) {
        SheetTitle("New room")
        HaloField("Name", name, { name = it }, placeholder = "morning-standup")
        SectionLabel("Who is in it")
        for (agent in agents) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable {
                        members.value = if (agent.id in members.value) members.value - agent.id else members.value + agent.id
                    }
                    .padding(horizontal = Halo4, vertical = Halo2),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Avatar(agent, size = 32.dp)
                Spacer(Modifier.width(Halo3))
                Text(agent.name, style = MaterialTheme.typography.bodyLarge, color = colors.textPrimary, modifier = Modifier.weight(1f))
                if (agent.id in members.value) {
                    Text("✓", style = MaterialTheme.typography.titleMedium, color = colors.accent)
                }
            }
        }
        Row(modifier = Modifier.padding(Halo4), horizontalArrangement = Arrangement.spacedBy(Halo2)) {
            HaloButton("Cancel", onDismiss, Modifier.weight(1f))
            HaloButton(
                "Create",
                { onCreate(name.trim().ifEmpty { "New room" }, members.value.toList()) },
                Modifier.weight(1f),
                primary = true,
                enabled = members.value.isNotEmpty(),
            )
        }
    }
}

@Composable
fun KeyValueRow(key: String, value: String, bold: Boolean = false) {
    val colors = LocalHaloColors.current
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = Halo4, vertical = Halo2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(key, style = MaterialTheme.typography.bodyMedium, color = colors.textSecondary, modifier = Modifier.weight(1f))
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = if (bold) FontWeight.SemiBold else FontWeight.Normal),
            color = colors.textPrimary,
        )
    }
}
