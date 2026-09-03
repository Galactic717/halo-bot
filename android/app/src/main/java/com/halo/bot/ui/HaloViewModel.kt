package com.halo.bot.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.toMutableStateList
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.halo.bot.Halo
import com.halo.bot.core.Agent
import com.halo.bot.core.clampTriggers
import com.halo.bot.core.enabledSlotReason
import com.halo.bot.core.AgentStatus
import com.halo.bot.core.ApprovalDecision
import com.halo.bot.core.ApprovalRequest
import com.halo.bot.core.Channel
import com.halo.bot.core.ControlState
import com.halo.bot.core.HaloEvent
import com.halo.bot.core.Message
import com.halo.bot.core.Routine
import com.halo.bot.core.Settings
import kotlinx.coroutines.launch

/**
 * Everything the interface watches, in one place.
 *
 * The desktop renderer keeps this same set in React state and receives it over IPC; here the runtime
 * is in the same process, so the view model subscribes to `Halo.events` and mutates Compose state
 * directly. The shapes match the desktop's `App.tsx` deliberately — the two interfaces are meant to
 * stay recognisably the same product.
 */
class HaloViewModel : ViewModel() {

    var agents by mutableStateOf<List<Agent>>(emptyList())
        private set
    var channels by mutableStateOf<List<Channel>>(emptyList())
        private set
    var settings by mutableStateOf(Settings())
        private set
    var routines by mutableStateOf<List<Routine>>(emptyList())
        private set
    var approvals by mutableStateOf<List<ApprovalRequest>>(emptyList())
        private set
    var providerError by mutableStateOf<String?>(null)
        private set
    var teaching by mutableStateOf<Triple<String, Int, Int>?>(null)
        private set
    var lastError by mutableStateOf<String?>(null)

    /** Conversation id (a bot or a channel) to its loaded transcript. */
    val transcripts = mutableStateMapOf<String, SnapshotStateList<Message>>()
    val unread = mutableStateMapOf<String, Int>()
    val control = mutableStateMapOf<String, ControlState>()
    val browserUrl = mutableStateMapOf<String, String>()

    var activeId by mutableStateOf<String?>(null)
        private set

    init {
        val snapshot = Halo.snapshot()
        agents = snapshot.agents
        channels = snapshot.channels
        settings = snapshot.settings
        routines = snapshot.routines
        approvals = snapshot.approvals
        providerError = Halo.providerError

        viewModelScope.launch {
            Halo.events.collect { event -> onEvent(event) }
        }
    }

    private fun transcriptOf(id: String): SnapshotStateList<Message> =
        transcripts.getOrPut(id) { Halo.store.transcript(id).toMutableStateList() }

    private fun onEvent(event: HaloEvent) {
        when (event) {
            is HaloEvent.Agents -> agents = event.agents
            is HaloEvent.NewMessage -> {
                val list = transcriptOf(event.message.agentId)
                if (list.none { it.id == event.message.id }) list.add(event.message)
                if (event.message.agentId != activeId && event.message.role != com.halo.bot.core.Role.USER) {
                    unread[event.message.agentId] = (unread[event.message.agentId] ?: 0) + 1
                }
            }

            is HaloEvent.MessagePatch -> {
                val list = transcripts[event.agentId] ?: return
                val i = list.indexOfFirst { it.id == event.messageId }
                if (i >= 0) {
                    list[i] = list[i].copy(
                        text = event.text ?: list[i].text,
                        reactions = event.reactions ?: list[i].reactions,
                    )
                }
            }

            is HaloEvent.ToolUpdate -> {
                val list = transcripts[event.agentId] ?: return
                val i = list.indexOfFirst { it.id == event.messageId }
                if (i >= 0) {
                    val calls = list[i].toolCalls.filter { it.id != event.call.id } + event.call
                    list[i] = list[i].copy(toolCalls = calls)
                }
            }

            is HaloEvent.Status -> agents = agents.map { if (it.id == event.agentId) it.copy(status = event.status) else it }
            is HaloEvent.ApprovalAsked -> approvals = approvals + event.approval
            is HaloEvent.ApprovalResolved -> approvals = approvals.filterNot { it.id == event.id }
            is HaloEvent.RoutinesChanged -> routines = event.routines
            is HaloEvent.ChannelsChanged -> channels = event.channels
            is HaloEvent.SettingsChanged -> settings = event.settings
            is HaloEvent.ProviderHealth -> providerError = if (event.ok) {
                null
            } else if (event.kind == "model") {
                event.error ?: "this model will not work"
            } else {
                "Model server unreachable at ${event.baseUrl} — ${event.error ?: "no answer"}"
            }

            is HaloEvent.Focus -> select(event.agentId)
            is HaloEvent.Teaching -> teaching =
                if (event.recording) Triple(event.agentId, event.seconds, event.steps) else null

            is HaloEvent.ControlChanged -> control[event.agentId] =
                ControlState(event.holder, System.currentTimeMillis(), event.requested, event.instruction)

            is HaloEvent.ComputerChanged -> browserUrl[event.agentId] = event.url
            is HaloEvent.Failure -> lastError = event.message
            is HaloEvent.Audited -> Unit
        }
    }

    // ---------------------------------------------------------------- actions

    fun select(id: String?) {
        activeId = id
        if (id != null) {
            transcriptOf(id)
            unread.remove(id)
        }
    }

    fun messages(id: String): List<Message> = transcriptOf(id)

    fun agent(id: String?): Agent? = agents.firstOrNull { it.id == id }

    fun channel(id: String?): Channel? = channels.firstOrNull { it.id == id }

    fun send(id: String, text: String, attachments: List<com.halo.bot.core.Attachment> = emptyList()) {
        if (text.isBlank() && attachments.isEmpty()) return
        if (channel(id) != null) Halo.runner.submitChannelMessage(id, text)
        else Halo.runner.submitUserMessage(id, text, attachments)
    }

    fun stop(id: String) = Halo.runner.stop(id)

    fun busy(id: String): Boolean =
        agent(id)?.status == AgentStatus.WORKING || agent(id)?.status == AgentStatus.WAITING || Halo.runner.isBusy(id)

    fun respond(approvalId: String, decision: ApprovalDecision) = Halo.runner.resolveApproval(approvalId, decision)

    fun saveSettings(patch: (Settings) -> Settings) {
        settings = Halo.saveSettings(patch)
    }

    fun createAgent(draft: NewBotDraft): Agent {
        val agent = Halo.createBot(
            draft.name,
            draft.title,
            draft.description,
            draft.color,
            draft.personaId,
            draft.persona,
            draft.model,
        )
        agents = Halo.store.listAgents()
        select(agent.id)
        return agent
    }

    fun updateAgent(id: String, patch: (Agent) -> Agent) {
        Halo.runner.updateAgent(id, patch)
        agents = Halo.store.listAgents()
    }

    fun deleteAgent(id: String) {
        Halo.store.deleteAgent(id)
        transcripts.remove(id)
        agents = Halo.store.listAgents()
        if (activeId == id) select(agents.firstOrNull()?.id)
    }

    fun duplicateAgent(id: String) {
        Halo.store.duplicateAgent(id)
        agents = Halo.store.listAgents()
    }

    fun createChannel(name: String, memberIds: List<String>) {
        val channel = Halo.store.createChannel(name, memberIds)
        channels = Halo.store.listChannels()
        select(channel.id)
    }

    fun deleteChannel(id: String) {
        Halo.store.deleteChannel(id)
        channels = Halo.store.listChannels()
        if (activeId == id) select(agents.firstOrNull()?.id)
    }

    fun saveRoutine(routine: Routine) {
        // The interval floor and the enabled cap apply to the editor as they do to a bot writing one:
        // one field that means two different things depending on who filled it in is worse than one rule.
        val clamped = routine.copy(triggers = clampTriggers(routine.triggers))
        val blocked = if (clamped.enabled) enabledSlotReason(Halo.store.listRoutines(), clamped.id) else null
        if (blocked != null) {
            Halo.store.saveRoutine(clamped.copy(enabled = false))
        } else {
            Halo.store.saveRoutine(clamped)
        }
        routines = Halo.store.listRoutines()
    }

    fun deleteRoutine(id: String) {
        Halo.store.deleteRoutine(id)
        routines = Halo.store.listRoutines()
    }

    fun runRoutineNow(id: String) = Halo.runRoutineNow(id)

    fun answerWidget(conversationId: String, messageId: String, value: String) {
        val list = transcriptOf(conversationId)
        val i = list.indexOfFirst { it.id == messageId }
        if (i >= 0) {
            val widget = list[i].widget?.copy(answered = value)
            list[i] = list[i].copy(widget = widget)
            Halo.store.updateMessage(conversationId, messageId) { it.copy(widget = widget) }
        }
        send(conversationId, value)
    }

    fun refreshAgents() {
        agents = Halo.store.listAgents()
    }

    fun setChannelMembers(channelId: String, memberIds: List<String>) {
        Halo.store.updateChannel(channelId) { it.copy(memberIds = memberIds.distinct()) }
        channels = Halo.store.listChannels()
    }

    /**
     * Moves a bot between the sidebar's sections, the way the desktop's "Move to section" does.
     * `null` takes it out of every section; a name that does not exist yet becomes a new one.
     */
    fun moveToSection(agentId: String, sectionName: String?) {
        saveSettings { s ->
            val cleaned = s.sections.map { it.copy(agentIds = it.agentIds - agentId) }
            when {
                sectionName == null -> s.copy(sections = cleaned.filter { it.agentIds.isNotEmpty() })
                cleaned.none { it.name == sectionName } -> s.copy(
                    sections = cleaned + com.halo.bot.core.Section(
                        id = java.util.UUID.randomUUID().toString(),
                        name = sectionName,
                        agentIds = listOf(agentId),
                    ),
                )
                else -> s.copy(
                    sections = cleaned.map {
                        if (it.name == sectionName) it.copy(agentIds = it.agentIds + agentId) else it
                    },
                )
            }
        }
    }

    fun deleteMessage(conversationId: String, messageId: String) {
        Halo.store.deleteMessage(conversationId, messageId)
        transcripts[conversationId]?.removeAll { it.id == messageId }
    }

    /** Toggles one emoji on a message, the way the desktop build's right-click menu does. */
    fun react(conversationId: String, messageId: String, emoji: String) {
        val list = transcriptOf(conversationId)
        val i = list.indexOfFirst { it.id == messageId }
        if (i < 0) return
        val reactions = if (emoji in list[i].reactions) list[i].reactions - emoji else list[i].reactions + emoji
        list[i] = list[i].copy(reactions = reactions)
        Halo.store.updateMessage(conversationId, messageId) { it.copy(reactions = reactions) }
    }

    fun refreshProvider() {
        viewModelScope.launch { Halo.checkProvider(force = true) }
    }
}
