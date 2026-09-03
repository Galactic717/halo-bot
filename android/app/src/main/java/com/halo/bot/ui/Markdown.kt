package com.halo.bot.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Just enough Markdown for what a bot actually writes.
 *
 * The desktop build pulls in react-markdown plus remark-gfm; that is the right call in a browser and
 * the wrong one here, where the equivalent would be a rendering library measured in hundreds of
 * kilobytes for output that is nearly always a few paragraphs, a bullet list and the occasional code
 * block. ponytail: headings, bullets, bold/italic/code/links, and fenced code. If a bot starts
 * emitting tables often enough to matter, this wants a real parser rather than another regex.
 */
@Composable
fun MarkdownText(
    text: String,
    modifier: Modifier = Modifier,
    color: androidx.compose.ui.graphics.Color = LocalHaloColors.current.textPrimary,
) {
    val colors = LocalHaloColors.current
    val blocks = remember(text) { splitBlocks(text) }
    Column(modifier = modifier) {
        for (block in blocks) {
            when (block) {
                is Block.Code -> Row(
                    modifier = Modifier
                        .padding(vertical = Halo1)
                        .clip(RoundedCornerShape(Halo2))
                        .background(colors.bgBase)
                        .horizontalScroll(rememberScrollState())
                        .padding(Halo3),
                ) {
                    Text(
                        block.text,
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        color = colors.textSecondary,
                    )
                }

                is Block.Heading -> Text(
                    inline(block.text, colors),
                    modifier = Modifier.padding(top = if (block.level <= 2) Halo3 else Halo2, bottom = Halo1),
                    style = MaterialTheme.typography.bodyLarge.copy(
                        fontWeight = FontWeight.SemiBold,
                        fontSize = when (block.level) {
                            1 -> 19.sp
                            2 -> 17.sp
                            else -> 16.sp
                        },
                    ),
                    color = color,
                )

                is Block.Bullet -> Row(modifier = Modifier.padding(vertical = 2.dp)) {
                    Text(
                        block.marker,
                        modifier = Modifier.padding(end = Halo2),
                        style = MaterialTheme.typography.bodyLarge,
                        color = colors.textTertiary,
                    )
                    Text(inline(block.text, colors), style = MaterialTheme.typography.bodyLarge, color = color)
                }

                is Block.Paragraph -> Text(
                    inline(block.text, colors),
                    modifier = Modifier.padding(vertical = Halo1),
                    style = MaterialTheme.typography.bodyLarge,
                    color = color,
                )
            }
        }
    }
}

private sealed interface Block {
    data class Paragraph(val text: String) : Block
    data class Heading(val level: Int, val text: String) : Block
    data class Bullet(val marker: String, val text: String) : Block
    data class Code(val text: String) : Block
}

private fun splitBlocks(source: String): List<Block> {
    val blocks = mutableListOf<Block>()
    val lines = source.split("\n")
    var i = 0
    val paragraph = StringBuilder()

    fun flush() {
        if (paragraph.isNotBlank()) blocks.add(Block.Paragraph(paragraph.toString().trim()))
        paragraph.setLength(0)
    }

    while (i < lines.size) {
        val line = lines[i]
        when {
            line.trimStart().startsWith("```") -> {
                flush()
                val code = StringBuilder()
                i++
                while (i < lines.size && !lines[i].trimStart().startsWith("```")) {
                    code.append(lines[i]).append('\n')
                    i++
                }
                blocks.add(Block.Code(code.toString().trimEnd()))
            }

            Regex("^#{1,6}\\s+").containsMatchIn(line) -> {
                flush()
                val level = line.takeWhile { it == '#' }.length
                blocks.add(Block.Heading(level, line.dropWhile { it == '#' }.trim()))
            }

            Regex("^\\s*[-*+]\\s+").containsMatchIn(line) -> {
                flush()
                blocks.add(Block.Bullet("•", line.replace(Regex("^\\s*[-*+]\\s+"), "")))
            }

            Regex("^\\s*\\d+[.)]\\s+").containsMatchIn(line) -> {
                flush()
                val marker = Regex("^\\s*(\\d+)[.)]").find(line)?.groupValues?.get(1).orEmpty() + "."
                blocks.add(Block.Bullet(marker, line.replace(Regex("^\\s*\\d+[.)]\\s+"), "")))
            }

            line.isBlank() -> flush()
            else -> {
                if (paragraph.isNotEmpty()) paragraph.append('\n')
                paragraph.append(line)
            }
        }
        i++
    }
    flush()
    return blocks
}

private val INLINE = Regex("(\\*\\*|__)(.+?)\\1|(\\*|_)(.+?)\\3|`([^`]+)`|\\[([^\\]]+)\\]\\(([^)]+)\\)|(https?://\\S+)")

private fun inline(source: String, colors: HaloColors): AnnotatedString = buildAnnotatedString {
    var cursor = 0
    for (match in INLINE.findAll(source)) {
        if (match.range.first > cursor) append(source.substring(cursor, match.range.first))
        val groups = match.groupValues
        when {
            groups[2].isNotEmpty() -> withSpan(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(groups[2]) }
            groups[4].isNotEmpty() -> withSpan(SpanStyle(fontStyle = FontStyle.Italic)) { append(groups[4]) }
            groups[5].isNotEmpty() -> withSpan(
                SpanStyle(fontFamily = FontFamily.Monospace, background = colors.fillSecondary),
            ) { append(groups[5]) }

            groups[6].isNotEmpty() -> withSpan(
                SpanStyle(color = colors.accent, textDecoration = TextDecoration.Underline),
            ) { append(groups[6]) }

            groups[8].isNotEmpty() -> withSpan(
                SpanStyle(color = colors.accent, textDecoration = TextDecoration.Underline),
            ) { append(groups[8]) }

            else -> append(match.value)
        }
        cursor = match.range.last + 1
    }
    if (cursor < source.length) append(source.substring(cursor))
}

private inline fun androidx.compose.ui.text.AnnotatedString.Builder.withSpan(
    style: SpanStyle,
    block: androidx.compose.ui.text.AnnotatedString.Builder.() -> Unit,
) {
    val start = length
    block()
    addStyle(style, start, length)
}
