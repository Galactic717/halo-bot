package com.halo.bot.core

import java.io.File

/**
 * Skills are reusable recipes ("use this when …"), separate from routines: a routine fires on a
 * schedule, a skill is looked up when it applies.
 */
class SkillStore(store: Store, agentId: String) {
    private val dir = File(store.agentDir(agentId), "skills")

    init {
        dir.mkdirs()
    }

    private fun slug(name: String): String =
        name.trim().lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-').take(60).ifEmpty { "skill" }

    fun list(): List<Skill> {
        if (!dir.exists()) return emptyList()
        return dir.listFiles { f -> f.name.endsWith(".md") }.orEmpty().map { file ->
            val raw = file.readText()
            val name = Regex("^#\\s+(.+)$", RegexOption.MULTILINE).find(raw)?.groupValues?.get(1)?.trim()
                ?: file.name.removeSuffix(".md")
            val description = Regex("^>\\s+(.+)$", RegexOption.MULTILINE).find(raw)?.groupValues?.get(1)?.trim() ?: ""
            val body = raw
                .replaceFirst(Regex("^#.*$", RegexOption.MULTILINE), "")
                .replaceFirst(Regex("^>.*$", RegexOption.MULTILINE), "")
                .trim()
            Skill(file.name.removeSuffix(".md"), name, description, body, file.lastModified())
        }.sortedBy { it.name }
    }

    fun read(nameOrId: String): Skill? {
        val key = slug(nameOrId)
        return list().firstOrNull { it.id == key || slug(it.name) == key }
    }

    fun write(name: String, description: String, body: String): Skill {
        val id = slug(name)
        File(dir, "$id.md").writeText("# ${name.trim()}\n> ${description.trim()}\n\n${body.trim()}\n")
        return Skill(id, name.trim(), description.trim(), body.trim(), System.currentTimeMillis())
    }

    fun delete(nameOrId: String): Boolean {
        val skill = read(nameOrId) ?: return false
        return File(dir, "${skill.id}.md").delete()
    }
}
