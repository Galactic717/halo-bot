package com.halo.bot.core

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import java.io.File
import java.util.UUID

/**
 * Everything is files, exactly as on the desktop.
 *
 * ponytail: flat JSON plus JSONL transcripts. One user, a few thousand messages, and a phone reads
 * its own private storage fast. Swap in Room only when a single agent's transcript stops fitting in
 * memory.
 */

/** Encrypts the few fields worth protecting at rest. Supplied by the platform layer. */
interface SecretCodec {
    fun encrypt(value: String): String
    fun decrypt(value: String): String
}

private const val SEALED = "enc:v1:"

/** Conversations kept in memory. Everything is on disk, so eviction only costs a re-read. */
private const val TRANSCRIPT_CACHE_LIMIT = 12

class Store(val root: File, private val secrets: SecretCodec? = null) {

    private var settings: Settings
    private val agents = LinkedHashMap<String, Agent>()
    private val routines = LinkedHashMap<String, Routine>()
    private val channels = LinkedHashMap<String, Channel>()
    private val transcripts = LinkedHashMap<String, MutableList<Message>>()
    private val llm = HashMap<String, MutableList<JsonObject>>()
    private val lock = Any()

    val agentsDir: File get() = File(root, "agents")
    private val settingsPath: File get() = File(root, "settings.json")
    private val routinesPath: File get() = File(root, "routines.json")
    private val channelsPath: File get() = File(root, "channels.json")
    private val usagePath: File get() = File(root, "usage.jsonl")

    init {
        agentsDir.mkdirs()
        settings = unseal(readJson(settingsPath, Settings.serializer()) ?: Settings())
        // Seal on the first run that has a keystore, so a key written before this existed does not
        // stay in the clear.
        if (secrets != null && settingsPath.exists()) writeJson(settingsPath, Settings.serializer(), seal(settings))
        readJson(routinesPath, ListSerializer(Routine.serializer()))?.forEach { routines[it.id] = it }
        readJson(channelsPath, ListSerializer(Channel.serializer()))?.forEach { channels[it.id] = it }
        agentsDir.listFiles { f -> f.isDirectory }?.forEach { dir ->
            readJson(File(dir, "agent.json"), Agent.serializer())?.let { a ->
                agents[a.id] = unsealAgent(a).copy(status = AgentStatus.IDLE)
            }
        }
    }

    fun agentDir(id: String): File = File(agentsDir, id)
    fun boxDir(id: String): File = File(agentDir(id), "box")
    private fun transcriptPath(id: String) = File(agentDir(id), "transcript.jsonl")

    /**
     * Reads a JSON file, and never turns a bad read into a silent permanent loss.
     *
     * The null fallback is what keeps the app usable when a file cannot be parsed — but every one of
     * these files is also written back later, so a single unreadable read used to mean the next write
     * overwrote the real data with an empty list, and the only copy was gone. A file that exists and
     * will not parse is moved aside instead: the app starts empty exactly as before, the bytes are
     * still on disk under a `.corrupt-<timestamp>` name, and the next write lands on a name that is
     * no longer holding anybody's data.
     */
    private fun <T> readJson(path: File, serializer: kotlinx.serialization.KSerializer<T>): T? {
        if (!path.exists()) return null
        val raw = try {
            path.readText()
        } catch (_: Exception) {
            // Locked or unreadable right now, which is not the same as damaged: leave it alone.
            return null
        }
        return try {
            HaloJson.decodeFromString(serializer, raw)
        } catch (_: Exception) {
            runCatching {
                path.renameTo(File(path.parentFile, path.name + ".corrupt-" + System.currentTimeMillis()))
            }
            null
        }
    }

    /** Write-then-rename: a crash mid-write leaves the old file intact instead of a half-written one. */
    private fun <T> writeJson(path: File, serializer: kotlinx.serialization.KSerializer<T>, value: T) {
        path.parentFile?.mkdirs()
        val tmp = File(path.parentFile, path.name + ".tmp")
        tmp.writeText(HaloJsonPretty.encodeToString(serializer, value))
        if (path.exists()) path.delete()
        tmp.renameTo(path)
    }

    // ------------------------------------------------------------------ settings

    fun getSettings(): Settings = synchronized(lock) { settings }

    fun saveSettings(next: Settings): Settings = synchronized(lock) {
        settings = next
        writeJson(settingsPath, Settings.serializer(), seal(next))
        settings
    }

    fun updateSettings(patch: (Settings) -> Settings): Settings = saveSettings(patch(getSettings()))

    private fun mapSecrets(s: Settings, fn: (String) -> String): Settings {
        if (secrets == null) return s
        return s.copy(
            provider = s.provider.copy(apiKey = fn(s.provider.apiKey)),
            n8n = s.n8n.copy(apiKey = fn(s.n8n.apiKey)),
            plugins = s.plugins.map { p ->
                if (p.env.isEmpty()) p else p.copy(env = p.env.mapValues { (_, v) -> fn(v) })
            },
        )
    }

    /** API keys and plugin credentials go to disk sealed; everything else stays readable. */
    private fun seal(s: Settings): Settings = mapSecrets(s) { value ->
        if (value.isEmpty() || value.startsWith(SEALED)) value
        else runCatching { SEALED + secrets!!.encrypt(value) }.getOrDefault(value)
    }

    private fun unseal(s: Settings): Settings = mapSecrets(s) { value ->
        if (value.isEmpty() || !value.startsWith(SEALED)) value
        // A key sealed against a keystore entry that has since been cleared cannot be recovered;
        // an empty one asks to be re-entered rather than failing every turn with a decrypt error.
        else runCatching { secrets!!.decrypt(value.removePrefix(SEALED)) }.getOrDefault("")
    }

    // -------------------------------------------------------------------- agents

    fun listAgents(): List<Agent> = synchronized(lock) {
        agents.values.sortedWith(compareByDescending<Agent> { it.pinned }.thenByDescending { it.lastActivityAt })
    }

    fun getAgent(id: String): Agent? = synchronized(lock) { agents[id] }

    fun createAgent(input: Agent): Agent = synchronized(lock) {
        val id = input.id.ifBlank { UUID.randomUUID().toString() }
        val agent = input.copy(
            id = id,
            createdAt = if (input.createdAt == 0L) System.currentTimeMillis() else input.createdAt,
            lastActivityAt = System.currentTimeMillis(),
            status = AgentStatus.IDLE,
        )
        boxDir(id).mkdirs()
        agents[id] = agent
        persistAgent(agent)
        agent
    }

    /** A copy with the same profile, settings and skills but a fresh, empty history. */
    fun duplicateAgent(id: String): Agent? {
        val source = getAgent(id) ?: return null
        val copy = createAgent(
            source.copy(
                id = "",
                name = source.name + " copy",
                createdAt = 0,
                pinned = false,
            ),
        )
        runCatching { File(agentDir(id), "skills").copyRecursively(File(agentDir(copy.id), "skills"), overwrite = true) }
        return copy
    }

    fun updateAgent(id: String, patch: (Agent) -> Agent): Agent? = synchronized(lock) {
        val cur = agents[id] ?: return null
        val next = patch(cur).copy(id = cur.id)
        agents[id] = next
        persistAgent(next)
        next
    }

    fun deleteAgent(id: String) = synchronized(lock) {
        agents.remove(id)
        transcripts.remove(id)
        // Its model history too, including the per-room copies. A cached one left behind would be
        // written back out by the next append and recreate the folder this call is deleting.
        llm.keys.filter { it == id || it.startsWith("$id#") }.forEach { llm.remove(it) }
        routines.values.filter { it.agentId == id }.forEach { routines.remove(it.id) }
        saveRoutines()
        agentDir(id).deleteRecursively()
        Unit
    }

    private fun persistAgent(agent: Agent) {
        agentDir(agent.id).mkdirs()
        // The endpoint's Authorization header is a credential like any other: sealed before it
        // reaches disk, and re-sealed on every write so one written before a keystore existed does
        // not stay in the clear.
        writeJson(File(agentDir(agent.id), "agent.json"), Agent.serializer(), sealAgent(agent))
    }

    private fun sealAgent(agent: Agent): Agent {
        val value = agent.endpointAuth
        if (secrets == null || value.isNullOrEmpty() || value.startsWith(SEALED)) return agent
        return runCatching { agent.copy(endpointAuth = SEALED + secrets!!.encrypt(value)) }.getOrDefault(agent)
    }

    private fun unsealAgent(agent: Agent): Agent {
        val value = agent.endpointAuth
        if (secrets == null || value.isNullOrEmpty() || !value.startsWith(SEALED)) return agent
        return runCatching { agent.copy(endpointAuth = secrets!!.decrypt(value.removePrefix(SEALED))) }
            .getOrDefault(agent.copy(endpointAuth = ""))
    }

    fun touchAgent(id: String) {
        updateAgent(id) { it.copy(lastActivityAt = System.currentTimeMillis()) }
    }

    // ---------------------------------------------------------------- transcript

    private fun parseTranscript(path: File): MutableList<Message> {
        val out = mutableListOf<Message>()
        if (!path.exists()) return out
        path.forEachLine { line ->
            if (line.isNotBlank()) {
                runCatching { HaloJson.decodeFromString(Message.serializer(), line) }.getOrNull()?.let { out.add(it) }
            }
        }
        return out
    }

    fun transcript(conversationId: String): List<Message> = synchronized(lock) { rawTranscript(conversationId).toList() }

    private fun rawTranscript(conversationId: String): MutableList<Message> {
        transcripts.remove(conversationId)?.let { cached ->
            transcripts[conversationId] = cached // re-inserting moves the key to the end: LRU touch
            return cached
        }
        val out = parseTranscript(transcriptPath(conversationId))
        transcripts[conversationId] = out
        while (transcripts.size > TRANSCRIPT_CACHE_LIMIT) {
            val oldest = transcripts.keys.firstOrNull() ?: break
            transcripts.remove(oldest)
        }
        return out
    }

    fun appendMessage(msg: Message): Message = synchronized(lock) {
        rawTranscript(msg.agentId).add(msg)
        agentDir(msg.agentId).mkdirs()
        transcriptPath(msg.agentId).appendText(HaloJson.encodeToString(Message.serializer(), msg) + "\n")
        if (agents.containsKey(msg.agentId)) touchAgentLocked(msg.agentId)
        else if (channels.containsKey(msg.agentId)) touchChannel(msg.agentId)
        msg
    }

    private fun touchAgentLocked(id: String) {
        val a = agents[id] ?: return
        val next = a.copy(lastActivityAt = System.currentTimeMillis())
        agents[id] = next
        persistAgent(next)
    }

    /**
     * Patches a message in place and rewrites the file.
     *
     * The desktop build coalesces this because a running tool card ticks several times a second.
     * Here the UI reads from memory and only the file write is on this path, so it is done straight
     * away — a phone that is killed by the system gets no chance to run a deferred flush.
     */
    fun updateMessage(conversationId: String, messageId: String, patch: (Message) -> Message): Message? =
        synchronized(lock) {
            val list = rawTranscript(conversationId)
            val i = list.indexOfFirst { it.id == messageId }
            if (i < 0) return null
            val next = patch(list[i])
            list[i] = next
            rewriteTranscript(conversationId)
            next
        }

    private fun rewriteTranscript(conversationId: String) {
        val list = transcripts[conversationId] ?: return
        agentDir(conversationId).mkdirs()
        transcriptPath(conversationId).writeText(
            list.joinToString("\n") { HaloJson.encodeToString(Message.serializer(), it) } + "\n",
        )
    }

    fun deleteMessage(conversationId: String, messageId: String) = synchronized(lock) {
        val list = rawTranscript(conversationId)
        list.removeAll { it.id == messageId }
        rewriteTranscript(conversationId)
    }

    /**
     * Full-text scan across every conversation. Reads straight from disk for anything not already
     * open, so searching does not pull every transcript into memory for good.
     */
    fun search(query: String, limit: Int = 40): List<Pair<String, Message>> = synchronized(lock) {
        val needle = query.trim().lowercase()
        if (needle.length < 2) return emptyList()
        val ids = agents.keys + channels.keys
        val hits = mutableListOf<Pair<String, Message>>()
        for (id in ids) {
            val messages = transcripts[id] ?: parseTranscript(transcriptPath(id))
            for (message in messages) {
                if (!message.text.lowercase().contains(needle)) continue
                hits.add(id to message)
                if (hits.size >= limit * 4) break
            }
        }
        hits.sortedByDescending { it.second.createdAt }.take(limit)
    }

    // ------------------------------------------- raw model conversation (survives restarts)

    private fun llmPath(id: String, suffix: String?) =
        File(agentDir(id), if (suffix != null) "llm-$suffix.jsonl" else "llm.jsonl")

    fun llmHistory(conversationId: String, suffix: String? = null): List<JsonObject> = synchronized(lock) {
        rawLlm(conversationId, suffix).toList()
    }

    private fun rawLlm(conversationId: String, suffix: String?): MutableList<JsonObject> {
        val key = if (suffix != null) "$conversationId#$suffix" else conversationId
        llm[key]?.let { return it }
        val out = mutableListOf<JsonObject>()
        val path = llmPath(conversationId, suffix)
        if (path.exists()) {
            path.forEachLine { line ->
                if (line.isNotBlank()) {
                    runCatching { HaloJson.parseToJsonElement(line) as JsonObject }.getOrNull()?.let { out.add(it) }
                }
            }
        }
        llm[key] = out
        return out
    }

    /** Replaces a conversation's model history, used after compaction. */
    fun replaceLlmHistory(conversationId: String, messages: List<JsonObject>, suffix: String? = null) =
        synchronized(lock) {
            val key = if (suffix != null) "$conversationId#$suffix" else conversationId
            llm[key] = messages.toMutableList()
            agentDir(conversationId).mkdirs()
            llmPath(conversationId, suffix).writeText(messages.joinToString("\n") { it.toString() } + "\n")
        }

    fun appendLlm(conversationId: String, msg: JsonObject, suffix: String? = null) = synchronized(lock) {
        rawLlm(conversationId, suffix).add(msg)
        agentDir(conversationId).mkdirs()
        llmPath(conversationId, suffix).appendText(msg.toString() + "\n")
    }

    // ------------------------------------------------------------------- usage

    fun recordUsage(row: UsageRow) {
        if (row.promptTokens == 0 && row.completionTokens == 0) return
        usagePath.appendText(HaloJson.encodeToString(UsageRow.serializer(), row) + "\n")
    }

    fun usage(sinceMs: Long): List<UsageRow> {
        if (!usagePath.exists()) return emptyList()
        val rows = mutableListOf<UsageRow>()
        usagePath.forEachLine { line ->
            if (line.isNotBlank()) {
                runCatching { HaloJson.decodeFromString(UsageRow.serializer(), line) }.getOrNull()
                    ?.takeIf { it.at >= sinceMs }?.let { rows.add(it) }
            }
        }
        return rows
    }

    // ---------------------------------------------------------------- channels

    fun listChannels(): List<Channel> = synchronized(lock) { channels.values.sortedByDescending { it.lastActivityAt } }

    fun getChannel(id: String): Channel? = synchronized(lock) { channels[id] }

    fun createChannel(name: String, memberIds: List<String>): Channel = synchronized(lock) {
        val channel = Channel(
            id = UUID.randomUUID().toString(),
            name = name.trim().ifBlank { "New channel" },
            memberIds = memberIds.distinct(),
            createdAt = System.currentTimeMillis(),
            lastActivityAt = System.currentTimeMillis(),
        )
        agentDir(channel.id).mkdirs()
        channels[channel.id] = channel
        saveChannels()
        channel
    }

    fun updateChannel(id: String, patch: (Channel) -> Channel): Channel? = synchronized(lock) {
        val cur = channels[id] ?: return null
        val next = patch(cur).copy(id = cur.id)
        channels[id] = next
        saveChannels()
        next
    }

    fun deleteChannel(id: String) = synchronized(lock) {
        channels.remove(id)
        transcripts.remove(id)
        saveChannels()
        agentDir(id).deleteRecursively()
        Unit
    }

    fun touchChannel(id: String) {
        val c = channels[id] ?: return
        channels[id] = c.copy(lastActivityAt = System.currentTimeMillis())
        saveChannels()
    }

    private fun saveChannels() = writeJson(channelsPath, ListSerializer(Channel.serializer()), channels.values.toList())

    // ---------------------------------------------------------------- routines

    fun listRoutines(): List<Routine> = synchronized(lock) { routines.values.toList() }
    fun getRoutine(id: String): Routine? = synchronized(lock) { routines[id] }

    fun saveRoutine(r: Routine): Routine = synchronized(lock) {
        routines[r.id] = r
        saveRoutines()
        r
    }

    fun deleteRoutine(id: String) = synchronized(lock) {
        routines.remove(id)
        saveRoutines()
    }

    private fun saveRoutines() = writeJson(routinesPath, ListSerializer(Routine.serializer()), routines.values.toList())
}
