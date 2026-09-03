package com.halo.bot.core

import kotlinx.serialization.Serializable

/**
 * A bot as a file, in the shape host/portable.ts writes.
 *
 * The point of matching it byte for byte is that a bot is portable *between the two builds*: export
 * a Researcher on Windows, import it on the phone, and it arrives with its voice, its memory, its
 * skills and its routines. That only holds while both halves agree on the field names, so this is a
 * port of the TypeScript rather than a design of its own.
 *
 * What it deliberately does not carry: the box, the transcript, the granted folders and the endpoint
 * credential. A workspace is machine-shaped, a transcript is a conversation with somebody else, and a
 * credential is not a thing to put in a file somebody will email.
 */

@Serializable
data class PortableSkill(val file: String, val body: String)

@Serializable
data class PortableAgent(
    val name: String,
    val title: String = "",
    val description: String = "",
    val avatar: AgentAvatar = AgentAvatar(),
    val model: String? = null,
    val personaId: String? = null,
    val persona: String? = null,
)

@Serializable
data class PortableRoutine(
    val name: String,
    val prompt: String = "",
    val triggers: List<RoutineTrigger> = emptyList(),
    val enabled: Boolean = true,
)

@Serializable
data class PortableBot(
    val kind: String = "halo-bot",
    val version: Int = 1,
    val agent: PortableAgent,
    val memory: String = "",
    val skills: List<PortableSkill> = emptyList(),
    val routines: List<PortableRoutine> = emptyList(),
)

fun buildPortableBot(
    agent: Agent,
    memory: String,
    skills: List<PortableSkill>,
    routines: List<Routine>,
): PortableBot = PortableBot(
    agent = PortableAgent(
        name = agent.name,
        title = agent.title,
        description = agent.description,
        avatar = AgentAvatar(color = agent.avatar.color, face = agent.avatar.face),
        model = agent.model,
        personaId = agent.personaId,
        persona = agent.persona,
    ),
    memory = memory,
    skills = skills,
    routines = routines.map { PortableRoutine(it.name, it.prompt, it.triggers, it.enabled) },
)

/** Returns null for anything that is not a Halo bot file, so a bad import fails loudly but safely. */
fun parsePortableBot(text: String): PortableBot? {
    val parsed = runCatching { HaloJson.decodeFromString(PortableBot.serializer(), text) }.getOrNull() ?: return null
    if (parsed.kind != "halo-bot" || parsed.agent.name.isBlank()) return null
    return parsed.copy(routines = parsed.routines.filter { it.name.isNotBlank() && it.triggers.isNotEmpty() })
}
