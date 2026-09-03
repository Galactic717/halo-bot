package com.halo.bot.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.halo.bot.core.ModelInfo
import com.halo.bot.core.listModelsDetailed
import com.halo.bot.core.rankModels
import kotlinx.coroutines.launch

/**
 * First run.
 *
 * The desktop version scans localhost for Ollama, LM Studio and llama.cpp. A phone almost never has
 * one of those on it, so the scan looks outward instead: the same three ports on whatever machine is
 * on this wifi, if the user names it, plus the hosted providers. That reordering is the honest one —
 * on a phone the common case is a key, and a local server on the LAN is the interesting case rather
 * than the default.
 */
private data class Preset(val label: String, val baseUrl: String, val needsKey: Boolean, val hint: String)

private val PRESETS = listOf(
    Preset("x.ai", "https://api.x.ai/v1", true, "Grok models. A key from console.x.ai."),
    Preset("OpenRouter", "https://openrouter.ai/api/v1", true, "One key, most models. openrouter.ai/keys."),
    Preset("OpenAI", "https://api.openai.com/v1", true, "platform.openai.com/api-keys."),
    Preset("DeepSeek", "https://api.deepseek.com/v1", true, "platform.deepseek.com."),
    Preset("A server on my network", "http://192.168.1.10:11434/v1", false, "Ollama, LM Studio or llama.cpp on a machine on this wifi. Ollama needs OLLAMA_HOST=0.0.0.0 to accept anything but localhost."),
)

@Composable
fun SetupScreen(model: HaloViewModel, onDone: () -> Unit) {
    val colors = LocalHaloColors.current
    val scope = rememberCoroutineScope()

    var preset by remember { mutableStateOf(PRESETS.first()) }
    var baseUrl by remember { mutableStateOf(PRESETS.first().baseUrl) }
    var apiKey by remember { mutableStateOf("") }
    var models by remember { mutableStateOf<List<ModelInfo>>(emptyList()) }
    var chosen by remember { mutableStateOf("") }
    var probing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun probe() {
        probing = true
        error = null
        scope.launch {
            try {
                val provider = model.settings.provider.copy(baseUrl = baseUrl.trim(), apiKey = apiKey.trim())
                val found = listModelsDetailed(provider)
                // 0: the server is not this phone, so how much memory a model needs is not a
                // question this app can answer. Only "can it chat" and "can it call tools" survive.
                val ranked = rankModels(found, 0L)
                models = ranked.ifEmpty { found }
                chosen = models.firstOrNull()?.id.orEmpty()
                if (models.isEmpty()) error = "The server answered but offers no models."
            } catch (e: Exception) {
                models = emptyList()
                error = (e.message ?: e.toString()).take(200)
            } finally {
                probing = false
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.bgBase)
            .statusBarsPadding()
            .imePadding()
            .verticalScroll(rememberScrollState()),
    ) {
        Spacer(Modifier.height(Halo6))
        Text(
            "Halo Bot",
            modifier = Modifier.padding(horizontal = Halo4),
            style = MaterialTheme.typography.displaySmall,
            color = colors.textPrimary,
        )
        Text(
            "AI teammates you can give real work to, running on this phone. First, point Halo at a model.",
            modifier = Modifier.padding(horizontal = Halo4, vertical = Halo2),
            style = MaterialTheme.typography.bodyLarge,
            color = colors.textSecondary,
        )

        SectionLabel("Where the model runs")
        Column(modifier = Modifier.padding(horizontal = Halo4), verticalArrangement = Arrangement.spacedBy(Halo1)) {
            for (option in PRESETS) {
                val active = option.label == preset.label
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(Halo3))
                        .background(if (active) colors.accentSubtle else colors.bgSubtle)
                        .clickable {
                            preset = option
                            baseUrl = option.baseUrl
                            models = emptyList()
                            chosen = ""
                            error = null
                        }
                        .padding(Halo3),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            option.label,
                            style = MaterialTheme.typography.titleSmall,
                            color = if (active) colors.accent else colors.textPrimary,
                        )
                        Text(option.hint, style = MaterialTheme.typography.bodySmall, color = colors.textTertiary)
                    }
                }
            }
        }

        HaloField("Server address", baseUrl, { baseUrl = it; models = emptyList() })
        if (preset.needsKey) {
            HaloField(
                "API key",
                apiKey,
                { apiKey = it; models = emptyList() },
                hint = "Encrypted with this phone's keystore before it is written to disk.",
            )
        }

        Row(modifier = Modifier.padding(horizontal = Halo4, vertical = Halo2)) {
            HaloButton(
                if (probing) "Looking…" else "Find models",
                ::probe,
                Modifier.fillMaxWidth(),
                primary = true,
                enabled = !probing && baseUrl.isNotBlank(),
            )
        }
        if (probing) {
            Box(modifier = Modifier.fillMaxWidth().padding(Halo4), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = colors.accent, modifier = Modifier.size(24.dp))
            }
        }
        error?.let { InfoCard(it, tone = "danger") }

        if (models.isNotEmpty()) {
            SectionLabel("Model")
            Text(
                "It needs tool calling. Vision too, if you want your bots to look at screenshots.",
                modifier = Modifier.padding(horizontal = Halo4),
                style = MaterialTheme.typography.bodySmall,
                color = colors.textTertiary,
            )
            Column(modifier = Modifier.padding(Halo4), verticalArrangement = Arrangement.spacedBy(Halo1)) {
                for (info in models.take(40)) {
                    val active = info.id == chosen
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(Halo2))
                            .background(if (active) colors.accentSubtle else colors.bgSubtle)
                            .clickable { chosen = info.id }
                            .padding(Halo3),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            info.id,
                            style = MaterialTheme.typography.bodyMedium.copy(
                                fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                            ),
                            color = if (active) colors.accent else colors.textPrimary,
                            modifier = Modifier.weight(1f),
                        )
                        val badge = listOfNotNull(
                            info.parameterSize,
                            info.size?.let { String.format(java.util.Locale.US, "%.1f GB", it / 1.0e9) },
                        ).joinToString(" · ")
                        if (badge.isNotEmpty()) {
                            Text(badge, style = MaterialTheme.typography.labelSmall, color = colors.textTertiary)
                        }
                    }
                }
            }
        }

        Spacer(Modifier.weight(1f))
        Row(modifier = Modifier.padding(Halo4).navigationBarsPadding(), horizontalArrangement = Arrangement.spacedBy(Halo2)) {
            HaloButton(
                "Start",
                {
                    model.saveSettings { s ->
                        s.copy(
                            provider = s.provider.copy(
                                baseUrl = baseUrl.trim(),
                                apiKey = apiKey.trim(),
                                model = chosen,
                                helperModel = chosen,
                            ),
                            onboarded = true,
                        )
                    }
                    // A first bot, so the list is never an empty screen with no way forward.
                    if (model.agents.isEmpty()) {
                        model.createAgent(
                            NewBotDraft(
                                name = "Scout",
                                title = "General assistant",
                                description = "A general-purpose teammate. Give it anything and it works out how.",
                                color = "blue",
                                personaId = "colleague",
                            ),
                        )
                    }
                    onDone()
                },
                Modifier.fillMaxWidth(),
                primary = true,
                enabled = chosen.isNotBlank(),
            )
        }
        Spacer(Modifier.height(Halo6))
    }

    LaunchedEffect(Unit) {
        if (model.settings.provider.baseUrl.isNotBlank()) baseUrl = model.settings.provider.baseUrl
        if (model.settings.provider.apiKey.isNotBlank()) apiKey = model.settings.provider.apiKey
    }
}
