package com.halo.bot.core

import java.io.File

/**
 * The seams between the runtime and Android.
 *
 * Everything in `core` is ordinary Kotlin that could run anywhere; these three interfaces are where it
 * asks the platform for a browser, for the user's own files, and for the things only an app can do.
 * Keeping them narrow is what made the desktop runtime portable in the first place, and it is what
 * lets the policy engine and the tool loop below be tested without an emulator.
 */

/** The bot's browser: one WebView per bot, which the user can watch and take over. */
interface ComputerPort {
    suspend fun ensure(agentId: String)

    /** Shows the screen to the user so they can sign in or take over. */
    suspend fun handOver(agentId: String, instruction: String)

    suspend fun navigate(agentId: String, url: String): Pair<String, String>

    suspend fun act(agentId: String, action: String, params: Args): String

    suspend fun readPage(agentId: String): String

    suspend fun screenshot(agentId: String): String

    /** The page's controls, each with an opaque ref this process resolves later. */
    suspend fun snapshot(agentId: String): String

    /** What a ref points at, for the approval card and the audit row. Null when it does not resolve. */
    fun describeRef(agentId: String, ref: String): Pair<String, String>?
}

/** One entry in a folder the user granted, whether it came from SAF or from a real path. */
data class StorageEntry(val name: String, val uri: String, val isDirectory: Boolean, val size: Long)

/**
 * The user's own files.
 *
 * On Windows this was just the filesystem. Android has scoped storage instead: an app reaches the
 * user's documents only through trees they picked in the system picker, addressed by `content://`
 * uris rather than paths. That is a better fit for Halo's model than the desktop one was — a granted
 * folder is granted by the operating system, not only by Halo's own rules — so the tools speak uris
 * and the policy's `allowedPaths` holds tree uris.
 */
interface StoragePort {
    /** Trees the user has granted, newest first. */
    fun grantedTrees(): List<String>

    fun describe(uri: String): StorageEntry?

    fun list(uri: String): List<StorageEntry>

    /** Resolves a name or a relative path against the granted trees, so a model can say "Documents/x.md". */
    fun resolve(target: String): String?

    fun readText(uri: String, maxBytes: Int = 512 * 1024): String

    fun readBytes(uri: String, maxBytes: Int = 8 * 1024 * 1024): ByteArray

    /** Copies a granted document into the bot's box. Returns the file written. */
    fun copyIn(uri: String, destination: File): File

    /** Writes a file out to a granted tree, or to Downloads when no tree is named. Returns its uri. */
    fun copyOut(source: File, destinationName: String, treeUri: String?): String

    /** Hands a file to another app through the system share sheet. */
    fun share(source: File, mimeType: String?): Boolean
}

/** The handful of app-level things a tool needs and `core` cannot do on its own. */
interface HostPort {
    /** Free bytes on the volume the box lives on. */
    fun freeBytes(dir: File): Long

    /** Total RAM, for ranking models the user could run locally. */
    fun totalMemoryBytes(): Long

    /** Posts a notification for a message a bot sent while the app was not in front. */
    fun notify(agent: Agent, message: Message)

    /** The loopback URL for a webhook routine, or empty when the listener is not running. */
    fun webhookUrl(token: String): String
}
