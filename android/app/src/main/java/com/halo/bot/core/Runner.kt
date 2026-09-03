package com.halo.bot.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.util.Collections
import java.util.UUID

private const val HISTORY_LIMIT = 80
private const val MAX_CHANNEL_HOPS = 3

/**
 * Below this, a prompt cannot have carried Halo's instructions and its toolset.
 *
 * The system prompt is ~1500 tokens and the tool schemas are a few thousand more, so a server that
 * reports having read fewer than this truncated the request rather than answered it.
 */
private const val PROMPT_FLOOR_TOKENS = 4200

/** Surfaces worth a model review; reading a page or listing files is not one of them. */
private val REVIEWED_SURFACES = setOf(
    ApprovalSurface.EXTERNAL_SHELL,
    ApprovalSurface.EXTERNAL_READ,
    ApprovalSurface.FILE_WRITE,
    ApprovalSurface.SHELL,
)

private class QueueItem(
    val text: String,
    val images: List<String> = emptyList(),
    val done: ((Boolean, String?) -> Unit)? = null,
)

private class PendingApproval(val request: ApprovalRequest, val resolve: CompletableDeferred<ApprovalDecision>)

private class BackgroundShell(
    val command: String,
    val agentId: String,
    val startedAt: Long,
    val result: Deferred<ShellResult>,
) {
    @Volatile var done = false
}

class Runner(
    private val store: Store,
    private val computer: ComputerPort,
    private val storage: StoragePort,
    private val host: HostPort,
    private val emitEvent: (HaloEvent) -> Unit,
    private val mcp: McpManager? = null,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + kotlinx.coroutines.Dispatchers.Default),
) : RunnerPort {

    val audit = AuditLog(store.root)

    private val queues = HashMap<String, ArrayDeque<QueueItem>>()
    private val running = HashSet<String>()
    private val jobs = HashMap<String, Job>()
    private val cancelled = Collections.synchronizedSet(HashSet<String>())
    private val approvals = LinkedHashMap<String, PendingApproval>()
    private val memories = HashMap<String, MemoryStore>()
    private val skillStores = HashMap<String, SkillStore>()
    private val background = LinkedHashMap<String, BackgroundShell>()
    private val subagents = LinkedHashMap<String, SubagentRun>()

    /** How many bot-to-bot hops a room has taken since the user last spoke. */
    private val channelHops = HashMap<String, Int>()
    private val lock = Mutex()

    // ---------------------------------------------------------------- audit

    /**
     * One row on the trail. Written before the action runs, never after it succeeded.
     *
     * An action that was not recorded did not happen, because there is no path that acts without
     * writing the row first. A permitted action that then fails gets its own row rather than an edit
     * to this one: "allowed" and "happened" are different facts, and a reader takes the first for the
     * second unless the trail says otherwise.
     */
    private fun record(
        agentId: String,
        tool: String,
        surface: String,
        action: ActionSummary,
        outcome: String,
        verdict: Verdict? = null,
        failure: String? = null,
        dryRun: Boolean = false,
    ) {
        val row = audit.write(
            AuditRow(
                at = System.currentTimeMillis(),
                agentId = agentId,
                agentName = store.getAgent(agentId)?.name ?: "a deleted bot",
                tool = tool,
                surface = surface,
                intent = action.intent,
                summary = action.summary,
                detail = action.detail,
                outcome = outcome,
                source = verdict?.source ?: "none",
                matched = verdict?.matched,
                failure = failure,
                dryRun = dryRun,
            ),
        )
        emitEvent(HaloEvent.Audited(row))
    }

    // ------------------------------------------------------------ public API

    fun pendingApprovals(): List<ApprovalRequest> = synchronized(approvals) { approvals.values.map { it.request } }

    fun isBusy(agentId: String): Boolean = synchronized(running) {
        running.any { parseConversationKey(it).first == agentId }
    }

    /** A message the user posted in a channel: every addressed bot answers in the same room. */
    fun submitChannelMessage(channelId: String, text: String): Message? {
        val channel = store.getChannel(channelId) ?: return null
        val msg = store.appendMessage(
            Message(UUID.randomUUID().toString(), channelId, Role.USER, text, System.currentTimeMillis()),
        )
        emitEvent(HaloEvent.NewMessage(msg))
        channelHops[channelId] = 0
        for (botId in addressedMembers(channel, text)) enqueue(botId, text, channelId)
        return msg
    }

    /**
     * A bot posting into a channel. Only an explicit @mention pulls a teammate in, and the room stops
     * after a few hops so two bots cannot volley forever without the user.
     */
    private fun postToChannel(channelId: String, fromAgentId: String, text: String) {
        val channel = store.getChannel(channelId) ?: return
        val hops = channelHops[channelId] ?: 0
        if (hops >= MAX_CHANNEL_HOPS) return
        val mentioned = mentionedMembers(channel, text).filter { it != fromAgentId }
        if (mentioned.isEmpty()) return
        channelHops[channelId] = hops + 1
        for (botId in mentioned) enqueue(botId, text, channelId)
    }

    /** @mentions pick the responders; with none, everyone in the room answers. */
    private fun addressedMembers(channel: Channel, text: String): List<String> {
        val mentioned = mentionedMembers(channel, text)
        if (mentioned.isNotEmpty()) return mentioned
        return channel.memberIds.filter { store.getAgent(it) != null }
    }

    private fun mentionedMembers(channel: Channel, text: String): List<String> {
        val members = channel.memberIds.mapNotNull { store.getAgent(it) }
        val hit = mentionedNames(members.map { it.name }, text).toSet()
        return members.filter { it.name in hit }.map { it.id }
    }

    /** A message typed by the user. */
    fun submitUserMessage(agentId: String, text: String, attachments: List<Attachment> = emptyList()): Message {
        val images = attachments.filter { imageMime(it.path) != null }
        val msg = store.appendMessage(
            Message(
                id = UUID.randomUUID().toString(),
                agentId = agentId,
                role = Role.USER,
                text = text,
                createdAt = System.currentTimeMillis(),
                attachments = attachments,
            ),
        )
        emitEvent(HaloEvent.NewMessage(msg))
        val other = attachments - images.toSet()
        val note = if (other.isNotEmpty()) {
            "\n\nThe user attached: " + other.joinToString(", ") { it.path } + " (in your box)."
        } else {
            ""
        }
        // Images are shown to the model directly rather than described as file paths.
        val inline = if (store.getSettings().provider.vision) images.mapNotNull { imageDataUrl(it.path) } else emptyList()
        enqueue(agentId, text + note, null, inline)
        return msg
    }

    /** A routine firing, or another bot handing over work. */
    fun submitSystemTurn(
        agentId: String,
        text: String,
        label: String,
        kind: String = "note",
        done: ((Boolean, String?) -> Unit)? = null,
    ) {
        systemEvent(agentId, SystemEvent(kind, label, text.replace(Regex("\\s+"), " ").take(80)))
        enqueue(agentId, "[$label]\n$text", null, emptyList(), done)
    }

    fun stop(agentId: String) {
        // An approval nobody will answer would hold the turn open forever, and with it the whole
        // conversation queue. Stopping has to settle it, not just cancel the model call.
        synchronized(approvals) {
            for ((id, pending) in approvals.toList()) {
                if (pending.request.agentId != agentId) continue
                approvals.remove(id)
                pending.resolve.complete(ApprovalDecision.NEVER)
                emitEvent(HaloEvent.ApprovalResolved(id, false))
            }
        }
        synchronized(running) {
            for (key in running.toList()) {
                if (parseConversationKey(key).first == agentId) cancelled.add(key)
            }
        }
        synchronized(queues) {
            for (key in queues.keys.toList()) {
                if (parseConversationKey(key).first != agentId) continue
                queues[key]?.forEach { it.done?.invoke(false, "stopped") }
                queues[key]?.clear()
            }
        }
        synchronized(jobs) { jobs.keys.filter { parseConversationKey(it).first == agentId }.forEach { jobs[it]?.cancel() } }
    }

    fun resolveApproval(id: String, decision: ApprovalDecision) {
        val pending = synchronized(approvals) { approvals.remove(id) } ?: return
        if (decision == ApprovalDecision.ALWAYS || decision == ApprovalDecision.NEVER) {
            rememberDecision(pending.request, decision)
        }
        pending.resolve.complete(decision)
        emitEvent(HaloEvent.ApprovalResolved(id, decision != ApprovalDecision.NEVER))
    }

    /**
     * "Always allow" and "Never" are sticky, and scoped to the action that was in front of the user.
     *
     * The desktop build learned this the hard way: a rule written from the approval line alone matched
     * every later command word for word, so one "Always allow" on `git status` became standing
     * permission to run anything. The rule carries the surface, the intent, and for a shell the first
     * words of the command.
     */
    private fun rememberDecision(request: ApprovalRequest, decision: ApprovalDecision) {
        val settings = store.getSettings()
        val rule = AutoReviewRule(
            id = UUID.randomUUID().toString(),
            trigger = request.summary,
            decision = if (decision == ApprovalDecision.ALWAYS) "allow" else "deny",
            surface = request.surface,
            intent = request.intent,
            commandPrefix = request.command?.let { commandPrefixOf(it) },
        )
        val already = settings.rules.any { r ->
            r.surface == rule.surface && r.commandPrefix == rule.commandPrefix &&
                (rule.commandPrefix != null || r.trigger == rule.trigger)
        }
        if (already) return
        val next = store.saveSettings(settings.copy(rules = settings.rules + rule))
        emitEvent(HaloEvent.SettingsChanged(next))
    }

    /** A muted, centered line in the transcript. */
    fun systemEvent(agentId: String, event: SystemEvent): Message {
        val msg = store.appendMessage(
            Message(
                id = UUID.randomUUID().toString(),
                agentId = agentId,
                role = Role.SYSTEM,
                text = event.label,
                createdAt = System.currentTimeMillis(),
                event = event,
            ),
        )
        emitEvent(HaloEvent.NewMessage(msg))
        return msg
    }

    // -------------------------------------------------------------- RunnerPort

    override fun createAgent(name: String, title: String, description: String, color: String): Agent {
        val agent = store.createAgent(
            Agent(
                id = "",
                name = name,
                title = title,
                description = description,
                avatar = AgentAvatar(color = color, face = (0..8).random()),
            ),
        )
        emitEvent(HaloEvent.Agents(store.listAgents()))
        return agent
    }

    override fun updateAgent(id: String, patch: (Agent) -> Agent): Agent? {
        val next = store.updateAgent(id, patch)
        if (next != null) emitEvent(HaloEvent.Agents(store.listAgents()))
        return next
    }

    /** A bot posting into a room it belongs to: the message lands in the transcript for everyone. */
    override fun postToRoom(channelId: String, fromAgentId: String, text: String) {
        store.getChannel(channelId) ?: return
        val message = store.appendMessage(
            Message(
                id = UUID.randomUUID().toString(),
                agentId = channelId,
                role = Role.AGENT,
                text = text,
                createdAt = System.currentTimeMillis(),
                fromAgentId = fromAgentId,
            ),
        )
        emitEvent(HaloEvent.NewMessage(message))
        postToChannel(channelId, fromAgentId, text)
    }

    override fun deliverToAgent(fromAgentId: String, toAgentId: String, text: String) {
        val from = store.getAgent(fromAgentId)
        val name = from?.name ?: "another bot"
        systemEvent(toAgentId, SystemEvent("handoff", "Message from", name, from?.id))
        // A teammate is another model, which may itself have been talked into something by a page
        // it read. Its message is outside content and arrives fenced, the same as anything a tool
        // brought back.
        enqueue(toAgentId, "[Message from $name]\n" + fenceContent("teammate:$name", text))
    }

    /**
     * A subagent is a narrow, background run of the same loop with a subset of tools and no voice of
     * its own: it reports back to the bot that dispatched it, the way the original's Task works.
     */
    override fun dispatchSubagent(
        parentAgentId: String,
        kind: SubagentKind,
        description: String,
        prompt: String,
    ): String {
        val id = "task_" + UUID.randomUUID().toString().take(6)
        val run = SubagentRun(id, kind, parentAgentId, description)
        synchronized(subagents) { subagents[id] = run }
        run.job = scope.launch { runSubagent(parentAgentId, run, prompt) }
        return id
    }

    override fun checkSubagent(id: String): String {
        val run = synchronized(subagents) { subagents[id] } ?: return "No subagent called $id."
        val age = (System.currentTimeMillis() - run.startedAt) / 1000
        val steps = synchronized(run.steps) { run.steps.takeLast(8).joinToString("\n") }.ifEmpty { "(nothing yet)" }
        return "$id [${run.kind.wire}] ${run.status}, ${age}s in.\nRecent actions:\n$steps" +
            if (run.report.isNotEmpty()) "\n\nReport:\n${run.report}" else ""
    }

    /**
     * A correction to a worker that is already running, rather than a replacement for it.
     *
     * The original's `MessageSubagent` (docs/GROK_BOT_INTERNALS.md) exists because stopping a worker
     * and dispatching a new one throws away everything it has already found — the pages it read, the
     * files it wrote — to deliver one sentence. The note is picked up before the worker's next step,
     * so it lands between two model calls rather than in the middle of one.
     */
    override fun messageSubagent(id: String, text: String): String {
        val run = synchronized(subagents) { subagents[id] } ?: return "No subagent called $id."
        if (run.status != "running") return "$id already finished (${run.status}). Its report is in your chat."
        if (text.isBlank()) return "Give it something to act on."
        synchronized(run.inbox) { run.inbox.add(text.trim()) }
        return "Passed on to $id. It reads this before its next step and keeps everything it has done so far."
    }

    override fun stopSubagent(id: String): String {
        val run = synchronized(subagents) { subagents[id] } ?: return "No subagent called $id."
        run.job?.cancel()
        run.status = "stopped"
        return "Stopped $id."
    }

    /** Everything currently running for a bot: background workers and background shells. */
    fun listTasks(agentId: String): List<Map<String, String>> {
        val out = mutableListOf<Map<String, String>>()
        synchronized(subagents) {
            for (run in subagents.values) {
                if (run.parentAgentId != agentId) continue
                out.add(
                    mapOf(
                        "id" to run.id,
                        "kind" to run.kind.wire,
                        "description" to run.description,
                        "status" to run.status,
                        "seconds" to ((System.currentTimeMillis() - run.startedAt) / 1000).toString(),
                        "steps" to synchronized(run.steps) { run.steps.size }.toString(),
                    ),
                )
            }
        }
        synchronized(background) {
            for ((id, entry) in background) {
                if (entry.agentId != agentId || entry.done) continue
                out.add(
                    mapOf(
                        "id" to id,
                        "kind" to "shell",
                        "description" to entry.command.take(80),
                        "status" to "running",
                        "seconds" to ((System.currentTimeMillis() - entry.startedAt) / 1000).toString(),
                        "steps" to "0",
                    ),
                )
            }
        }
        return out.sortedByDescending { it["seconds"]?.toIntOrNull() ?: 0 }
    }

    fun memory(agentId: String): MemoryStore = synchronized(memories) {
        memories.getOrPut(agentId) { MemoryStore(store, agentId) }
    }

    fun skills(agentId: String): SkillStore = synchronized(skillStores) {
        skillStores.getOrPut(agentId) { SkillStore(store, agentId) }
    }

    // ------------------------------------------------------------ background shells

    /** Long commands run detached and wake the agent up when they finish. */
    private fun startBackground(agentId: String, command: String, cwd: File): String {
        val id = "sh_" + UUID.randomUUID().toString().take(6)
        val deferred = scope.async { runShell(command, cwd, 30 * 60_000L) }
        val entry = BackgroundShell(command, agentId, System.currentTimeMillis(), deferred)
        synchronized(background) { background[id] = entry }
        scope.launch {
            val result = runCatching { deferred.await() }.getOrElse { ShellResult(-1, it.message ?: "cancelled") }
            entry.done = true
            val tail = result.out.trim().split("\n").takeLast(20).joinToString("\n")
            submitSystemTurn(
                agentId,
                "Background shell $id finished with exit ${result.code}.\nCommand: $command\nLast output:\n" +
                    fenceContent("shell:$id", tail),
                "Background command finished",
            )
        }
        return id
    }

    private suspend fun awaitBackground(id: String, timeoutMs: Long): String {
        val entry = synchronized(background) { background[id] } ?: return "No background shell called $id."
        val result = withTimeoutOrNull(timeoutMs) { entry.result.await() }
            ?: return "$id is still running. Keep working; you will be told when it finishes."
        return "exit ${result.code}\n" + result.out.ifBlank { "(no output)" }
    }

    // ------------------------------------------------------------------- engine

    private fun enqueue(
        agentId: String,
        text: String,
        channelId: String? = null,
        images: List<String> = emptyList(),
        done: ((Boolean, String?) -> Unit)? = null,
    ) {
        val key = conversationKey(agentId, channelId)
        synchronized(queues) { queues.getOrPut(key) { ArrayDeque() }.addLast(QueueItem(text, images, done)) }
        scope.launch { drain(key) }
    }

    private suspend fun drain(key: String) {
        synchronized(running) {
            if (key in running) return
            if (synchronized(queues) { queues[key]?.isEmpty() ?: true }) return
            running.add(key)
        }
        cancelled.remove(key)
        val (agentId, channelId) = parseConversationKey(key)
        setStatus(agentId, AgentStatus.WORKING)
        try {
            while (true) {
                val item = synchronized(queues) { queues[key]?.removeFirstOrNull() } ?: break
                val outcome = runTurn(agentId, item.text, channelId, item.images, key)
                item.done?.invoke(outcome.first, outcome.second)
                if (key in cancelled) break
            }
        } finally {
            synchronized(running) { running.remove(key) }
            cancelled.remove(key)
            setStatus(agentId, AgentStatus.IDLE)
        }
    }

    private fun setStatus(agentId: String, status: AgentStatus, note: String? = null) {
        store.updateAgent(agentId) { it.copy(status = status) }
        emitEvent(HaloEvent.Status(agentId, status, note))
    }

    private fun toolSchemas(): List<ToolSchema> {
        val base = TOOLS.map { it.schema }
        val plugins = mcp?.toolSchemas().orEmpty()
        // A handful of plugin tools is cheaper to carry than to look up. A shelf of them is not: past
        // the limit they turn into two meta-tools the bot calls on demand, which is what keeps the
        // prompt inside a small model's window.
        return if (plugins.size <= McpManager.INLINE_LIMIT) base + plugins else base + mcp?.metaSchemas().orEmpty()
    }

    /** Folds old turns into a summary so a long-running bot never outgrows its context. */
    private suspend fun compactIfNeeded(
        historyId: String,
        historySuffix: String?,
        agentId: String,
        /** Set when the model has already said the context is too long, so the budget is not the judge. */
        forced: Boolean = false,
    ) {
        val settings = store.getSettings()
        val raw = store.llmHistory(historyId, historySuffix).map { chatMessageFromJson(it) }
        if (raw.size < 12) return
        if (!forced && estimateTokens(raw) <= settings.provider.contextBudget) return

        val provider = if (settings.provider.helperModel.isNotBlank()) {
            settings.provider.copy(model = settings.provider.helperModel)
        } else {
            settings.provider
        }
        val result = compactHistory(
            provider,
            raw,
            // Forced means the model itself refused the length, so the configured budget was wrong for
            // this model. Aim well under it rather than at it, or the retry overflows again.
            tokenBudget = if (forced) settings.provider.contextBudget / 2 else settings.provider.contextBudget,
            keepLast = if (forced) 6 else 12,
            forced = forced,
        )
        if (!result.compacted) return
        store.replaceLlmHistory(historyId, result.messages.map { chatMessageToJson(it) }, historySuffix)
        systemEvent(agentId, SystemEvent("note", "Older turns folded into a summary"))
    }

    private fun history(conversationId: String, suffix: String?): List<ChatMessage> {
        val raw = store.llmHistory(conversationId, suffix).map { chatMessageFromJson(it) }
        if (raw.size <= HISTORY_LIMIT) return raw
        // Keep the tail, but never start on an orphaned tool result.
        var start = raw.size - HISTORY_LIMIT
        while (start < raw.size && raw[start].role == "tool") start++
        return raw.drop(start)
    }

    private fun systemPrompt(agent: Agent, channelId: String?): String {
        // Kept in step with the running version rather than with whatever version created the box.
        ensureReference(store.boxDir(agent.id))
        val routines = store.listRoutines().filter { it.agentId == agent.id }.map { r ->
            "${r.name} — ${describeTriggers(r.triggers)}" + if (r.enabled) "" else " (disabled)"
        }
        val channel = channelId?.let { store.getChannel(it) }
        return buildSystemPrompt(
            PromptInput(
                agent = agent,
                settings = store.getSettings(),
                boxDir = store.boxDir(agent.id),
                memory = memory(agent.id).render(),
                teammates = store.listAgents(),
                routines = routines,
                skills = skills(agent.id).list().map { "${it.name} — ${it.description}" },
                channels = store.listChannels().filter { agent.id in it.memberIds }.map { "${it.name} (id ${it.id})" },
                channel = channel?.let { c -> c.name to c.memberIds.mapNotNull { store.getAgent(it)?.name } },
            ),
        )
    }

    private suspend fun runTurn(
        agentId: String,
        userText: String,
        channelId: String?,
        images: List<String>,
        key: String,
    ): Pair<Boolean, String?> {
        val agent = store.getAgent(agentId) ?: return false to "the bot no longer exists"
        val settings = store.getSettings()
        val isCancelled = { key in cancelled }

        // In a channel the transcript belongs to the room; each bot keeps its own model history in it.
        val target = channelId ?: agentId
        val historyId = channelId ?: agentId
        val historySuffix = channelId?.let { agentId }

        runCatching { compactIfNeeded(historyId, historySuffix, agentId) }
        // The reminder is added to the request, not to the stored history: it is a nudge for this call,
        // not a fact about the conversation, and storing it would re-send it forever.
        store.appendLlm(
            historyId,
            chatMessageToJson(ChatMessage("user", userText, images = images)),
            historySuffix,
        )

        // The assistant "activity" record: tool cards attach to it, and the UI streams into it.
        var activity: Message? = null
        fun ensureActivity(): Message {
            activity?.let { return it }
            val created = store.appendMessage(
                Message(
                    id = UUID.randomUUID().toString(),
                    agentId = target,
                    role = Role.AGENT,
                    text = "",
                    createdAt = System.currentTimeMillis(),
                    fromAgentId = channelId?.let { agentId },
                ),
            )
            activity = created
            emitEvent(HaloEvent.NewMessage(created))
            return created
        }

        var deliveredSomething = false
        /*
         * Grok Bot 0.24 stopped treating "reply first" as advice and made the runtime count a delivery
         * the turn owes (`sand_send_message_delivery_owed`, docs/GROK_BOT_0.24_0.27_TEARDOWN.md §3). The
         * failure it catches is the expensive one: the bot does the work, then ends the turn with the
         * result only in its own head. One nudge, once — a second would be a loop.
         */
        var workedThisTurn = false
        var nudgedForDelivery = false
        var widgetSent = false
        /** One compaction per turn: a second overflow means the tail alone does not fit. */
        var compactedForOverflow = false
        /** What the bot actually told the user, so a routine can be fed its own last report. */
        var lastDelivered = ""
        /** How much of the request the server admitted it read, used to spot a truncating window. */
        var lastPromptTokens = 0
        val sentTexts = HashSet<String>()

        val ctx = ToolContext(
            agentId = agentId,
            store = store,
            emit = { emitEvent(it) },
            sendMessage = { text, inline ->
                // A weak model can re-send the same line five times; deliver it once.
                val dedupe = text.trim().lowercase()
                if (dedupe.isNotEmpty() && !sentTexts.add(dedupe)) {
                    deliveredSomething = true
                    Message("duplicate", target, Role.AGENT, text, System.currentTimeMillis())
                } else {
                    lastDelivered = text
                    val msg = store.appendMessage(
                        Message(
                            id = UUID.randomUUID().toString(),
                            agentId = target,
                            role = Role.AGENT,
                            text = text,
                            createdAt = System.currentTimeMillis(),
                            images = inline,
                            fromAgentId = channelId?.let { agentId },
                        ),
                    )
                    emitEvent(HaloEvent.NewMessage(msg))
                    deliveredSomething = true
                    store.getAgent(agentId)?.let { if (it.notifications) host.notify(it, msg) }
                    if (channelId != null) postToChannel(channelId, agentId, text)
                    msg
                }
            },
            systemEvent = { systemEvent(agentId, it) },
            sendWidget = { widget ->
                widgetSent = true
                val msg = store.appendMessage(
                    Message(
                        id = UUID.randomUUID().toString(),
                        // a question asked in a room belongs in that room, next to the exchange
                        agentId = target,
                        role = Role.AGENT,
                        text = "",
                        createdAt = System.currentTimeMillis(),
                        widget = widget,
                        fromAgentId = channelId?.let { agentId },
                    ),
                )
                emitEvent(HaloEvent.NewMessage(msg))
                deliveredSomething = true
                msg
            },
            computer = computer,
            storage = storage,
            host = host,
            runner = this,
            memory = memory(agentId),
            skills = skills(agentId),
            isCancelled = isCancelled,
            startBackground = { command, cwd -> startBackground(agentId, command, cwd) },
            awaitBackground = { id, timeout -> awaitBackground(id, timeout) },
            pluginStatus = { mcp?.statuses().orEmpty() },
        )

        try {
            for (step in 0 until settings.provider.maxSteps) {
                if (isCancelled()) break
                // A question ends the turn: their answer arrives as the next message. Checked before
                // the call, so asking never costs a round trip or leaves tool_calls without results.
                if (widgetSent) break

                val messages = withReplyReminder(
                    listOf(ChatMessage("system", systemPrompt(agent, channelId))) + history(historyId, historySuffix),
                )

                var streamed = StringBuilder()
                val startedAt = System.currentTimeMillis()
                val providerForAgent = providerFor(settings.provider, agent)
                val stream: (String) -> Unit = { chunk ->
                    streamed.append(chunk)
                    val a = ensureActivity()
                    emitEvent(HaloEvent.MessagePatch(target, a.id, text = streamed.toString()))
                }

                val result = try {
                    chat(providerForAgent, messages, toolSchemas(), stream, isCancelled)
                } catch (error: Throwable) {
                    /*
                     * The one failure worth a second attempt after changing something.
                     *
                     * A context overflow is not transient — the same call fails the same way forever —
                     * but it has exactly one fix, and the app already has it. Compact, then try once
                     * more, on the same conversation rather than a fresh one, so nothing the bot knows
                     * is thrown away to recover from being verbose. Every other class falls straight
                     * through: an expired key is not going to work on the third try.
                     */
                    if (classifyProviderError(error) != FailureReason.CONTEXT_OVERFLOW || compactedForOverflow) throw error
                    compactedForOverflow = true
                    systemEvent(
                        agentId,
                        SystemEvent("note", "Ran out of context — folding older turns into a summary and trying again"),
                    )
                    compactIfNeeded(historyId, historySuffix, agentId, forced = true)
                    val retried = withReplyReminder(
                        listOf(ChatMessage("system", systemPrompt(agent, channelId))) + history(historyId, historySuffix),
                    )
                    streamed = StringBuilder()
                    chat(providerForAgent, retried, toolSchemas(), stream, isCancelled)
                }

                lastPromptTokens = result.promptTokens
                store.recordUsage(
                    UsageRow(
                        at = System.currentTimeMillis(),
                        agentId = agentId,
                        model = providerForAgent.model,
                        promptTokens = result.promptTokens,
                        completionTokens = result.completionTokens,
                        seconds = ((System.currentTimeMillis() - startedAt) / 100) / 10.0,
                    ),
                )

                if (result.text.isNotBlank()) {
                    val a = ensureActivity()
                    store.updateMessage(target, a.id) { it.copy(text = result.text) }
                }

                store.appendLlm(
                    historyId,
                    chatMessageToJson(
                        ChatMessage(
                            "assistant",
                            result.text,
                            toolCalls = result.toolCalls.map {
                                WireToolCall(it.id, it.name, JsonObject(it.args).toString())
                            },
                        ),
                    ),
                    historySuffix,
                )

                if (result.toolCalls.isEmpty()) {
                    // Work happened but nothing was sent: the turn owes a message it never wrote.
                    if (!deliveredSomething && !nudgedForDelivery && workedThisTurn && result.text.isBlank()) {
                        nudgedForDelivery = true
                        store.appendLlm(
                            historyId,
                            chatMessageToJson(
                                ChatMessage(
                                    "user",
                                    "You finished the work but never called SendMessage, so the user has seen nothing at all. Send them the result now, in one or two short messages.",
                                ),
                            ),
                            historySuffix,
                        )
                        continue
                    }
                    // Model answered in plain text. That never reaches the user, so nudge it once.
                    if (!deliveredSomething && result.text.isNotBlank()) {
                        store.appendLlm(
                            historyId,
                            chatMessageToJson(
                                ChatMessage(
                                    "user",
                                    "That text was not delivered — the user cannot see assistant text. Send the same thing through SendMessage now.",
                                ),
                            ),
                            historySuffix,
                        )
                        continue
                    }
                    break
                }

                workedThisTurn = true
                for (call in result.toolCalls) {
                    if (isCancelled()) break
                    if (widgetSent && call.name == "AskUser") {
                        store.appendLlm(
                            historyId,
                            chatMessageToJson(
                                ChatMessage(
                                    "tool",
                                    "You already asked. End the turn and wait for their answer.",
                                    toolCallId = call.id,
                                    name = call.name,
                                ),
                            ),
                            historySuffix,
                        )
                        continue
                    }
                    val outcome = executeTool(ctx, ::ensureActivity, call, target)
                    store.appendLlm(
                        historyId,
                        chatMessageToJson(
                            ChatMessage(
                                "tool",
                                fenceToolResult(call.name, outcome.first),
                                toolCallId = call.id,
                                name = call.name,
                            ),
                        ),
                        historySuffix,
                    )
                    // A screenshot is only useful if the model can actually see it.
                    val dataUrl = outcome.second?.takeIf { settings.provider.vision }?.let { imageDataUrl(it) }
                    if (dataUrl != null) {
                        store.appendLlm(
                            historyId,
                            chatMessageToJson(
                                ChatMessage(
                                    "user",
                                    "Here is the image that tool produced. Look at it before your next step.",
                                    images = listOf(dataUrl),
                                ),
                            ),
                            historySuffix,
                        )
                    }
                }
            }

            /*
             * The streamed draft and the delivered message are the same sentence twice.
             *
             * The activity record exists so tool cards have somewhere to hang and so a long turn
             * streams instead of sitting silent. Once the turn has actually delivered something,
             * that draft is not a second thing the bot said — it is the same one, and a small
             * reasoning model narrates what it is about to send on most turns, so the phone ends up
             * showing the answer twice. The delivered message is the record; the draft goes back to
             * being a container for the cards.
             */
            if (deliveredSomething) {
                activity?.let { a ->
                    if (store.transcript(target).firstOrNull { it.id == a.id }?.text?.isNotBlank() == true) {
                        store.updateMessage(target, a.id) { it.copy(text = "") }
                        emitEvent(HaloEvent.MessagePatch(target, a.id, text = ""))
                    }
                }
            }

            if (!deliveredSomething && !isCancelled()) {
                /*
                 * Almost always the same cause, and it is worth naming rather than leaving as a shrug.
                 * Halo's system prompt plus its tool schemas is several thousand tokens. A server
                 * running a smaller context window silently truncates the request, so the model never
                 * sees the instructions it is being judged against.
                 */
                val short = lastPromptTokens in 1 until PROMPT_FLOOR_TOKENS
                systemEvent(
                    agentId,
                    SystemEvent(
                        "note",
                        if (short) {
                            "Finished without sending a message — the model only saw $lastPromptTokens tokens of a longer prompt, so its context window is too small. Raise it (for Ollama: OLLAMA_CONTEXT_LENGTH=16384)."
                        } else {
                            "Finished without sending a message"
                        },
                    ),
                )
            }

            scope.launch { rememberExchange(agentId, userText) }
            if (isCancelled()) return false to "stopped"
            return true to lastDelivered.takeIf { it.isNotEmpty() }
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            val message = error.message ?: error.toString()
            val reason = classifyProviderError(error)
            val text = if (error is ProviderError) describeFailure(reason, message) else "Turn failed: $message"
            emitEvent(HaloEvent.Failure(agentId, text))
            ctx.sendMessage(text, emptyList())
            // The note is what a routine's run history shows, so it carries a code a person can act on.
            return false to "[${reason.name.lowercase()}] $text".take(160)
        }
    }

    /**
     * The approval gate. Every path that runs a tool goes through it — the main loop and background
     * workers alike — so there is exactly one place where permission is decided.
     */
    private suspend fun gate(
        agentId: String,
        tool: Tool,
        args: Args,
        onNote: ((String) -> Unit)? = null,
    ): Pair<Boolean, String> {
        val surface = tool.surface ?: return true to ""

        val settings = store.getSettings()
        val action = summarize(tool.schema.name, args, store.boxDir(agentId).absolutePath)
        // A tap names a ref; the card and the trail should say what that ref is, resolved from the page
        // this process looked at rather than from whatever the model called it.
        if (tool.schema.name == "Browser" && args.str("ref").isNotBlank()) {
            computer.describeRef(agentId, args.str("ref"))?.let { element ->
                action.element = element
                action.summary = action.summary + " — " + element.first + " \"" + element.second + "\""
            }
        }
        // A broken rule fails closed by design; it must not do so silently, or somebody's typo becomes
        // a bot that refuses everything for a week with nothing saying why.
        val broken = mutableListOf<String>()
        var verdict = decideDetailed(settings, surface, action, store.getAgent(agentId), agentId) { broken.add(it) }
        for (message in broken) {
            systemEvent(agentId, SystemEvent("permission", message.take(160)))
            onNote?.invoke(message)
        }

        // Smart mode asks the model about anything the local rules would wave through.
        if (verdict.decision == Decision.ALLOW &&
            verdict.source != "granted" &&
            settings.autoReview &&
            settings.autoReviewMode == "smart" &&
            surface in REVIEWED_SURFACES
        ) {
            val review = reviewWithModel(settings, surface, action)
            if (review.decision != Decision.ALLOW) {
                verdict = Verdict(review.decision, "review", null, review.reason)
                onNote?.invoke("Safety review: ${review.decision.wire} — ${review.reason}")
            }
        }

        /*
         * Dry-run decides and records without blocking, so somebody can write a rule against real work
         * and read the trail before it starts refusing things. The hardline floor ignores it: those are
         * not a policy anybody is tuning.
         */
        val dryRun = settings.policyMode == "dry-run" && verdict.source != "hardline"
        if (verdict.decision != Decision.ALLOW && dryRun) {
            record(agentId, tool.schema.name, surface.wire, action, "allowed", verdict, dryRun = true)
            return true to ""
        }

        if (verdict.decision == Decision.DENY) {
            record(agentId, tool.schema.name, surface.wire, action, "refused", verdict)
            return false to (verdict.reason + " Tell the user what you wanted to do and why, and do not look for another way round this.")
        }

        if (verdict.decision == Decision.ASK) {
            // A background worker can ask while its parent sits idle, so the old status is put back.
            val prior = store.getAgent(agentId)?.status ?: AgentStatus.IDLE
            setStatus(agentId, AgentStatus.WAITING, action.summary)
            val decision = ask(agentId, surface, action, verdict.reason)
            setStatus(agentId, prior)
            if (decision == ApprovalDecision.NEVER) {
                record(agentId, tool.schema.name, surface.wire, action, "refused", Verdict(Decision.DENY, "user", "declined", ""))
                return false to "The user declined this and asked not to be asked again. Find another way, or tell them what is blocked."
            }
            if (decision == ApprovalDecision.ALWAYS) {
                systemEvent(
                    agentId,
                    SystemEvent(
                        "permission",
                        (store.getAgent(agentId)?.name ?: "This bot") + " can " + permissionPhrase(surface) +
                            (action.command?.let { " starting \"" + commandPrefixOf(it) + "\"" } ?: "") + ".",
                    ),
                )
            }
            record(
                agentId,
                tool.schema.name,
                surface.wire,
                action,
                "allowed",
                Verdict(Decision.ALLOW, "user", decision.name.lowercase(), ""),
            )
            return true to ""
        }

        record(agentId, tool.schema.name, surface.wire, action, "allowed", verdict)
        return true to ""
    }

    private suspend fun executeTool(
        ctx: ToolContext,
        ensureActivity: () -> Message,
        call: ParsedToolCall,
        transcriptId: String,
    ): Pair<String, String?> {
        val activity = ensureActivity()
        val tool = TOOLS_BY_NAME[call.name]
        var record = ToolCallRecord(
            id = call.id,
            name = call.name,
            args = JsonObject(call.args),
            status = "running",
            startedAt = System.currentTimeMillis(),
        )
        fun attach(next: ToolCallRecord) {
            record = next
            store.updateMessage(transcriptId, activity.id) { m ->
                m.copy(toolCalls = m.toolCalls.filter { it.id != next.id } + next)
            }
            emitEvent(HaloEvent.ToolUpdate(transcriptId, activity.id, next))
        }
        attach(record)

        if (tool == null) {
            // The two meta-tools that stand in for inlined plugin schemas. Listing is read-only;
            // calling is routed into the plugin path below so it lands on the trail like any other.
            if (mcp != null && call.name == "ListPluginTools") {
                val output = mcp.catalogue(call.args.str("plugin").takeIf { it.isNotBlank() })
                attach(record.copy(status = "done", endedAt = System.currentTimeMillis(), result = output.take(4000)))
                return output to null
            }
            if (mcp != null && call.name == "CallPluginTool") {
                val name = call.args.str("name")
                if (!mcp.isPluginTool(name)) {
                    val output = (name.ifBlank { "(no name)" }) + " is not a plugin tool. Call ListPluginTools and use a name from it."
                    attach(record.copy(status = "error", endedAt = System.currentTimeMillis(), error = output))
                    return output to null
                }
                return executeTool(ctx, ensureActivity, ParsedToolCall(call.id, name, call.args.obj("arguments")), transcriptId)
            }
            if (mcp?.isPluginTool(call.name) == true) {
                // A plugin reaches somebody else's service with the user's credentials, so it belongs
                // on the trail beside everything else even though there is no local policy to decide it.
                val plugin = ActionSummary(
                    summary = "Plugin call ${call.name}",
                    detail = redact(JsonObject(call.args)).toString().take(800),
                    intent = Intent.PLUGIN_CALL,
                )
                record(ctx.agentId, call.name, "plugin", plugin, "allowed", Verdict(Decision.ALLOW, "plugin", null, ""))
                return try {
                    val output = mcp.call(call.name, call.args)
                    attach(record.copy(status = "done", endedAt = System.currentTimeMillis(), result = output.take(4000)))
                    output to null
                } catch (error: Exception) {
                    val message = error.message ?: error.toString()
                    record(ctx.agentId, call.name, "plugin", plugin, "failed", Verdict(Decision.ALLOW, "plugin", null, ""), failure = message)
                    attach(record.copy(status = "error", endedAt = System.currentTimeMillis(), error = message))
                    "Plugin call failed: $message" to null
                }
            }
            attach(record.copy(status = "error", endedAt = System.currentTimeMillis(), error = "unknown tool"))
            return "No tool named ${call.name}." to null
        }

        val (allowed, refusal) = gate(ctx.agentId, tool, call.args) { note ->
            attach(record.copy(result = note))
        }
        if (!allowed) {
            attach(record.copy(status = "denied", endedAt = System.currentTimeMillis(), error = "blocked"))
            return refusal to null
        }

        return try {
            val res = tool.run(ctx, call.args)
            attach(
                record.copy(
                    status = if (res.isError) "error" else "done",
                    endedAt = System.currentTimeMillis(),
                    result = res.output.take(4000),
                ),
            )
            res.output to res.imagePath
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            val message = error.message ?: error.toString()
            // A permitted action that did not happen gets its own row. Without it the trail lies by
            // omission: the decision row says "allowed", and a reader takes that to mean it ran.
            tool.surface?.let { surface ->
                val action = summarize(tool.schema.name, call.args, store.boxDir(ctx.agentId).absolutePath)
                record(
                    ctx.agentId,
                    call.name,
                    surface.wire,
                    action,
                    "failed",
                    Verdict(Decision.ALLOW, "attempt", null, ""),
                    failure = message,
                )
            }
            attach(record.copy(status = "error", endedAt = System.currentTimeMillis(), error = message))
            "Tool failed: $message" to null
        }
    }

    // ------------------------------------------------------------------ subagents

    private suspend fun runSubagent(parentAgentId: String, run: SubagentRun, prompt: String) {
        val settings = store.getSettings()
        val allowed = SUBAGENT_TOOLS[run.kind].orEmpty()
        val tools = TOOLS.filter { it.schema.name in allowed }
        val agent = store.getAgent(parentAgentId)
        // A worker dispatched by a bot runs on that bot's model, the same as the bot's own turns.
        val provider = providerFor(settings.provider, agent)

        val ctx = ToolContext(
            agentId = parentAgentId,
            store = store,
            emit = {},
            sendMessage = { text, _ ->
                run.report += text + "\n"
                Message("sub", parentAgentId, Role.AGENT, text, System.currentTimeMillis())
            },
            systemEvent = {},
            sendWidget = { Message("sub", parentAgentId, Role.AGENT, "", System.currentTimeMillis()) },
            computer = computer,
            storage = storage,
            host = host,
            runner = this,
            memory = memory(parentAgentId),
            skills = skills(parentAgentId),
            isCancelled = { run.status == "stopped" },
            startBackground = { command, cwd -> startBackground(parentAgentId, command, cwd) },
            awaitBackground = { id, timeout -> awaitBackground(id, timeout) },
        )

        val history = mutableListOf(
            ChatMessage("system", subagentSystemPrompt(run.kind, agent?.name ?: "the bot")),
            ChatMessage("user", prompt),
        )

        try {
            for (step in 0 until 14) {
                if (run.status == "stopped") break
                val startedAt = System.currentTimeMillis()
                // A note from the parent lands between two model calls, never inside one.
                val notes = synchronized(run.inbox) { run.inbox.toList().also { run.inbox.clear() } }
                for (note in notes) {
                    synchronized(run.steps) { run.steps.add("redirected: " + note.take(60)) }
                    history.add(
                        ChatMessage(
                            "user",
                            "[New instruction from ${agent?.name ?: "the bot that dispatched you"}]\n" + note +
                                "\nThis replaces anything it contradicts. Keep what you have already done.",
                        ),
                    )
                }
                val result = chat(provider, history, tools.map { it.schema }, {}, { run.status == "stopped" })
                store.recordUsage(
                    UsageRow(
                        at = System.currentTimeMillis(),
                        agentId = parentAgentId,
                        model = provider.model,
                        promptTokens = result.promptTokens,
                        completionTokens = result.completionTokens,
                        seconds = ((System.currentTimeMillis() - startedAt) / 100) / 10.0,
                    ),
                )
                history.add(
                    ChatMessage(
                        "assistant",
                        result.text,
                        toolCalls = result.toolCalls.map { WireToolCall(it.id, it.name, JsonObject(it.args).toString()) },
                    ),
                )
                if (result.text.isNotBlank()) run.report = result.text.trim()
                if (result.toolCalls.isEmpty()) break

                for (call in result.toolCalls) {
                    val tool = TOOLS_BY_NAME[call.name]
                    synchronized(run.steps) { run.steps.add(call.name + " " + call.args.preview(90)) }
                    if (tool == null || call.name !in allowed) {
                        history.add(ChatMessage("tool", "${call.name} is not available to you.", toolCallId = call.id, name = call.name))
                        continue
                    }
                    try {
                        // A background worker is still this bot acting, so it goes through the same gate.
                        val (ok, refusal) = gate(parentAgentId, tool, call.args)
                        val out = if (ok) tool.run(ctx, call.args).output else refusal
                        history.add(ChatMessage("tool", fenceToolResult(call.name, out), toolCallId = call.id, name = call.name))
                    } catch (error: Throwable) {
                        if (error is kotlinx.coroutines.CancellationException) throw error
                        history.add(
                            ChatMessage("tool", "Failed: " + (error.message ?: ""), toolCallId = call.id, name = call.name),
                        )
                    }
                }
            }
            if (run.status == "running") run.status = "done"
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) {
                run.status = "stopped"
                return
            }
            run.status = "error"
            run.report = "Subagent failed: " + (error.message ?: error.toString())
        }

        if (run.status == "stopped") return
        // The report is written by a model that has been reading web pages and files, so it is
        // outside content like any other and comes back fenced. The description is Halo's own line
        // and stays out of the fence, which is also what keeps the transcript chip readable.
        submitSystemTurn(
            parentAgentId,
            run.description + "\n\n" + fenceContent("task:${run.id}", run.report.ifBlank { "(no report)" }),
            "Background task ${run.id} finished",
        )
    }

    // ------------------------------------------------------------------- helpers

    private suspend fun rememberExchange(agentId: String, userText: String) {
        val transcript = store.transcript(agentId)
        val reply = transcript.lastOrNull { it.role == Role.AGENT && it.text.isNotBlank() }
        val settings = store.getSettings()
        val provider = if (settings.provider.helperModel.isNotBlank()) {
            settings.provider.copy(model = settings.provider.helperModel)
        } else {
            settings.provider
        }
        val changed = extractMemories(provider, memory(agentId), userText, reply?.text.orEmpty())
        if (changed > 0) systemEvent(agentId, SystemEvent("memory", "Updated memory"))
    }

    private suspend fun ask(
        agentId: String,
        surface: ApprovalSurface,
        action: ActionSummary,
        reason: String,
    ): ApprovalDecision {
        val agent = store.getAgent(agentId)
        val name = agent?.name ?: "this bot"
        val request = ApprovalRequest(
            id = UUID.randomUUID().toString(),
            agentId = agentId,
            agentName = name,
            surface = surface,
            question = approvalQuestion(surface, name),
            summary = action.summary,
            detail = action.detail,
            reason = reason,
            createdAt = System.currentTimeMillis(),
            command = action.command,
            intent = action.intent,
        )
        val deferred = CompletableDeferred<ApprovalDecision>()
        synchronized(approvals) { approvals[request.id] = PendingApproval(request, deferred) }
        emitEvent(HaloEvent.ApprovalAsked(request))
        return deferred.await()
    }

    /**
     * Runs one tool through the real gate, with no model in the loop.
     *
     * Asking a model to attempt a wipe tests whether that model is willing, which is not a property of
     * Halo — a well-behaved one refuses on its own and the floor is never reached. This drives the gate
     * directly, which is the thing that has to hold when the model is not well behaved.
     */
    suspend fun runToolForTest(agentId: String, toolName: String, args: Args): String {
        val tool = TOOLS_BY_NAME[toolName] ?: return "No tool named $toolName."
        val (allowed, refusal) = gate(agentId, tool, args)
        if (!allowed) return refusal
        val ctx = ToolContext(
            agentId = agentId,
            store = store,
            emit = {},
            sendMessage = { text, _ -> Message("test", agentId, Role.AGENT, text, System.currentTimeMillis()) },
            systemEvent = {},
            sendWidget = { Message("test", agentId, Role.AGENT, "", System.currentTimeMillis()) },
            computer = computer,
            storage = storage,
            host = host,
            runner = this,
            memory = memory(agentId),
            skills = skills(agentId),
            isCancelled = { false },
            startBackground = { command, cwd -> startBackground(agentId, command, cwd) },
            awaitBackground = { id, timeout -> awaitBackground(id, timeout) },
        )
        return tool.run(ctx, args).output
    }

    fun shutdown() {
        scope.cancel()
    }
}

private fun approvalQuestion(surface: ApprovalSurface, agentName: String): String = when (surface) {
    ApprovalSurface.EXTERNAL_SHELL -> "Allow $agentName to run commands on your phone?"
    ApprovalSurface.EXTERNAL_READ -> "Allow $agentName to read your files?"
    ApprovalSurface.FILE_WRITE -> "Allow $agentName to write this out of Halo?"
    ApprovalSurface.BROWSER -> "Allow $agentName to use the browser for this?"
    ApprovalSurface.SHELL -> "Allow $agentName to run this command?"
    ApprovalSurface.AGENT_WRITE -> "Allow $agentName to make this change?"
    ApprovalSurface.AUTOMATION -> "Allow $agentName to change your automations?"
}

private fun permissionPhrase(surface: ApprovalSurface): String = when (surface) {
    ApprovalSurface.EXTERNAL_SHELL -> "run commands on your phone"
    ApprovalSurface.EXTERNAL_READ -> "read your files"
    ApprovalSurface.FILE_WRITE -> "write files out of Halo"
    ApprovalSurface.AUTOMATION -> "change and run your automations"
    else -> "do this without asking"
}

private fun conversationKey(agentId: String, channelId: String?): String =
    if (channelId != null) "$agentId@$channelId" else agentId

private fun parseConversationKey(key: String): Pair<String, String?> {
    val at = key.indexOf('@')
    return if (at < 0) key to null else key.substring(0, at) to key.substring(at + 1)
}

/**
 * Puts the "your text is not delivered" nudge on the last user message of the request. It rides along
 * with the call rather than being stored, so it is never re-sent from history.
 */
private fun withReplyReminder(messages: List<ChatMessage>): List<ChatMessage> {
    for (i in messages.indices.reversed()) {
        if (messages[i].role != "user") continue
        val patched = messages.toMutableList()
        patched[i] = messages[i].copy(content = messages[i].content + "\n\n" + REPLY_REMINDER)
        return patched
    }
    return messages
}

private val IMAGE_TYPES = mapOf(
    "png" to "image/png",
    "jpg" to "image/jpeg",
    "jpeg" to "image/jpeg",
    "webp" to "image/webp",
    "gif" to "image/gif",
)

private const val MAX_IMAGE_BYTES = 6 * 1024 * 1024

fun imageMime(path: String): String? = IMAGE_TYPES[path.substringAfterLast('.', "").lowercase()]

/** Inlines an image for the model; oversized or unknown formats are skipped rather than sent broken. */
fun imageDataUrl(path: String): String? {
    val type = imageMime(path) ?: return null
    return try {
        val file = File(path)
        if (file.length() > MAX_IMAGE_BYTES) return null
        "data:$type;base64," + android.util.Base64.encodeToString(file.readBytes(), android.util.Base64.NO_WRAP)
    } catch (_: Exception) {
        null
    }
}
