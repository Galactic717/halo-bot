// The case for an expression language over a rule table is OpenBot's (MIT, (c) 2026 CopilotKit).
// See NOTICE.
/**
 * A tiny expression language for policy rules.
 *
 * WHY. A boundary somebody actually wants is a sentence: "never click anything that says Submit on a
 * page that is not ours". Fields — surface, intent, a command prefix — express the shapes I thought
 * of; an expression expresses the one they thought of. This is the same argument OpenBot makes for
 * putting CEL in its gateway, and the same reasoning, in about two hundred lines instead of a
 * dependency, because Halo has four of those and they are all React.
 *
 * WHAT IT IS NOT. Not CEL and not JavaScript. There is no property assignment, no function the host
 * did not register, no loops, no `new`, no member call on a value. The evaluator walks its own AST
 * and can only produce a boolean, a string, a number or undefined, so a rule cannot reach anything.
 *
 * Grammar, lowest precedence first:
 *
 *   or    := and ( '||' and )*
 *   and   := not ( '&&' not )*
 *   not   := '!' not | compare
 *   compare := primary ( ('=='|'!='|'>'|'>='|'<'|'<=') primary )?
 *   primary := '(' or ')' | call | path | string | number | 'true' | 'false'
 *   call  := ident '(' or ( ',' or )* ')'
 *   path  := ident ( '.' ident )*
 */

export type Value = string | number | boolean | undefined;

export class ExpressionError extends Error {}

type Node =
  | { kind: 'literal'; value: Value }
  | { kind: 'path'; path: string[] }
  | { kind: 'call'; name: string; args: Node[] }
  | { kind: 'not'; operand: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node };

type Token = { type: 'ident' | 'string' | 'number' | 'op'; text: string };

const OPERATORS = ['&&', '||', '==', '!=', '>=', '<=', '(', ')', ',', '.', '!', '>', '<'];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let text = '';
      i++;
      while (i < source.length && source[i] !== ch) {
        // One escape, for a quote inside a quoted string. Anything else is itself.
        if (source[i] === '\\' && i + 1 < source.length) i++;
        text += source[i++];
      }
      if (i >= source.length) throw new ExpressionError('a quoted string was never closed');
      i++;
      tokens.push({ type: 'string', text });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let text = '';
      while (i < source.length && /[0-9.]/.test(source[i]!)) text += source[i++];
      tokens.push({ type: 'number', text });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let text = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) text += source[i++];
      tokens.push({ type: 'ident', text });
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (!op) throw new ExpressionError(`I do not understand "${ch}" here`);
    i += op.length;
    tokens.push({ type: 'op', text: op });
  }
  return tokens;
}

class Parser {
  private tokens: Token[];
  private at = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private eat(text: string): boolean {
    if (this.peek()?.text === text) {
      this.at++;
      return true;
    }
    return false;
  }

  private expect(text: string) {
    if (!this.eat(text)) throw new ExpressionError(`expected "${text}"`);
  }

  parse(): Node {
    const node = this.or();
    if (this.at < this.tokens.length) throw new ExpressionError(`unexpected "${this.peek()!.text}"`);
    return node;
  }

  private or(): Node {
    let left = this.and();
    while (this.eat('||')) left = { kind: 'binary', op: '||', left, right: this.and() };
    return left;
  }

  private and(): Node {
    let left = this.not();
    while (this.eat('&&')) left = { kind: 'binary', op: '&&', left, right: this.not() };
    return left;
  }

  private not(): Node {
    if (this.eat('!')) return { kind: 'not', operand: this.not() };
    return this.compare();
  }

  private compare(): Node {
    const left = this.primary();
    for (const op of ['==', '!=', '>=', '<=', '>', '<']) {
      if (this.eat(op)) return { kind: 'binary', op, left, right: this.primary() };
    }
    return left;
  }

  private primary(): Node {
    const token = this.peek();
    if (!token) throw new ExpressionError('the expression ends early');
    if (token.text === '(') {
      this.at++;
      const inner = this.or();
      this.expect(')');
      return inner;
    }
    if (token.type === 'string') {
      this.at++;
      return { kind: 'literal', value: token.text };
    }
    if (token.type === 'number') {
      this.at++;
      return { kind: 'literal', value: Number(token.text) };
    }
    if (token.type === 'ident') {
      this.at++;
      if (token.text === 'true') return { kind: 'literal', value: true };
      if (token.text === 'false') return { kind: 'literal', value: false };
      if (this.eat('(')) {
        const args: Node[] = [];
        if (!this.eat(')')) {
          do {
            args.push(this.or());
          } while (this.eat(','));
          this.expect(')');
        }
        return { kind: 'call', name: token.text, args };
      }
      const path = [token.text];
      while (this.eat('.')) {
        const next = this.peek();
        if (next?.type !== 'ident') throw new ExpressionError('expected a name after "."');
        this.at++;
        path.push(next.text);
      }
      return { kind: 'path', path };
    }
    throw new ExpressionError(`unexpected "${token.text}"`);
  }
}

/**
 * The functions a rule may call. Case-insensitive on purpose: a rule saying "never click submit"
 * should also catch a button labelled SUBMIT.
 */
const FUNCTIONS: Record<string, (...args: Value[]) => Value> = {
  contains: (haystack, needle) => String(haystack ?? '').toLowerCase().includes(String(needle ?? '').toLowerCase()),
  startsWith: (value, prefix) => String(value ?? '').toLowerCase().startsWith(String(prefix ?? '').toLowerCase()),
  endsWith: (value, suffix) => String(value ?? '').toLowerCase().endsWith(String(suffix ?? '').toLowerCase()),
  matches: (value, pattern) => {
    try {
      return new RegExp(String(pattern ?? ''), 'i').test(String(value ?? ''));
    } catch {
      // An unparseable pattern is a broken rule, not a rule that did not match: returning false here
      // would quietly weaken a deny. Throwing takes the caller's fail-closed path instead.
      throw new ExpressionError(`"${String(pattern)}" is not a valid pattern`);
    }
  },
  lower: (value) => String(value ?? '').toLowerCase(),
  length: (value) => String(value ?? '').length,
};

function lookup(context: Record<string, unknown>, path: string[]): Value {
  let cursor: unknown = context;
  for (const step of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[step];
  }
  if (cursor === null || cursor === undefined) return undefined;
  if (typeof cursor === 'string' || typeof cursor === 'number' || typeof cursor === 'boolean') return cursor;
  return undefined;
}

function truthy(value: Value): boolean {
  return value !== undefined && value !== false && value !== '' && value !== 0;
}

function evaluate(node: Node, context: Record<string, unknown>): Value {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'path':
      return lookup(context, node.path);
    case 'not':
      return !truthy(evaluate(node.operand, context));
    case 'call': {
      const fn = FUNCTIONS[node.name];
      if (!fn) throw new ExpressionError(`there is no function called ${node.name}`);
      return fn(...node.args.map((arg) => evaluate(arg, context)));
    }
    case 'binary': {
      // Short-circuit, so `element.name != "" && contains(element.name, "x")` is safe to write.
      if (node.op === '&&') return truthy(evaluate(node.left, context)) && truthy(evaluate(node.right, context));
      if (node.op === '||') return truthy(evaluate(node.left, context)) || truthy(evaluate(node.right, context));
      const left = evaluate(node.left, context);
      const right = evaluate(node.right, context);
      switch (node.op) {
        // Comparison against an absent field is a plain false, not an error: every field is bound
        // neutrally by the caller precisely so a rule about one action surface does not blow up on
        // another. See the note on neutral binding in host/policy.ts.
        case '==':
          return String(left ?? '').toLowerCase() === String(right ?? '').toLowerCase();
        case '!=':
          return String(left ?? '').toLowerCase() !== String(right ?? '').toLowerCase();
        case '>':
          return Number(left) > Number(right);
        case '>=':
          return Number(left) >= Number(right);
        case '<':
          return Number(left) < Number(right);
        case '<=':
          return Number(left) <= Number(right);
        default:
          throw new ExpressionError(`unknown operator ${node.op}`);
      }
    }
  }
}

const cache = new Map<string, Node>();

/** Parses once and remembers, because a rule is evaluated on every action and rarely changes. */
function compile(expression: string): Node {
  const cached = cache.get(expression);
  if (cached) return cached;
  const node = new Parser(tokenize(expression)).parse();
  if (cache.size > 200) cache.clear();
  cache.set(expression, node);
  return node;
}

/** True when the expression is well formed. What the rules editor uses to refuse a typo. */
export function checkExpression(expression: string): { ok: true } | { ok: false; error: string } {
  try {
    compile(expression);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Does this expression hold for this action?
 *
 * `onError` is what a broken rule means, and it differs by list: a broken deny must not stop denying,
 * a broken allow must not start permitting. A rule can also be broken without throwing — `"Submit"`
 * parses and evaluates to a string, which is not an answer to "does this apply", and is what somebody
 * writes who read the deny list as a list of labels. Anything that is not a boolean takes the same
 * fail-closed path as a throw; false is a real answer and stays one.
 */
export function matchesExpression(
  expression: string,
  context: Record<string, unknown>,
  onError: boolean,
  report?: (message: string) => void,
): boolean {
  try {
    const result = evaluate(compile(expression), context);
    if (typeof result === 'boolean') return result;
    report?.(`the rule "${expression}" answered with ${result === undefined ? 'nothing' : typeof result}, not true or false`);
    return onError;
  } catch (error) {
    report?.(`the rule "${expression}" is broken: ${error instanceof Error ? error.message : String(error)}`);
    return onError;
  }
}
