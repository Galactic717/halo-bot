package com.halo.bot.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * The data model, ported one-for-one from host/types.ts.
 *
 * Everything the desktop app writes to disk as JSON is written the same way here, because the file
 * layout is the app's real interface with itself: a transcript, a settings file and a memory folder
 * outlive any one version of the code.
 */

@Serializable
enum class AgentStatus {
    @SerialName("idle") IDLE,
    @SerialName("working") WORKING,
    @SerialName("waiting") WAITING,
    @SerialName("sleeping") SLEEPING,
}

@Serializable
data class AgentAvatar(
    /** A picture the user picked; when set it replaces the drawn face. */
    val image: String? = null,
    val color: String = "blue",
    val face: Int = 0,
)

@Serializable
data class Agent(
    val id: String,
    val name: String,
    val title: String = "",
    val description: String = "",
    val avatar: AgentAvatar = AgentAvatar(),
    val notifications: Boolean = true,
    val createdAt: Long = 0,
    val status: AgentStatus = AgentStatus.IDLE,
    val lastActivityAt: Long = 0,
    val pinned: Boolean = false,
    val hidden: Boolean = false,
    /** Overrides the global model for this bot; empty means use the default. */
    val model: String? = null,
    /** Per-bot override of the global "work on shared storage" setting. */
    val localExecution: String? = null,
    /** Document trees the user granted this bot, as SAF uris. */
    val allowedPaths: List<String> = emptyList(),
    /**
     * An AG-UI endpoint that runs this bot's turns instead of Halo's own loop. The agent on the
     * other end can be written on any framework; every call it makes still comes back through the
     * same approval gate and audit trail. Only a person can set this.
     */
    val endpoint: String? = null,
    /** Sent as the Authorization header to that endpoint. Sealed with the keystore like the API key. */
    val endpointAuth: String? = null,
    /**
     * Which preset voice this bot uses, from core/Personas.kt. Null means the default colleague.
     * Kept beside `persona` rather than resolved into it, so the picker can show what is selected
     * and a preset that is later reworded reaches the bots already using it.
     */
    val personaId: String? = null,
    /** A voice written by hand. When set it replaces the preset entirely. */
    val persona: String? = null,
)

@Serializable
data class UsageRow(
    val at: Long,
    val agentId: String,
    val model: String,
    val promptTokens: Int,
    val completionTokens: Int,
    val seconds: Double,
)

@Serializable
data class Channel(
    val id: String,
    val name: String,
    val memberIds: List<String> = emptyList(),
    val createdAt: Long = 0,
    val lastActivityAt: Long = 0,
)

@Serializable
enum class Role {
    @SerialName("user") USER,
    @SerialName("agent") AGENT,
    @SerialName("system") SYSTEM,
}

@Serializable
data class ToolCallRecord(
    val id: String,
    val name: String,
    val args: JsonObject = JsonObject(emptyMap()),
    val status: String = "running",
    val startedAt: Long = 0,
    val endedAt: Long? = null,
    val result: String? = null,
    val error: String? = null,
)

@Serializable
data class WidgetOption(val label: String, val value: String, val style: String = "default")

/** A question with buttons, answered by the user; their pick comes back as a normal reply. */
@Serializable
data class Widget(
    val prompt: String,
    val options: List<WidgetOption> = emptyList(),
    val allowCustom: Boolean = false,
    val answered: String? = null,
)

@Serializable
data class Skill(
    val id: String,
    val name: String,
    val description: String,
    val body: String,
    val updatedAt: Long = 0,
)

/** A muted, centered line in the transcript: permissions, routines, memory writes, handoffs. */
@Serializable
data class SystemEvent(
    val kind: String,
    val label: String,
    val chip: String? = null,
    /** When the chip is a bot, its avatar is shown next to the name. */
    val chipAgentId: String? = null,
)

@Serializable
data class Attachment(val path: String, val name: String, val size: Long)

@Serializable
data class InlineImage(val path: String, val alt: String? = null)

@Serializable
data class Message(
    val id: String,
    val agentId: String,
    val role: Role,
    val text: String,
    val createdAt: Long,
    val reactions: List<String> = emptyList(),
    val fromAgentId: String? = null,
    val toAgentId: String? = null,
    val toolCalls: List<ToolCallRecord> = emptyList(),
    val attachments: List<Attachment> = emptyList(),
    val images: List<InlineImage> = emptyList(),
    val widget: Widget? = null,
    val event: SystemEvent? = null,
)

/** What the approval gate is being asked about. Same vocabulary as the desktop build. */
@Serializable
enum class ApprovalSurface {
    @SerialName("external_shell") EXTERNAL_SHELL,
    @SerialName("external_read") EXTERNAL_READ,
    @SerialName("shell") SHELL,
    @SerialName("browser") BROWSER,
    @SerialName("file_write") FILE_WRITE,
    @SerialName("agent_write") AGENT_WRITE,

    /**
     * Changing or running something in the user's automation tool.
     *
     * Its own surface rather than a borrowed one, because the risk is its own shape: an n8n workflow
     * is not a file and not a command, it is a thing that keeps running after the bot has stopped and
     * can reach every service the user connected to it.
     */
    @SerialName("automation") AUTOMATION;

    val wire: String
        get() = when (this) {
            EXTERNAL_SHELL -> "external_shell"
            EXTERNAL_READ -> "external_read"
            AUTOMATION -> "automation"
            SHELL -> "shell"
            BROWSER -> "browser"
            FILE_WRITE -> "file_write"
            AGENT_WRITE -> "agent_write"
        }

    companion object {
        fun of(wire: String): ApprovalSurface? = entries.firstOrNull { it.wire == wire }
    }
}

@Serializable
data class ApprovalRequest(
    val id: String,
    val agentId: String,
    val agentName: String,
    val surface: ApprovalSurface,
    /** Question shown above the composer, phrased like the original: "Allow ... to ...?" */
    val question: String,
    val summary: String,
    val detail: String,
    val reason: String,
    val createdAt: Long,
    /** The command verbatim, when there is one. "Always allow" is scoped to how it starts. */
    val command: String? = null,
    /** What the action does, so the card can say it and a remembered rule can name it. */
    val intent: String? = null,
)

enum class ApprovalDecision { ALWAYS, ONCE, NEVER }

@Serializable
data class RoutineTrigger(
    val kind: String,
    val everyMinutes: Int = 0,
    val hour: Int = 0,
    val minute: Int = 0,
    val weekday: Int = 0,
    val token: String = "",
)

@Serializable
data class RoutineRun(val at: Long, val status: String, val note: String? = null)

@Serializable
data class Routine(
    val id: String,
    val agentId: String,
    val name: String,
    /** What the bot does each time it fires, written to its future self. */
    val prompt: String,
    /** A routine can fire on several schedules, like the original's "Add another". */
    val triggers: List<RoutineTrigger> = emptyList(),
    val enabled: Boolean = true,
    val createdAt: Long = 0,
    val lastRunAt: Long? = null,
    val nextRunAt: Long? = null,
    val runs: List<RoutineRun> = emptyList(),
    /** Safety valve: a misconfigured routine cannot fire more than this in a day. */
    val maxRunsPerDay: Int? = null,
    /** Consecutive failures. Three in a row pauses the routine rather than failing on a schedule. */
    val failureStreak: Int = 0,
    /** Feeds the routine its own last result on the next run, so a watcher says "still down" once. */
    val continuity: Boolean = false,
    /** The last thing this routine reported, kept only when continuity is on. */
    val lastOutput: String? = null,
)

@Serializable
data class AutoReviewRule(
    val id: String,
    val trigger: String,
    val decision: String,
    /** Narrows the rule to one kind of action. Without it the rule is matched on its words alone. */
    val surface: ApprovalSurface? = null,
    /** Narrows the rule to one effect: run_command, write_file, navigate, and so on. */
    val intent: String? = null,
    /**
     * Narrows the rule to commands beginning this way. This is what "Always allow" writes: a rule
     * that only named the surface matched every later command word for word, so one approval became
     * standing permission to run anything.
     */
    val commandPrefix: String? = null,
    /**
     * A rule written as an expression instead of as fields. When present it is the whole test —
     * surface, intent and commandPrefix are ignored, because one rule meaning different things
     * depending on which boxes happen to be filled in is worse than two rules.
     */
    val expression: String? = null,
)

/** One decided action, written before it runs. See core/Audit.kt. */
@Serializable
data class AuditRow(
    val at: Long,
    val agentId: String,
    val agentName: String,
    val tool: String,
    val surface: String,
    val intent: String? = null,
    val summary: String,
    val detail: String,
    val outcome: String,
    /** Where the verdict came from: hardline, rule, dangerous, granted, mode, review, base. */
    val source: String,
    val matched: String? = null,
    val failure: String? = null,
    /** Present when the decision was recorded but not enforced, because the policy is in dry-run. */
    val dryRun: Boolean = false,
)

@Serializable
data class ProviderSettings(
    val baseUrl: String = "https://api.x.ai/v1",
    val apiKey: String = "",
    val model: String = "",
    /** Some servers ignore the tools field; kept as a switch for the JSON fallback protocol. */
    val toolMode: String = "native",
    val maxSteps: Int = 24,
    /** Cheap model for memory extraction and risk review; empty means reuse the main one. */
    val helperModel: String = "",
    /** Tokens of history kept before older turns are folded into a summary. */
    val contextBudget: Int = 12000,
    /** Send screenshots and attached images to the model. Turn off for text-only models. */
    val vision: Boolean = true,
    /** OpenAI-compatible image endpoint; empty disables GenerateImage. */
    val imageBaseUrl: String = "",
    val imageModel: String = "",
)

@Serializable
data class WebSearchSettings(
    val enabled: Boolean = true,
    val endpoint: String = "https://html.duckduckgo.com/html/?q=",
)

@Serializable
data class Section(
    val id: String,
    val name: String,
    val agentIds: List<String> = emptyList(),
    val collapsed: Boolean = false,
)

@Serializable
data class McpField(
    val key: String,
    val label: String,
    val hint: String? = null,
    val placeholder: String? = null,
    val flag: String? = null,
    /**
     * Asked for, but not insisted on.
     *
     * Some servers are two servers in one - n8n-mcp serves node documentation with no credential at
     * all and workflow management with one - and treating every declared field as mandatory blocks
     * the free half behind the paid one. The field still appears in the install sheet; it just does
     * not hold the install.
     */
    val optional: Boolean = false,
)

@Serializable
data class PluginSpec(
    val id: String,
    val name: String,
    val description: String = "",
    val category: String = "",
    /** The server's base URL. Android has no child processes, so every plugin is a remote one. */
    val url: String = "",
    val transport: String = "http",
    val requires: List<McpField> = emptyList(),
    val setup: List<McpField> = emptyList(),
    /** Secrets, sealed with the keystore before they reach disk. */
    val env: Map<String, String> = emptyMap(),
    /** Non-secret answers, sent as headers or query parameters. */
    val config: Map<String, String> = emptyMap(),
    val enabled: Boolean = true,
    val icon: String? = null,
    val featured: Boolean = false,
    val source: String? = null,
    /** Header the credential is sent in. Defaults to Authorization: Bearer. */
    val authHeader: String? = null,
)

@Serializable
data class N8nSettings(
    val enabled: Boolean = false,
    val baseUrl: String = "http://localhost:5678",
    val apiKey: String = "",
)

@Serializable
data class Settings(
    val provider: ProviderSettings = ProviderSettings(),
    val theme: String = "system",
    /**
     * What language bots answer in. `match` follows the user message by message; anything else is a
     * language name the prompt names outright. See core/Personas.kt.
     */
    val replyLanguage: String = "match",
    val timezone: String = "UTC",
    /** ask | allow | never, for work on storage outside the bot's own box. */
    val localExecution: String = "ask",
    /** The master switch. With it off nothing is reviewed and nothing is asked. */
    val autoReview: Boolean = true,
    /** rules: local rules only. smart: rules plus a model review of risky actions. */
    val autoReviewMode: String = "smart",
    /**
     * enforce blocks what the policy refuses. dry-run decides and records and lets the work
     * continue, so somebody can write a rule against real work and read the audit trail before it
     * starts refusing things. The hardline floor ignores this: it refuses in both modes.
     */
    val policyMode: String = "enforce",
    val onboarded: Boolean = false,
    /** Keep a foreground service alive so bots keep working with the app in the background. */
    val backgroundService: Boolean = true,
    val rules: List<AutoReviewRule> = emptyList(),
    val webSearch: WebSearchSettings = WebSearchSettings(),
    /**
     * The user's own n8n, so a bot can read, write and fire their automations.
     *
     * n8n is where a lot of people already keep the integrations Halo does not have - a bot that can
     * write an n8n workflow inherits every service they have connected to it, which is a far better
     * trade than growing a connector per vendor. The key is sealed like the model key.
     */
    val n8n: N8nSettings = N8nSettings(),
    val sections: List<Section> = emptyList(),
    val plugins: List<PluginSpec> = emptyList(),
)

/** Who has the wheel on one bot's browser. */
data class ControlState(
    val holder: String = "bot",
    val since: Long = 0,
    val requested: Boolean = false,
    val instruction: String? = null,
)

/** Everything that happens in the runtime, streamed to the UI. */
sealed interface HaloEvent {
    data class Agents(val agents: List<Agent>) : HaloEvent
    data class NewMessage(val message: Message) : HaloEvent
    data class MessagePatch(
        val agentId: String,
        val messageId: String,
        val text: String? = null,
        val reactions: List<String>? = null,
    ) : HaloEvent

    data class ToolUpdate(val agentId: String, val messageId: String, val call: ToolCallRecord) : HaloEvent
    data class Status(val agentId: String, val status: AgentStatus, val note: String? = null) : HaloEvent
    data class ApprovalAsked(val approval: ApprovalRequest) : HaloEvent
    data class ApprovalResolved(val id: String, val approved: Boolean) : HaloEvent
    data class ChannelsChanged(val channels: List<Channel>) : HaloEvent
    data class Focus(val agentId: String) : HaloEvent
    data class Teaching(val agentId: String, val recording: Boolean, val seconds: Int, val steps: Int) : HaloEvent
    data class ProviderHealth(
        val ok: Boolean,
        val baseUrl: String,
        val model: String,
        val error: String? = null,
        val kind: String? = null,
    ) : HaloEvent

    data class RoutinesChanged(val routines: List<Routine>) : HaloEvent
    data class SettingsChanged(val settings: com.halo.bot.core.Settings) : HaloEvent
    data class ComputerChanged(val agentId: String, val url: String, val title: String, val visible: Boolean) : HaloEvent
    data class ControlChanged(
        val agentId: String,
        val holder: String,
        val requested: Boolean,
        val instruction: String? = null,
    ) : HaloEvent

    data class Audited(val row: AuditRow) : HaloEvent
    data class Failure(val agentId: String?, val message: String) : HaloEvent
}

/** Loose JSON arguments, as they arrive from a model. */
typealias Args = Map<String, JsonElement>
