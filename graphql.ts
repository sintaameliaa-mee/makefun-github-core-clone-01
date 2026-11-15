// graphql.ts — the GraphQL v4 API at /api/graphql: a small recursive-descent parser
// for the documents gh and github-mcp-server send, plus an executor over the same store
// REST and MCP use. Unknown fields are GraphQL errors (HTTP 200 with an `errors`
// array naming the field); an unknown repository is data.repository = null with no
// errors; two operation documents in one body answer in order (operation batching).

import {
  VIEWER,
  Forge,
  globalId,
  isoOf,
  nextTimestamp,
  parseGlobalId,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { jsonResult, type HandlerResult } from './httputil.ts';

// ---------------------------------------------------------------------------
// parser (the subset the suite's documents use)
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

class GraphQLSyntaxError extends Error {}

interface Token {
  kind: 'name' | 'string' | 'number' | 'punct' | 'spread';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const esc = input[i + 1]!;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'u' && i + 5 < input.length) {
            value += String.fromCharCode(parseInt(input.slice(i + 2, i + 6), 16));
            i += 4;
          } else value += esc;
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      i += 1; // closing quote
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9.]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'number', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_0-9A-Za-z]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new GraphQLSyntaxError(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new GraphQLSyntaxError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GraphQLSyntaxError(`expected "${value}", got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GraphQLSyntaxError(`expected a name, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new GraphQLSyntaxError('empty document');
    return operations;
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const first = this.peek();
    if (first?.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      operation = first.value;
      this.next();
      const maybeName = this.peek();
      if (maybeName?.kind === 'name') name = this.next().value;
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseVariableDefinitions();
    }
    const selection = this.parseSelectionSet();
    return { operation, name, selection };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
        this.next();
        this.parseValue();
      }
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      const on = this.next();
      if (on.kind !== 'name' || on.value !== 'on') throw new GraphQLSyntaxError('only inline fragments are supported');
      const typeCondition = this.expectName();
      return { kind: 'fragment', typeCondition, selection: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives (@include/@skip) are not used by the suite; skip them if present.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
        this.expectPunct(')');
      }
    }
    let selection: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new GraphQLSyntaxError(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type AnyRecord = Record<string, unknown>;

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'number':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: AnyRecord = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): AnyRecord {
  const args: AnyRecord = {};
  for (const arg of field.args) args[arg.name] = resolveValue(arg.value, variables);
  return args;
}

function isRecord(value: unknown): value is AnyRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Execute one operation's selection set against a parent value. */
function executeSelection(parent: unknown, selection: readonly SelectionNode[], ctx: ExecContext): unknown {
  if (parent === null || parent === undefined) return null;
  if (Array.isArray(parent)) {
    return parent.map((entry) => executeSelection(entry, selection, ctx));
  }
  if (!isRecord(parent) || typeof parent.__typename !== 'string') return parent;
  const out: AnyRecord = {};
  for (const node of selection) {
    if (node.kind === 'fragment') {
      if (node.typeCondition !== parent.__typename) continue;
      const merged = executeSelection(parent, node.selection, ctx);
      if (isRecord(merged)) Object.assign(out, merged);
      continue;
    }
    const key = node.alias ?? node.name;
    const args = argsOf(node, ctx.variables);
    const value = resolveField(parent, node.name, args, ctx);
    if (value === FIELD_ERROR) continue;
    out[key] = node.selection ? executeSelection(value, node.selection, ctx) : value;
  }
  return out;
}

const FIELD_ERROR = Symbol('field-error');

/** One field of one parent type, or FIELD_ERROR (with the error recorded). */
function resolveField(parent: AnyRecord, field: string, args: AnyRecord, ctx: ExecContext): unknown {
  const type = parent.__typename as string;
  try {
    switch (type) {
      case 'Query':
        return resolveQueryField(parent, field, args, ctx);
      case 'Mutation':
        return resolveMutationField(parent, field, args, ctx);
      case 'User':
        return resolveUserField(parent, field);
      case 'Repository':
        return resolveRepositoryField(parent, field, args, ctx);
      case 'Issue':
        return resolveIssueField(parent, field);
      case 'PullRequest':
        return resolvePullRequestField(parent, field, args, ctx);
      case 'IssueConnection':
      case 'PullRequestConnection':
      case 'PullRequestFileConnection':
        return resolveConnectionField(parent, field);
      case 'PageInfo':
        return parent[field] ?? null;
      case 'Ref':
        return resolveRefField(parent, field);
      case '__Type':
        return resolveIntrospectionField(parent, field, args);
      case '__Field':
      case '__EnumValue':
        return parent[field] ?? null;
      case 'CreateIssuePayload':
      case 'CloseIssuePayload':
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload':
        return parent[field] ?? null;
      case 'AddCommentPayload':
        return parent[field] ?? null;
      case 'CommentEdge':
        return parent[field] ?? null;
      case 'IssueComment':
        return parent[field] ?? null;
      case 'PullRequestFile':
        return parent[field] ?? null;
      default:
        break;
    }
  } catch (err) {
    if (err instanceof FieldFailure) {
      ctx.errors.push({ message: err.message });
      return FIELD_ERROR;
    }
    throw err;
  }
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${type}".` });
  return FIELD_ERROR;
}

class FieldFailure extends Error {}

// -- wrappers: store objects as GraphQL-typed values --------------------------

function userValue(): AnyRecord {
  return { __typename: 'User', login: VIEWER.login, id: globalId('User', String(VIEWER.id)), name: VIEWER.name, email: VIEWER.email };
}

function repositoryValue(repo: Repo): AnyRecord {
  return { __typename: 'Repository', repo };
}

function issueValue(repo: Repo, issue: Issue): AnyRecord {
  return { __typename: 'Issue', repo, issue };
}

function pullRequestValue(repo: Repo, pull: PullRequest): AnyRecord {
  return { __typename: 'PullRequest', repo, pull };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

// -- Query -------------------------------------------------------------------

function resolveQueryField(_parent: AnyRecord, field: string, args: AnyRecord, ctx: ExecContext): unknown {
  switch (field) {
    case 'viewer':
      return userValue();
    case 'repository': {
      const owner = args.owner as string;
      const name = args.name as string;
      const repo = ctx.forge.getRepo(owner, name);
      return repo ? repositoryValue(repo) : null;
    }
    case 'node': {
      const parsed = parseGlobalId(String(args.id ?? ''));
      if (!parsed) return null;
      if (parsed.type === 'Repository') {
        const repo = ctx.forge.getRepoByDatabaseId(Number(parsed.key));
        return repo ? repositoryValue(repo) : null;
      }
      if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
        const [dbId, number] = parsed.key.split(':');
        const repo = ctx.forge.getRepoByDatabaseId(Number(dbId));
        if (!repo) return null;
        if (parsed.type === 'Issue') {
          const issue = repo.issues.get(Number(number));
          return issue ? issueValue(repo, issue) : null;
        }
        const pull = repo.pulls.get(Number(number));
        return pull ? pullRequestValue(repo, pull) : null;
      }
      return null;
    }
    case '__type': {
      return introspectionType(String(args.name ?? ''));
    }
    default:
      throw new UnknownField(field, 'Query');
  }
}

class UnknownField extends FieldFailure {
  constructor(field: string, type: string) {
    super(`Cannot query field "${field}" on type "${type}".`);
  }
}

function resolveUserField(parent: AnyRecord, field: string): unknown {
  switch (field) {
    case 'login':
    case 'id':
    case 'name':
    case 'email':
      return parent[field];
    default:
      throw new UnknownField(field, 'User');
  }
}

// -- Repository --------------------------------------------------------------

function resolveRepositoryField(parent: AnyRecord, field: string, args: AnyRecord, ctx: ExecContext): unknown {
  const repo = parent.repo as Repo;
  switch (field) {
    case 'id':
      return repo.nodeId;
    case 'databaseId':
      return repo.databaseId;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return repo.fullName;
    case 'description':
      return repo.description;
    case 'owner':
      return userValue();
    case 'defaultBranchRef': {
      const tip = repo.branchTip(repo.defaultBranch);
      return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch, oid: tip };
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'issue': {
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueValue(repo, issue) : null;
    }
    case 'issues':
      return issuesConnection(repo, args);
    case 'pullRequest': {
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullRequestValue(repo, pull) : null;
    }
    case 'pullRequests':
      return pullRequestsConnection(repo, args);
    default:
      throw new UnknownField(field, 'Repository');
  }
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberAfterCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function issuesConnection(repo: Repo, args: AnyRecord): AnyRecord {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const descending = orderBy?.field === 'CREATED_AT' && orderBy?.direction === 'DESC';
  let issues = [...repo.issues.values()];
  if (states) {
    issues = issues.filter((issue) => states.includes(issueState(issue)));
  }
  issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  const after = numberAfterCursor(args.after);
  if (after !== null) {
    issues = issues.filter((issue) => (descending ? issue.number < after : issue.number > after));
  }
  const first = typeof args.first === 'number' && args.first > 0 ? Math.trunc(args.first) : issues.length;
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueValue(repo, issue)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? cursorFor(page[0]!.number) : null,
      endCursor,
    },
    totalCount: issues.length,
  };
}

function pullRequestsConnection(repo: Repo, args: AnyRecord): AnyRecord {
  const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
  let pulls = [...repo.pulls.values()].filter((pull) => states.includes(pullState(pull)));
  pulls.sort((a, b) => b.number - a.number);
  const after = numberAfterCursor(args.after);
  if (after !== null) pulls = pulls.filter((pull) => pull.number < after);
  const first = typeof args.first === 'number' && args.first > 0 ? Math.trunc(args.first) : pulls.length;
  const page = pulls.slice(0, first);
  const hasNextPage = pulls.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullRequestValue(repo, pull)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? cursorFor(page[0]!.number) : null,
      endCursor,
    },
    totalCount: pulls.length,
  };
}

// -- Issue / PullRequest -----------------------------------------------------

function resolveIssueField(parent: AnyRecord, field: string): unknown {
  const issue = parent.issue as Issue;
  const repo = parent.repo as Repo;
  switch (field) {
    case 'id':
      return globalId('Issue', `${repo.databaseId}:${issue.number}`);
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'body':
      return issue.body;
    case 'state':
      return issueState(issue);
    case 'url':
      return '';
    case 'createdAt':
      return issue.createdAt;
    case 'closedAt':
      return issue.state === 'closed' ? issue.updatedAt : null;
    case 'author':
      return userValue();
    case 'repository':
      return repositoryValue(repo);
    default:
      throw new UnknownField(field, 'Issue');
  }
}

function resolvePullRequestField(parent: AnyRecord, field: string, args: AnyRecord, _ctx: ExecContext): unknown {
  const pull = parent.pull as PullRequest;
  const repo = parent.repo as Repo;
  switch (field) {
    case 'id':
      return globalId('PullRequest', `${repo.databaseId}:${pull.number}`);
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      return pullState(pull);
    case 'merged':
      return pull.merged;
    case 'mergeable':
      if (pull.state !== 'open') return 'UNKNOWN';
      return repo.mergeable(pull) ? 'MERGEABLE' : 'CONFLICTING';
    case 'headRefName':
      return pull.headRef;
    case 'baseRefName':
      return pull.baseRef;
    case 'headRef': {
      const tip = repo.branchTip(pull.headRef);
      return tip === undefined ? null : { __typename: 'Ref', name: pull.headRef, oid: tip };
    }
    case 'baseRef': {
      const tip = repo.branchTip(pull.baseRef);
      return tip === undefined ? null : { __typename: 'Ref', name: pull.baseRef, oid: tip };
    }
    case 'files': {
      const first = typeof args.first === 'number' && args.first > 0 ? Math.trunc(args.first) : 100;
      const files = repo.pullFiles(pull).slice(0, first);
      return {
        __typename: 'PullRequestFileConnection',
        nodes: files.map((file) => ({ __typename: 'PullRequestFile', path: file.filename })),
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: files.length,
      };
    }
    case 'author':
      return userValue();
    case 'repository':
      return repositoryValue(repo);
    default:
      throw new UnknownField(field, 'PullRequest');
  }
}

function resolveConnectionField(parent: AnyRecord, field: string): unknown {
  switch (field) {
    case 'nodes':
    case 'pageInfo':
    case 'totalCount':
      return parent[field] ?? null;
    default:
      throw new UnknownField(field, parent.__typename as string);
  }
}

function resolveRefField(parent: AnyRecord, field: string): unknown {
  switch (field) {
    case 'name':
      return parent.name;
    case 'id':
      return parent.oid;
    default:
      throw new UnknownField(field, 'Ref');
  }
}

// -- introspection -----------------------------------------------------------

const INTROSPECTION: Record<string, { kind: string; fields: string[]; enumValues: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'repository', 'assignees', 'milestone', 'locked', 'viewerCanUpdate', 'viewerCanReact', 'reactionGroups', 'timelineItems'],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'url', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'author', 'repository', 'reviews', 'reviewRequests', 'isDraft', 'additions', 'deletions', 'changedFiles', 'commits', 'labels', 'assignees', 'milestone', 'locked'],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'forkCount', 'stargazerCount', 'watcherCount', 'primaryLanguage', 'licenseInfo', 'branches', 'refs', 'commit', 'object', 'defaultBranch', 'homepageUrl', 'isArchived', 'isDisabled', 'isFork', 'isLocked', 'isMirror', 'isTemplate', 'visibility'],
    enumValues: [],
  },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'REGISTRY_PACKAGE', 'MARKETPLACE', 'TOPIC'],
  },
  User: {
    kind: 'OBJECT',
    fields: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'createdAt', 'updatedAt', 'bio', 'company', 'location', 'repositories'],
    enumValues: [],
  },
};

function introspectionType(name: string): AnyRecord | null {
  const entry = INTROSPECTION[name];
  if (!entry) return null;
  return {
    __typename: '__Type',
    name,
    kind: entry.kind,
    fields: entry.fields.map((field) => ({ __typename: '__Field', name: field, description: '' })),
    enumValues: entry.enumValues.map((value) => ({ __typename: '__EnumValue', name: value, description: '' })),
  };
}

function resolveIntrospectionField(parent: AnyRecord, field: string, _args: AnyRecord): unknown {
  switch (field) {
    case 'name':
    case 'kind':
      return parent[field];
    case 'fields':
      return parent.fields ?? [];
    case 'enumValues':
      return parent.enumValues ?? [];
    default:
      throw new UnknownField(field, '__Type');
  }
}

// -- mutations ---------------------------------------------------------------

function resolveMutationField(_parent: AnyRecord, field: string, args: AnyRecord, ctx: ExecContext): unknown {
  const input = isRecord(args.input) ? args.input : {};
  switch (field) {
    case 'createIssue': {
      const repo = repoFromGlobalId(ctx, String(input.repositoryId ?? ''));
      if (!repo) throw new FieldFailure('createIssue: the repository id does not name a repository');
      const issue = repo.createIssue(
        { title: String(input.title ?? ''), body: String(input.body ?? ''), labels: [] },
        { id: ctx.forge.allocateIssueId() },
      );
      return { __typename: 'CreateIssuePayload', issue: issueValue(repo, issue) };
    }
    case 'closeIssue': {
      const found = issueFromGlobalId(ctx, String(input.issueId ?? ''));
      if (!found) throw new FieldFailure('closeIssue: the issue id does not name an issue');
      found.issue.state = 'closed';
      found.issue.cachedJson = null;
      return { __typename: 'CloseIssuePayload', issue: issueValue(found.repo, found.issue) };
    }
    case 'createPullRequest': {
      const repo = repoFromGlobalId(ctx, String(input.repositoryId ?? ''));
      if (!repo) throw new FieldFailure('createPullRequest: the repository id does not name a repository');
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      if (repo.branchTip(headRef) === undefined) throw new FieldFailure(`createPullRequest: head branch "${headRef}" does not exist`);
      if (repo.branchTip(baseRef) === undefined) throw new FieldFailure(`createPullRequest: base branch "${baseRef}" does not exist`);
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
          throw new FieldFailure('createPullRequest: a pull request for this head and base already exists');
        }
      }
      const pull = repo.createPull(
        { title: String(input.title ?? ''), body: String(input.body ?? ''), headRef, baseRef },
        { id: ctx.forge.allocateIssueId() },
      );
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullRequestValue(repo, pull) };
    }
    case 'mergePullRequest': {
      const found = pullFromGlobalId(ctx, String(input.pullRequestId ?? ''));
      if (!found) throw new FieldFailure('mergePullRequest: the pull request id does not name a pull request');
      if (found.pull.state !== 'open') throw new FieldFailure('mergePullRequest: the pull request is not open');
      const merged = found.repo.squashMerge(found.pull);
      if ('conflict' in merged) throw new FieldFailure('mergePullRequest: the pull request has conflicts');
      return { __typename: 'MergePullRequestPayload', pullRequest: pullRequestValue(found.repo, found.pull) };
    }
    case 'addComment': {
      const found = issueFromGlobalId(ctx, String(input.subjectId ?? ''));
      if (!found) throw new FieldFailure('addComment: the subject id does not name an issue');
      const comment = {
        id: ctx.forge.allocateCommentId(),
        body: String(input.body ?? ''),
        createdAt: isoOf(nextTimestamp()),
      };
      found.issue.comments.push(comment);
      found.issue.cachedJson = null;
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'CommentEdge',
          node: { __typename: 'IssueComment', id: globalId('IssueComment', String(comment.id)), body: comment.body },
        },
      };
    }
    default:
      throw new UnknownField(field, 'Mutation');
  }
}

function repoFromGlobalId(ctx: ExecContext, id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== 'Repository') return null;
  return ctx.forge.getRepoByDatabaseId(Number(parsed.key)) ?? null;
}

function issueFromGlobalId(ctx: ExecContext, id: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== 'Issue') return null;
  const [dbId, number] = parsed.key.split(':');
  const repo = ctx.forge.getRepoByDatabaseId(Number(dbId));
  if (!repo) return null;
  const issue = repo.issues.get(Number(number));
  return issue ? { repo, issue } : null;
}

function pullFromGlobalId(ctx: ExecContext, id: string): { repo: Repo; pull: PullRequest } | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== 'PullRequest') return null;
  const [dbId, number] = parsed.key.split(':');
  const repo = ctx.forge.getRepoByDatabaseId(Number(dbId));
  if (!repo) return null;
  const pull = repo.pulls.get(Number(number));
  return pull ? { repo, pull } : null;
}

// ---------------------------------------------------------------------------
// the endpoint
// ---------------------------------------------------------------------------

export interface GraphQLOperationInput {
  query: string;
  variables?: Record<string, unknown>;
}

export function executeGraphQL(forge: Forge, operation: GraphQLOperationInput): { data: unknown; errors?: Array<{ message: string }> } {
  const variables = operation.variables ?? {};
  let operations: OperationNode[];
  try {
    operations = new Parser(tokenize(operation.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
  }
  const op = operations[0]!;
  const ctx: ExecContext = { forge, variables, errors: [] };
  const root: AnyRecord = { __typename: op.operation === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelection(root, op.selection, ctx);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

/** POST /api/graphql: one operation object, or an array of them (batching). */
export function handleGraphQL(forge: Forge, body: unknown, jsonError: boolean): HandlerResult {
  if (jsonError) return jsonResult(400, { message: 'Problems parsing JSON' });
  if (Array.isArray(body)) {
    const responses = body.map((entry) => {
      if (!isRecord(entry) || typeof entry.query !== 'string') {
        return { data: null, errors: [{ message: 'a batched operation needs a query string' }] };
      }
      return executeGraphQL(forge, {
        query: entry.query,
        variables: isRecord(entry.variables) ? entry.variables : {},
      });
    });
    return jsonResult(200, responses);
  }
  if (!isRecord(body) || typeof body.query !== 'string') {
    return jsonResult(200, { data: null, errors: [{ message: 'the request needs a query string' }] });
  }
  return jsonResult(
    200,
    executeGraphQL(forge, {
      query: body.query,
      variables: isRecord(body.variables) ? body.variables : {},
    }),
  );
}
