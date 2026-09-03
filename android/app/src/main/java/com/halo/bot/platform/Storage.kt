package com.halo.bot.platform

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.FileProvider
import androidx.documentfile.provider.DocumentFile
import com.halo.bot.core.StorageEntry
import com.halo.bot.core.StoragePort
import java.io.File

/**
 * The user's own files, through the Storage Access Framework.
 *
 * This is the biggest honest difference from the desktop build, and it is a difference in Halo's
 * favour. There, "the folders it may use freely" was a list Halo kept and Halo enforced — a
 * determined model reaching past it was stopped by a regex. Here the same list is a set of grants
 * Android itself holds: a folder the user picked in the system picker, persisted across reboots, and
 * unreachable by anything the app does outside it. Halo's own `allowedPaths` check still runs, so a
 * bot can be given fewer folders than the app has, but it is now the inner of two boundaries rather
 * than the only one.
 */
class Storage(private val context: Context) : StoragePort {

    private val resolver get() = context.contentResolver

    override fun grantedTrees(): List<String> = resolver.persistedUriPermissions
        .filter { it.isReadPermission }
        .sortedByDescending { it.persistedTime }
        .map { it.uri.toString() }

    /** Remembers a folder the user just picked, so it survives a restart. */
    fun persist(uri: Uri) {
        runCatching {
            resolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
        }
    }

    fun forget(uri: String) {
        runCatching {
            resolver.releasePersistableUriPermission(
                Uri.parse(uri),
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
        }
    }

    private fun documentOf(uri: String): DocumentFile? {
        val parsed = runCatching { Uri.parse(uri) }.getOrNull() ?: return null
        return if (uri.contains("/tree/") && !uri.contains("/document/")) {
            DocumentFile.fromTreeUri(context, parsed)
        } else {
            DocumentFile.fromSingleUri(context, parsed)
        }
    }

    override fun describe(uri: String): StorageEntry? {
        val doc = documentOf(uri) ?: return null
        if (!doc.exists()) return null
        return StorageEntry(doc.name ?: uri.substringAfterLast('/'), doc.uri.toString(), doc.isDirectory, doc.length())
    }

    override fun list(uri: String): List<StorageEntry> {
        val doc = documentOf(uri) ?: return emptyList()
        if (!doc.isDirectory) return emptyList()
        return doc.listFiles().map {
            StorageEntry(it.name ?: "?", it.uri.toString(), it.isDirectory, it.length())
        }.sortedWith(compareByDescending<StorageEntry> { it.isDirectory }.thenBy { it.name.lowercase() })
    }

    /**
     * Turns what a model wrote into something Android can open.
     *
     * A model says "Documents/notes.md", not a content uri, so a name is walked down from each
     * granted tree in turn. A uri it got from a previous tool call is used as it stands, but only when
     * it is still one of the grants — otherwise a uri that leaked into the conversation from a page
     * would be a way to name a document the user never granted.
     */
    override fun resolve(target: String): String? {
        val trimmed = target.trim().trim('/')
        if (trimmed.isEmpty()) return null
        if (trimmed.startsWith("content://")) {
            return if (grantedTrees().any { belongsTo(trimmed, it) }) trimmed else null
        }
        for (tree in grantedTrees()) {
            val root = DocumentFile.fromTreeUri(context, Uri.parse(tree)) ?: continue
            // A path can name the tree itself first ("Documents/notes.md" under a Documents grant),
            // which is what a person would write and what the prompt shows them.
            val direct = walk(root, trimmed.split("/"))
            if (direct != null) return direct.uri.toString()
            val rootName = root.name
            if (rootName != null && trimmed.startsWith("$rootName/")) {
                walk(root, trimmed.removePrefix("$rootName/").split("/"))?.let { return it.uri.toString() }
            }
            if (rootName != null && trimmed == rootName) return root.uri.toString()
        }
        return null
    }

    private fun walk(root: DocumentFile, parts: List<String>): DocumentFile? {
        var cursor: DocumentFile = root
        for (part in parts) {
            if (part.isBlank() || part == ".") continue
            // No "..": a granted tree is the boundary, and walking up out of one would be the whole
            // point of the grant undone.
            if (part == "..") return null
            cursor = cursor.findFile(part) ?: return null
        }
        return cursor
    }

    private fun belongsTo(uri: String, tree: String): Boolean {
        if (uri == tree) return true
        val treeId = decode(tree.substringAfter("/tree/", "").substringBefore("/document/"))
        if (treeId.isEmpty()) return false
        val docId = decode(uri.substringAfter("/document/", "").substringBefore("/children"))
        return docId == treeId || docId.startsWith(treeId.trimEnd('/') + "/")
    }

    private fun decode(value: String) = runCatching { Uri.decode(value) }.getOrDefault(value)

    override fun readText(uri: String, maxBytes: Int): String {
        val bytes = readBytes(uri, maxBytes)
        return String(bytes, Charsets.UTF_8)
    }

    override fun readBytes(uri: String, maxBytes: Int): ByteArray =
        resolver.openInputStream(Uri.parse(uri))?.use { stream ->
            val buffer = ByteArray(maxBytes)
            var read = 0
            while (read < maxBytes) {
                val n = stream.read(buffer, read, maxBytes - read)
                if (n <= 0) break
                read += n
            }
            buffer.copyOf(read)
        } ?: throw Exception("could not open $uri")

    override fun copyIn(uri: String, destination: File): File {
        destination.parentFile?.mkdirs()
        resolver.openInputStream(Uri.parse(uri))?.use { input ->
            destination.outputStream().use { output -> input.copyTo(output) }
        } ?: throw Exception("could not open $uri")
        return destination
    }

    /**
     * Writes a file out of the box.
     *
     * Into a granted tree when one is named, and otherwise into Downloads through MediaStore, which
     * is the one place an app may write without asking for anything. Downloads is deliberately the
     * fallback rather than an error: a bot that produced a report and cannot hand it over is a bot
     * that wasted the work.
     */
    override fun copyOut(source: File, destinationName: String, treeUri: String?): String {
        val name = destinationName.ifBlank { source.name }
        if (treeUri != null) {
            val tree = documentOf(treeUri) ?: throw Exception("that folder is not one you can write to")
            tree.findFile(name)?.delete()
            val created = tree.createFile(mimeOf(name), name) ?: throw Exception("could not create $name")
            resolver.openOutputStream(created.uri)?.use { out -> source.inputStream().use { it.copyTo(out) } }
                ?: throw Exception("could not write $name")
            return created.uri.toString()
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, mimeOf(name))
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            val uri = resolver.insert(collection, values) ?: throw Exception("could not create $name in Downloads")
            resolver.openOutputStream(uri)?.use { out -> source.inputStream().use { it.copyTo(out) } }
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            return uri.toString()
        }
        @Suppress("DEPRECATION")
        val downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        downloads.mkdirs()
        val target = File(downloads, name)
        source.copyTo(target, overwrite = true)
        return Uri.fromFile(target).toString()
    }

    /**
     * Hands a file to another app.
     *
     * The share sheet is the whole consent mechanism on Android: the user sees what is being sent and
     * picks where, and can cancel. Halo still gates the tool, because the bot deciding to send a file
     * somewhere is the decision worth approving — the sheet only decides where it lands.
     */
    override fun share(source: File, mimeType: String?): Boolean = runCatching {
        val uri = FileProvider.getUriForFile(context, context.packageName + ".files", source)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = mimeType ?: mimeOf(source.name)
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(intent, "Share " + source.name)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(chooser)
        true
    }.getOrDefault(false)

    private fun mimeOf(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "txt" -> "text/plain"
        "md" -> "text/markdown"
        "json" -> "application/json"
        "csv" -> "text/csv"
        "html", "htm" -> "text/html"
        "pdf" -> "application/pdf"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        "zip" -> "application/zip"
        else -> "application/octet-stream"
    }
}
