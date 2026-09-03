package com.halo.bot.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.TimeUnit

data class ShellResult(val code: Int, val out: String)

const val MAX_OUTPUT = 24_000

fun clip(text: String): String =
    if (text.length <= MAX_OUTPUT) text
    else text.take(MAX_OUTPUT) + "\n... [" + (text.length - MAX_OUTPUT) + " more characters truncated]"

/**
 * The environment a command sees.
 *
 * An allow list, not a deny list — the same discipline as the desktop build, for a slightly different
 * reason. There, the process held the user's decrypted API key in `process.env` and a deny list would
 * only ever cover the secrets that existed the day it was written. Here the key lives in memory and
 * the keystore rather than the environment, but a child that inherits everything still picks up
 * whatever a future dependency decides to export, and an allow list is the version that stays correct
 * without anybody maintaining it.
 */
private val SHELL_ENV_NAMES = listOf(
    "PATH", "ANDROID_ROOT", "ANDROID_DATA", "ANDROID_ART_ROOT", "ANDROID_I18N_ROOT",
    "ANDROID_TZDATA_ROOT", "BOOTCLASSPATH", "DEX2OATBOOTCLASSPATH", "LANG", "LC_ALL",
    "TZ", "HOSTNAME",
)

fun shellEnvironment(source: Map<String, String> = System.getenv()): Map<String, String> {
    val env = LinkedHashMap<String, String>()
    for (name in SHELL_ENV_NAMES) source[name]?.let { env[name] = it }
    // toybox is what `sh` actually is on a modern Android, and a command that cannot find it is not a
    // shell. The path is spelled out rather than inherited so a stripped environment still works.
    env["PATH"] = (env["PATH"] ?: "") .let { if (it.isBlank()) "/system/bin:/system/xbin" else it }
    return env
}

/**
 * Runs a command in the bot's box.
 *
 * There is no confinement helper here and none is needed, which is the one place Android is simply
 * better than the desktop build. On Windows the box was a folder with a low-integrity label and a
 * helper process, because `Shell` was otherwise real PowerShell with the user's full rights. Here the
 * command is a child of this app: it runs as this app's uid, inside the app sandbox, and the kernel
 * refuses it every path outside Halo's own storage — the user's photos, other apps' data, the system.
 * The boundary the desktop build had to build is the platform's default.
 *
 * `tmpDir` points TMPDIR into the box so a command that writes a temp file does not fail on a
 * read-only /tmp that does not exist on Android.
 */
suspend fun runShell(
    command: String,
    cwd: File,
    timeoutMs: Long = 120_000,
    isCancelled: () -> Boolean = { false },
): ShellResult = withContext(Dispatchers.IO) {
    cwd.mkdirs()
    val builder = ProcessBuilder("/system/bin/sh", "-c", command)
        .directory(cwd)
        .redirectErrorStream(true)
    builder.environment().clear()
    builder.environment().putAll(shellEnvironment())
    builder.environment()["TMPDIR"] = File(cwd, ".tmp").apply { mkdirs() }.absolutePath
    builder.environment()["HOME"] = cwd.absolutePath

    val process = try {
        builder.start()
    } catch (e: Exception) {
        return@withContext ShellResult(-1, "could not start a shell: " + (e.message ?: e.toString()))
    }

    val output = StringBuilder()
    val reader = Thread {
        try {
            process.inputStream.bufferedReader().forEachLine { line ->
                synchronized(output) {
                    output.append(line).append('\n')
                    if (output.length > MAX_OUTPUT * 2) {
                        val kept = output.substring(output.length - MAX_OUTPUT * 2)
                        output.setLength(0)
                        output.append(kept)
                    }
                }
            }
        } catch (_: Exception) {
            // The stream closes when the process is killed; that is the normal end, not a failure.
        }
    }
    reader.isDaemon = true
    reader.start()

    val deadline = System.currentTimeMillis() + timeoutMs
    var finished = false
    while (System.currentTimeMillis() < deadline) {
        if (isCancelled()) {
            process.destroyForcibly()
            break
        }
        if (process.waitFor(200, TimeUnit.MILLISECONDS)) {
            finished = true
            break
        }
    }
    if (!finished && process.isAlive) {
        process.destroyForcibly()
        synchronized(output) { output.append("\n[timed out after ").append(timeoutMs).append("ms]") }
    }
    reader.join(1000)

    ShellResult(if (finished) process.exitValue() else -1, synchronized(output) { output.toString() })
}

// ------------------------------------------------------------------ text helpers

fun htmlToText(html: String): String = html
    .replace(Regex("<script[\\s\\S]*?</script>", RegexOption.IGNORE_CASE), " ")
    .replace(Regex("<style[\\s\\S]*?</style>", RegexOption.IGNORE_CASE), " ")
    .replace(Regex("<br\\s*/?>", RegexOption.IGNORE_CASE), "\n")
    .replace(Regex("</(p|div|li|h[1-6]|tr)>", RegexOption.IGNORE_CASE), "\n")
    .replace(Regex("<[^>]+>"), " ")
    .replace("&nbsp;", " ")
    .replace("&amp;", "&")
    .replace("&quot;", "\"")
    .replace("&#39;", "'")
    .replace("&lt;", "<")
    .replace("&gt;", ">")
    .replace(Regex("[ \\t\\u00a0]+"), " ")
    .replace(Regex("\\n{3,}"), "\n\n")
    .trim()

private val IMAGE_EXTENSIONS = setOf("png", "jpg", "jpeg", "gif", "webp", "bmp", "svg")

enum class FileKind { TEXT, IMAGE, BINARY }

/** Text, an image the model can look at, or bytes that would only pollute the context. */
fun fileKind(file: File): FileKind {
    if (file.extension.lowercase() in IMAGE_EXTENSIONS) return FileKind.IMAGE
    return try {
        val head = file.inputStream().use { stream ->
            val buffer = ByteArray(4096)
            val read = stream.read(buffer)
            buffer.copyOf(maxOf(read, 0))
        }
        if (head.any { it.toInt() == 0 }) FileKind.BINARY else FileKind.TEXT
    } catch (_: Exception) {
        FileKind.BINARY
    }
}
