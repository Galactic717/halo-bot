package com.halo.bot

import android.app.ActivityManager
import android.content.Context
import android.os.StatFs
import com.halo.bot.core.Agent
import com.halo.bot.core.AgentStatus
import com.halo.bot.core.ApprovalRequest
import com.halo.bot.core.FailureReason
import com.halo.bot.core.HaloEvent
import com.halo.bot.core.HostPort
import com.halo.bot.core.McpManager
import com.halo.bot.core.Message
import com.halo.bot.core.ProviderError
import com.halo.bot.core.ProviderSettings
import com.halo.bot.core.Routine
import com.halo.bot.core.RoutineRun
import com.halo.bot.core.Runner
import com.halo.bot.core.Scheduler
import com.halo.bot.core.Settings
import com.halo.bot.core.Store
import com.halo.bot.core.listModelsDetailed
import com.halo.bot.platform.Computer
import com.halo.bot.platform.Notifications
import com.halo.bot.platform.Secrets
import com.halo.bot.platform.Storage
import com.halo.bot.platform.WebhookServer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import java.io.File
import java.util.TimeZone

/**
 * The one long-lived object.
 *
 * On the desktop this is the Electron main process: it owns the store, the runner, the browser, the
 * scheduler and the plugin manager, and the renderer talks to it over IPC. Here the same set lives in
 * the application process and the UI observes it directly — a phone has one window, so an IPC hop
 * between the runtime and the interface would buy nothing but latency.
 */
object Halo {

    lateinit var store: Store
        private set
    lateinit var runner: Runner
        private set
    lateinit var computer: Computer
        private set
    lateinit var storage: Storage
        private set
    lateinit var scheduler: Scheduler
        private set
    lateinit var mcp: McpManager
        private set
    lateinit var webhooks: WebhookServer
        private set

    private lateinit var appContext: Context
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val _events = MutableSharedFlow<HaloEvent>(extraBufferCapacity = 256)
    val events: SharedFlow<HaloEvent> = _events

    /** Set by the Activity so notifications are suppressed while the user is already looking. */
    @Volatile var inForeground: Boolean = false

    @Volatile var providerHealthy: Boolean? = null
        private set

    @Volatile var providerError: String? = null
        private set

    private var started = false

    fun start(context: Context) {
        if (started) return
        started = true
        appContext = context.applicationContext
        Notifications.ensureChannels(appContext)

        store = Store(appContext.filesDir, Secrets())
        // The timezone is the phone's, not a stored guess: a phone crosses timezones and the routines
        // should follow it.
        if (store.getSettings().timezone == "UTC") {
            store.saveSettings(store.getSettings().copy(timezone = TimeZone.getDefault().id))
        }
        storage = Storage(appContext)
        computer = Computer(appContext, { store.boxDir(it) }, ::emit)
        mcp = McpManager()
        runner = Runner(store, computer, storage, host, ::emit, mcp, scope)
        scheduler = Scheduler(store, runner, ::emit, scope)
        webhooks = WebhookServer(::fireWebhook).also { it.start() }

        scope.launch { mcp.sync(store.getSettings().plugins) }
        scope.launch { checkProvider(force = true) }
        scheduler.start()
    }

    private fun emit(event: HaloEvent) {
        scope.launch { _events.emit(event) }
        // A bot waiting on permission is the one thing worth interrupting the user for.
        if (event is HaloEvent.ApprovalAsked && !inForeground) {
            Notifications.approval(appContext, event.approval)
        }
        if (event is HaloEvent.ApprovalResolved) Notifications.clearApproval(appContext, event.id)
    }

    private val host = object : HostPort {
        override fun freeBytes(dir: File): Long = runCatching {
            val stat = StatFs(dir.absolutePath)
            stat.availableBlocksLong * stat.blockSizeLong
        }.getOrDefault(0L)

        override fun totalMemoryBytes(): Long = runCatching {
            val info = ActivityManager.MemoryInfo()
            appContext.getSystemService(ActivityManager::class.java).getMemoryInfo(info)
            info.totalMem
        }.getOrDefault(0L)

        override fun notify(agent: Agent, message: Message) {
            if (inForeground) return
            Notifications.message(appContext, agent, message)
        }

        override fun webhookUrl(token: String): String = webhooks.url(token)
    }

    // ------------------------------------------------------------------ snapshot

    fun snapshot() = Snapshot(
        agents = store.listAgents(),
        channels = store.listChannels(),
        settings = store.getSettings(),
        routines = store.listRoutines(),
        approvals = runner.pendingApprovals(),
    )

    data class Snapshot(
        val agents: List<Agent>,
        val channels: List<com.halo.bot.core.Channel>,
        val settings: Settings,
        val routines: List<Routine>,
        val approvals: List<ApprovalRequest>,
    )

    fun saveSettings(patch: (Settings) -> Settings): Settings {
        val next = store.saveSettings(patch(store.getSettings()))
        scope.launch { mcp.sync(next.plugins) }
        scope.launch { checkProvider(force = true) }
        scope.launch { _events.emit(HaloEvent.SettingsChanged(next)) }
        return next
    }

    // ------------------------------------------------------------------ bots

    /**
     * A new bot, greeted and started, the way the desktop build's `halo:agent.create` does it.
     *
     * The two halves after the record are not decoration. The greeting means the first thing in a new
     * chat is a bot rather than an empty box, and the kickstart means a bot created *with a brief*
     * does one short pass on its own — which is the difference between a teammate and a form somebody
     * filled in. A bot created without a brief has nothing to take a pass at, so it does not get one.
     */
    fun createBot(
        name: String,
        title: String,
        description: String,
        color: String,
        personaId: String? = null,
        persona: String? = null,
        model: String? = null,
    ): Agent {
        val agent = store.createAgent(
            com.halo.bot.core.Agent(
                id = "",
                name = name,
                title = title,
                description = description,
                avatar = com.halo.bot.core.AgentAvatar(color = color, face = (0..8).random()),
                personaId = personaId,
                persona = persona,
                model = model,
            ),
        )
        emit(HaloEvent.Agents(store.listAgents()))

        val greeting = store.appendMessage(
            Message(
                id = java.util.UUID.randomUUID().toString(),
                agentId = agent.id,
                role = com.halo.bot.core.Role.AGENT,
                text = "Hey, I'm ${agent.name}. What do you want me working on? " +
                    "Give me something concrete and I'll take it from there.",
                createdAt = System.currentTimeMillis(),
            ),
        )
        emit(HaloEvent.NewMessage(greeting))

        if (agent.description.isNotBlank()) {
            runner.submitSystemTurn(
                agent.id,
                "You were just created for this role. Take one short first pass on your own: " +
                    "look at what is already in your box, set up whatever your role needs (folders, a catalog, a routine), " +
                    "then send ONE short message saying what you found and what you will do. Do not ask questions yet.",
                "First pass",
                "note",
            )
        }
        return agent
    }

    /** A bot as the `.halobot.json` both builds read. See core/Portable.kt. */
    fun exportBot(agentId: String): String {
        val agent = store.getAgent(agentId) ?: return ""
        val skillsDir = File(store.agentDir(agentId), "skills")
        val skills = skillsDir.listFiles().orEmpty()
            .filter { it.name.endsWith(".md") }
            .map { com.halo.bot.core.PortableSkill(it.name, it.readText()) }
        return com.halo.bot.core.HaloJsonPretty.encodeToString(
            com.halo.bot.core.PortableBot.serializer(),
            com.halo.bot.core.buildPortableBot(
                agent = agent,
                memory = runner.memory(agentId).exportText(),
                skills = skills,
                routines = store.listRoutines().filter { it.agentId == agentId },
            ),
        )
    }

    /** The other half. Returns null when the file is not a Halo bot, rather than half-importing one. */
    fun importBot(text: String): Agent? {
        val payload = com.halo.bot.core.parsePortableBot(text) ?: return null
        val agent = store.createAgent(
            com.halo.bot.core.Agent(
                id = "",
                name = payload.agent.name,
                title = payload.agent.title,
                description = payload.agent.description,
                avatar = payload.agent.avatar,
                model = payload.agent.model,
                personaId = payload.agent.personaId,
                persona = payload.agent.persona,
            ),
        )
        if (payload.memory.isNotBlank()) runner.memory(agent.id).importText(payload.memory)
        if (payload.skills.isNotEmpty()) {
            val dir = File(store.agentDir(agent.id), "skills").apply { mkdirs() }
            for (skill in payload.skills) File(dir, File(skill.file).name).writeText(skill.body)
        }
        for (routine in payload.routines) {
            store.saveRoutine(
                Routine(
                    id = java.util.UUID.randomUUID().toString(),
                    agentId = agent.id,
                    name = routine.name,
                    prompt = routine.prompt,
                    triggers = routine.triggers,
                    enabled = routine.enabled,
                    createdAt = System.currentTimeMillis(),
                    nextRunAt = com.halo.bot.core.nextRun(
                        Routine(id = "", agentId = agent.id, name = routine.name, prompt = "", triggers = routine.triggers),
                    ),
                ),
            )
        }
        emit(HaloEvent.Agents(store.listAgents()))
        emit(HaloEvent.RoutinesChanged(store.listRoutines()))
        return agent
    }

    // ------------------------------------------------------------------ provider

    /** Tells the user the model server is down before a bot fails mid-task. */
    suspend fun checkProvider(force: Boolean = false) {
        val provider: ProviderSettings = store.getSettings().provider
        // No default model ships: a made-up tag would fail on the first turn instead of at setup.
        if (provider.model.isBlank()) {
            if (force || providerHealthy != false) {
                providerHealthy = false
                scheduler.providerHealthy = false
                providerError = "no model chosen yet — pick one in Settings → Model"
                emit(HaloEvent.ProviderHealth(false, provider.baseUrl, "", providerError, "model"))
            }
            return
        }
        try {
            val detailed = listModelsDetailed(provider)
            val chosen = detailed.firstOrNull { it.id == provider.model }
            // A model without tool support cannot drive anything, so say so instead of failing every turn.
            if (chosen != null && chosen.capabilities.isNotEmpty() && "tools" !in chosen.capabilities) {
                providerHealthy = false
                scheduler.providerHealthy = false
                providerError = "${provider.model} does not support tool calling — pick another model"
                emit(HaloEvent.ProviderHealth(false, provider.baseUrl, provider.model, providerError, "model"))
                return
            }
            val ok = detailed.isNotEmpty()
            scheduler.providerHealthy = ok
            if (force || providerHealthy != ok) {
                providerHealthy = ok
                providerError = if (ok) null else "the server answered but offers no models"
                emit(HaloEvent.ProviderHealth(ok, provider.baseUrl, provider.model, providerError, if (ok) null else "model"))
            }
        } catch (error: Exception) {
            if (force || providerHealthy != false) {
                providerHealthy = false
                scheduler.providerHealthy = false
                providerError = (error.message ?: error.toString()).take(200)
                // A missing or malformed server address is a settings problem, not a server that is
                // down; "unreachable at <blank>" is the wrong sentence for it.
                val kind = if ((error as? ProviderError)?.reason == FailureReason.MISSING_CONFIG) "model" else "unreachable"
                emit(HaloEvent.ProviderHealth(false, provider.baseUrl, provider.model, providerError, kind))
            }
        }
    }

    // ------------------------------------------------------------------ routines

    /**
     * Runs whichever routine owns this webhook token. Returns false for an unknown or disabled token,
     * which the listener turns into a flat 404: a caller learns nothing about which tokens exist.
     */
    private fun fireWebhook(token: String): Boolean {
        val routine = store.listRoutines().firstOrNull { r ->
            r.enabled && r.triggers.any { it.kind == "webhook" && it.token == token }
        } ?: return false
        val at = System.currentTimeMillis()
        runner.submitSystemTurn(routine.agentId, routine.prompt, "Routine \"${routine.name}\" (webhook)", "routine") { ok, note ->
            recordRoutineRun(routine.id, at, ok, if (note != null) "webhook — $note" else "webhook")
        }
        store.saveRoutine(routine.copy(lastRunAt = at))
        emit(HaloEvent.RoutinesChanged(store.listRoutines()))
        return true
    }

    private fun recordRoutineRun(id: String, at: Long, ok: Boolean, note: String?) {
        val routine = store.getRoutine(id) ?: return
        store.saveRoutine(
            routine.copy(runs = (routine.runs + RoutineRun(at, if (ok) "ok" else "error", note)).takeLast(20)),
        )
        emit(HaloEvent.RoutinesChanged(store.listRoutines()))
    }

    /** Fires a routine now, from the editor's "Run now". */
    fun runRoutineNow(id: String) {
        val routine = store.getRoutine(id) ?: return
        val at = System.currentTimeMillis()
        runner.submitSystemTurn(routine.agentId, routine.prompt, "Routine \"${routine.name}\" (manual)", "routine") { ok, note ->
            recordRoutineRun(routine.id, at, ok, note)
        }
    }

    /** Asks the window to open one conversation. What a notification tap turns into. */
    fun focus(conversationId: String) {
        scope.launch { _events.emit(HaloEvent.Focus(conversationId)) }
    }

    fun workingCount(): Int = store.listAgents().count { it.status == AgentStatus.WORKING }

    fun tick() = scheduler.tick()
}
