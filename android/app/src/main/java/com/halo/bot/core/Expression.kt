package com.halo.bot.core

// The case for an expression language over a rule table is OpenBot's (MIT, (c) 2026 CopilotKit).
// See NOTICE.

/**
 * A tiny expression language for policy rules.
 *
 * WHY. A boundary somebody actually wants is a sentence: "never click anything that says Submit on a
 * page that is not ours". Fields — surface, intent, a command prefix — express the shapes I thought
 * of; an expression expresses the one they thought of.
 *
 * WHAT IT IS NOT. Not CEL and not Kotlin. There is no assignment, no function the host did not
 * register, no loops, no member call on a value. The evaluator walks its own tree and can only
 * produce a boolean, a string, a number or nothing, so a rule cannot reach anything.
 *
 * Grammar, lowest precedence first:
 *
 *   or      := and ( '||' and )*
 *   and     := not ( '&&' not )*
 *   not     := '!' not | compare
 *   compare := primary ( ('=='|'!='|'>'|'>='|'<'|'<=') primary )?
 *   primary := '(' or ')' | call | path | string | number | 'true' | 'false'
 *   call    := ident '(' or ( ',' or )* ')'
 *   path    := ident ( '.' ident )*
 */

class ExpressionError(message: String) : Exception(message)

private sealed interface Node {
    data class Literal(val value: Any?) : Node
    data class Path(val path: List<String>) : Node
    data class Call(val name: String, val args: List<Node>) : Node
    data class Not(val operand: Node) : Node
    data class Binary(val op: String, val left: Node, val right: Node) : Node
}

private data class Token(val type: String, val text: String)

private val OPERATORS = listOf("&&", "||", "==", "!=", ">=", "<=", "(", ")", ",", ".", "!", ">", "<")

private fun tokenize(source: String): List<Token> {
    val tokens = mutableListOf<Token>()
    var i = 0
    while (i < source.length) {
        val ch = source[i]
        if (ch.isWhitespace()) {
            i++
            continue
        }
        if (ch == '"' || ch == '\'') {
            val text = StringBuilder()
            i++
            while (i < source.length && source[i] != ch) {
                // One escape, for a quote inside a quoted string. Anything else is itself.
                if (source[i] == '\\' && i + 1 < source.length) i++
                text.append(source[i++])
            }
            if (i >= source.length) throw ExpressionError("a quoted string was never closed")
            i++
            tokens.add(Token("string", text.toString()))
            continue
        }
        if (ch.isDigit()) {
            val text = StringBuilder()
            while (i < source.length && (source[i].isDigit() || source[i] == '.')) text.append(source[i++])
            tokens.add(Token("number", text.toString()))
            continue
        }
        if (ch.isLetter() || ch == '_') {
            val text = StringBuilder()
            while (i < source.length && (source[i].isLetterOrDigit() || source[i] == '_')) text.append(source[i++])
            tokens.add(Token("ident", text.toString()))
            continue
        }
        val op = OPERATORS.firstOrNull { source.startsWith(it, i) }
            ?: throw ExpressionError("I do not understand \"$ch\" here")
        i += op.length
        tokens.add(Token("op", op))
    }
    return tokens
}

private class Parser(private val tokens: List<Token>) {
    private var at = 0

    private fun peek(): Token? = tokens.getOrNull(at)

    private fun eat(text: String): Boolean {
        if (peek()?.text == text) {
            at++
            return true
        }
        return false
    }

    private fun expect(text: String) {
        if (!eat(text)) throw ExpressionError("expected \"$text\"")
    }

    fun parse(): Node {
        val node = or()
        if (at < tokens.size) throw ExpressionError("unexpected \"" + peek()!!.text + "\"")
        return node
    }

    private fun or(): Node {
        var left = and()
        while (eat("||")) left = Node.Binary("||", left, and())
        return left
    }

    private fun and(): Node {
        var left = not()
        while (eat("&&")) left = Node.Binary("&&", left, not())
        return left
    }

    private fun not(): Node {
        if (eat("!")) return Node.Not(not())
        return compare()
    }

    private fun compare(): Node {
        val left = primary()
        for (op in listOf("==", "!=", ">=", "<=", ">", "<")) {
            if (eat(op)) return Node.Binary(op, left, primary())
        }
        return left
    }

    private fun primary(): Node {
        val token = peek() ?: throw ExpressionError("the expression ends early")
        if (token.text == "(") {
            at++
            val inner = or()
            expect(")")
            return inner
        }
        if (token.type == "string") {
            at++
            return Node.Literal(token.text)
        }
        if (token.type == "number") {
            at++
            return Node.Literal(token.text.toDoubleOrNull() ?: 0.0)
        }
        if (token.type == "ident") {
            at++
            if (token.text == "true") return Node.Literal(true)
            if (token.text == "false") return Node.Literal(false)
            if (eat("(")) {
                val args = mutableListOf<Node>()
                if (!eat(")")) {
                    do {
                        args.add(or())
                    } while (eat(","))
                    expect(")")
                }
                return Node.Call(token.text, args)
            }
            val path = mutableListOf(token.text)
            while (eat(".")) {
                val next = peek()
                if (next?.type != "ident") throw ExpressionError("expected a name after \".\"")
                at++
                path.add(next.text)
            }
            return Node.Path(path)
        }
        throw ExpressionError("unexpected \"" + token.text + "\"")
    }
}

/**
 * The functions a rule may call. Case-insensitive on purpose: a rule saying "never click submit"
 * should also catch a button labelled SUBMIT.
 */
private val FUNCTIONS: Map<String, (List<Any?>) -> Any?> = mapOf(
    "contains" to { a -> text(a.getOrNull(0)).lowercase().contains(text(a.getOrNull(1)).lowercase()) },
    "startsWith" to { a -> text(a.getOrNull(0)).lowercase().startsWith(text(a.getOrNull(1)).lowercase()) },
    "endsWith" to { a -> text(a.getOrNull(0)).lowercase().endsWith(text(a.getOrNull(1)).lowercase()) },
    "matches" to { a ->
        try {
            Regex(text(a.getOrNull(1)), RegexOption.IGNORE_CASE).containsMatchIn(text(a.getOrNull(0)))
        } catch (_: Exception) {
            // An unparseable pattern is a broken rule, not a rule that did not match: returning false
            // here would quietly weaken a deny. Throwing takes the caller's fail-closed path instead.
            throw ExpressionError("\"" + text(a.getOrNull(1)) + "\" is not a valid pattern")
        }
    },
    "lower" to { a -> text(a.getOrNull(0)).lowercase() },
    "length" to { a -> text(a.getOrNull(0)).length.toDouble() },
)

private fun text(value: Any?): String = when (value) {
    null -> ""
    is String -> value
    is Double -> if (value == value.toLong().toDouble()) value.toLong().toString() else value.toString()
    else -> value.toString()
}

private fun lookup(context: Map<String, Any?>, path: List<String>): Any? {
    var cursor: Any? = context
    for (step in path) {
        val map = cursor as? Map<*, *> ?: return null
        cursor = map[step]
    }
    return when (cursor) {
        is String, is Boolean, is Double, is Int, is Long -> cursor
        else -> null
    }
}

private fun truthy(value: Any?): Boolean = when (value) {
    null -> false
    is Boolean -> value
    is String -> value.isNotEmpty()
    is Double -> value != 0.0
    is Int -> value != 0
    else -> true
}

private fun evaluate(node: Node, context: Map<String, Any?>): Any? = when (node) {
    is Node.Literal -> node.value
    is Node.Path -> lookup(context, node.path)
    is Node.Not -> !truthy(evaluate(node.operand, context))
    is Node.Call -> {
        val fn = FUNCTIONS[node.name] ?: throw ExpressionError("there is no function called " + node.name)
        fn(node.args.map { evaluate(it, context) })
    }

    is Node.Binary -> when (node.op) {
        // Short-circuit, so `element.name != "" && contains(element.name, "x")` is safe to write.
        "&&" -> truthy(evaluate(node.left, context)) && truthy(evaluate(node.right, context))
        "||" -> truthy(evaluate(node.left, context)) || truthy(evaluate(node.right, context))
        else -> {
            val left = evaluate(node.left, context)
            val right = evaluate(node.right, context)
            when (node.op) {
                // Comparison against an absent field is a plain false, not an error: every field is
                // bound neutrally by the caller precisely so a rule about one action surface does not
                // blow up on another. See the note on neutral binding in core/Policy.kt.
                "==" -> text(left).lowercase() == text(right).lowercase()
                "!=" -> text(left).lowercase() != text(right).lowercase()
                ">" -> number(left) > number(right)
                ">=" -> number(left) >= number(right)
                "<" -> number(left) < number(right)
                "<=" -> number(left) <= number(right)
                else -> throw ExpressionError("unknown operator " + node.op)
            }
        }
    }
}

private fun number(value: Any?): Double = when (value) {
    is Double -> value
    is Int -> value.toDouble()
    is Long -> value.toDouble()
    is Boolean -> if (value) 1.0 else 0.0
    is String -> value.toDoubleOrNull() ?: Double.NaN
    else -> Double.NaN
}

private val cache = LinkedHashMap<String, Node>()

/** Parses once and remembers, because a rule is evaluated on every action and rarely changes. */
private fun compile(expression: String): Node = synchronized(cache) {
    cache[expression]?.let { return it }
    val node = Parser(tokenize(expression)).parse()
    if (cache.size > 200) cache.clear()
    cache[expression] = node
    node
}

/** True when the expression is well formed. What the rules editor uses to refuse a typo. */
fun checkExpression(expression: String): String? = try {
    compile(expression)
    null
} catch (error: Exception) {
    error.message ?: error.toString()
}

/**
 * Does this expression hold for this action?
 *
 * `onError` is what a broken rule means, and it differs by list: a broken deny must not stop denying,
 * a broken allow must not start permitting. A rule can also be broken without throwing — `"Submit"`
 * parses and evaluates to a string, which is not an answer to "does this apply". Anything that is not
 * a boolean takes the same fail-closed path as a throw; false is a real answer and stays one.
 */
fun matchesExpression(
    expression: String,
    context: Map<String, Any?>,
    onError: Boolean,
    report: ((String) -> Unit)? = null,
): Boolean = try {
    val result = evaluate(compile(expression), context)
    if (result is Boolean) {
        result
    } else {
        val what = if (result == null) "nothing" else result::class.simpleName
        report?.invoke("the rule \"$expression\" answered with $what, not true or false")
        onError
    }
} catch (error: Exception) {
    report?.invoke("the rule \"$expression\" is broken: " + (error.message ?: error.toString()))
    onError
}
