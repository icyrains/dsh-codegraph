// CodeGraph for DSH — Host-only dynamic Cordis plugin.
//
// Wraps the locally installed `codegraph` CLI (@colbymchenry/codegraph) into
// 13 model-visible dynamic Tools so the DSH agent can query a pre-indexed code
// knowledge graph, explore areas with source, follow callers/callees, analyze
// impact, and maintain the index — all without grepping through files.
//
// This is the exact source of the running package (cgdx-1/pkg-2). To redeclare
// it in a new session, paste the `apply` body below into code.host of a
// cordis_define call (host half only), then cordis_run it.
//
// It uses ctx.get('subprocess') (preferred) or ctx.get('shell') to run the
// CLI; the project root defaults to the calling session's cwd.

return {
  apply(ctx) {
    const sub = ctx.get('subprocess')
    const shell = ctx.get('shell')
    if (sub === undefined && shell === undefined) {
      throw new Error('codegraph-dsh: neither the subprocess nor the shell service is mounted on this Host. Enable a bash/subprocess executor (e.g. dsh-bash-local) to run the codegraph CLI, or run this Plugin in a deployment that provides one.')
    }

    // ANSI + control escape removal for model-facing text.
    function stripAnsi(text) {
      return String(text).replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    }

    function truncate(text, max) {
      if (text.length <= max) return text
      return text.slice(0, max) + '\n... [truncated] ...'
    }

    // Quote a CLI arg for the shell fallback path.
    function shQuote(value) {
      return "'" + String(value).replace(/'/g, "'\\''") + "'"
    }

    const resolvedExe = { value: null }

    function cwdOf(exec) {
      const agent = exec && exec.agent
      const header = agent && agent.session && agent.session.header
      return (header && header.cwd) ? header.cwd : undefined
    }

    // Run `codegraph <argv...>` and return the model-facing text.
    async function runCodegraph({ argv, cwd, signal, timeoutMs }) {
      if (sub !== undefined) {
        if (resolvedExe.value === null) {
          resolvedExe.value = await sub.resolveExecutable('codegraph')
        }
        const proc = sub.spawn({
          argv: [resolvedExe.value].concat(argv),
          cwd: cwd || '/',
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 8 * 1024 * 1024, spill: { maxBytes: 64 * 1024 * 1024 } },
            stderr: { maxBytes: 4 * 1024 * 1024, spill: { maxBytes: 64 * 1024 * 1024 } }
          },
          graceMs: 2000,
          signal: signal
        })
        const outcome = await proc.done
        const out = proc.collected.stdout ? proc.collected.stdout.readFrom(0) : undefined
        const err = proc.collected.stderr ? proc.collected.stderr.readFrom(0) : undefined
        const text = stripAnsi(out ? out.text : '')
        const errText = stripAnsi(err ? err.text : '')
        if (outcome.exitCode !== 0) {
          const detail = (errText && errText.trim()) ? errText.trim() : (text && text.trim())
          throw new Error(detail ? `codegraph exited ${outcome.exitCode}: ${truncate(detail, 2000)}` : `codegraph exited ${outcome.exitCode}`)
        }
        return text
      }
      // shell fallback
      const command = 'codegraph ' + argv.map(shQuote).join(' ')
      const spec = shell.resolve({
        command,
        workdir: (cwd || '/'),
        timeoutMs: timeoutMs || 120000,
        signal,
        stdoutMaxBytes: 8 * 1024 * 1024
      })
      const result = await shell.run(spec)
      const text = stripAnsi(result.stdout ? result.stdout.text : '')
      const errText = stripAnsi(result.stderr ? result.stderr.text : '')
      if (result.exitCode !== 0) {
        const detail = (errText && errText.trim()) ? errText.trim() : (text && text.trim())
        throw new Error(detail ? `codegraph exited ${result.exitCode}: ${truncate(detail, 2000)}` : `codegraph exited ${result.exitCode}`)
      }
      return text
    }

    // Define and register one tool.
    function registerTool(name, description, parameters, buildArgv, opts) {
      opts = opts || {}
      const tool = harness.defineTool({
        name,
        description,
        parameters,
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }]
        },
        timeoutMs: opts.timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          exec.signal.throwIfAborted()
          const base = cwdOf(exec)
          const projectRoot = (typeof args.path === 'string' && args.path.length > 0) ? args.path : base
          if (!projectRoot) throw new Error('codegraph: no session workspace (cwd) available; pass the project path explicitly via the `path` argument.')
          const argv = buildArgv(args, projectRoot)
          const out = await runCodegraph({ argv, cwd: projectRoot, signal: exec.signal, timeoutMs: opts.timeoutMs })
          return truncate(out, 200000)
        },
        presentCall: (args) => ({
          card: 'terminal',
          title: 'codegraph ' + argvPreview(buildArgv(args, '<project>')),
          description: opts.callDescription
        })
      })
      harness.registerTool(ctx, tool)
    }

    function argvPreview(argv) {
      const preview = argv.map((a) => (a === '<project>' || a === '/' || String(a).startsWith('/')) ? a : JSON.stringify(a)).join(' ')
      return preview.length > 120 ? preview.slice(0, 120) + '…' : preview
    }

    // --- index maintenance --------------------------------------------------
    registerTool('codegraph_status',
      'Show the CodeGraph index status for a project as JSON (initialized, version, projectPath, lastIndexed, fileCount, nodeCount, pendingChanges, languages). Run this first to check whether a project is indexed before using other codegraph tools. If the project is not initialized, run codegraph_init.',
      { path: { type: 'string', description: 'Project directory (default: the current session workspace).' } },
      (args, root) => ['status', '--json', root],
      { callDescription: 'Show CodeGraph index status' })

    registerTool('codegraph_init',
      'Initialize CodeGraph in a project directory and build the initial index. Run this once per project before querying with codegraph_query/node/explore. Creates a .codegraph/ directory. Optional force flag to initialize even if the path looks like a home or filesystem root.',
      { path: { type: 'string', description: 'Project directory (default: the current session workspace).' }, force: { type: 'boolean', description: 'Initialize even if the path looks like the home directory or a filesystem root.' } },
      (args, root) => ['init'].concat(args.force ? ['--force'] : []).concat([root]),
      { timeoutMs: 600000, callDescription: 'Initialize the CodeGraph index' })

    registerTool('codegraph_index',
      'Index (or re-index) all files in the project. Use after large changes or when codegraph_status reports reindexRecommended. Supports force to force a full re-index.',
      { path: { type: 'string', description: 'Project directory (default: the current session workspace).' }, force: { type: 'boolean', description: 'Force a full re-index even if already indexed.' } },
      (args, root) => ['index'].concat(args.force ? ['--force'] : []).concat([root]),
      { timeoutMs: 600000, callDescription: '(Re)index the project' })

    registerTool('codegraph_sync',
      'Incrementally sync the index with changes since the last index. Run after editing a file so queries reflect the new code.',
      { path: { type: 'string', description: 'Project directory (default: the current session workspace).' } },
      (args, root) => ['sync', root],
      { timeoutMs: 300000, callDescription: 'Sync the CodeGraph index' })

    registerTool('codegraph_uninit',
      'Remove CodeGraph from a project by deleting its .codegraph/ directory. Use only when the index is no longer needed.',
      { path: { type: 'string', description: 'Project directory (default: the current session workspace).' } },
      (args, root) => ['uninit', '--force', root],
      { timeoutMs: 120000, callDescription: 'Remove the CodeGraph index' })

    // --- query & exploration -------------------------------------------------
    registerTool('codegraph_query',
      'Search symbols in the codebase by name/query and return matching nodes as JSON (node kind, name, signature, filePath, startLine, score). Use to locate a symbol before diving into its source with codegraph_node. Requires an initialized project (run codegraph_init first).',
      { search: { type: 'string', required: true, description: 'Symbol name or partial name to search for (e.g. "multiply", "fetchUser").' }, path: { type: 'string', description: 'Project directory (default: the current session workspace).' }, limit: { type: 'integer', description: 'Maximum results (default 10).' }, kind: { type: 'string', description: 'Filter by node kind (function, class, interface, import, file, etc.).' } },
      (args, root) => ['query', '--json', '--path', root, '-l', String(args.limit || 10)].concat(args.kind ? ['-k', args.kind] : []).concat([args.search]),
      { callDescription: 'Search symbols in the codebase' })

    registerTool('codegraph_node',
      "Get one symbol's source with its caller/callee trail, or read a file with line numbers and its dependents. Pass a symbol name for symbol mode; pass a file path (or set file: true) for file mode. In file mode, offset/limit read a range with line numbers and symbols-only omits the code. Requires an initialized project.",
      { name: { type: 'string', required: true, description: 'A symbol name (e.g. multiply) or a file path (e.g. src/math.ts).' }, path: { type: 'string', description: 'Project directory (default: the current session workspace).' }, file: { type: 'boolean', description: 'Treat the name as a file path (disambiguate a symbol to this file).' }, offset: { type: 'integer', description: 'File mode: 1-based start line.' }, limit: { type: 'integer', description: 'File mode: maximum lines.' }, symbolsOnly: { type: 'boolean', description: 'File mode: only the symbol map + dependents, no source.' } },
      (args, root) => {
        const argv = ['node', '--path', root]
        if (args.file) argv.push('--file', args.name)
        if (args.offset) argv.push('--offset', String(args.offset))
        if (args.limit) argv.push('--limit', String(args.limit))
        if (args.symbolsOnly) argv.push('--symbols-only')
        argv.push(args.name)
        return argv
      },
      { timeoutMs: 60000, callDescription: 'Show a symbol or file with its trail' })

    registerTool('codegraph_explore',
      "Explore an area of the codebase: relevant symbols' verbatim source plus call paths in one shot. Give a natural-language description of the area you want (e.g. \"user authentication flow\"). Returns source of the most relevant files so you do not need to Read them. Requires an initialized project.",
      { query: { type: 'string', required: true, description: 'Natural-language area description, e.g. "payment checkout flow".' }, path: { type: 'string', description: 'Project directory (default: the current session workspace).' }, maxFiles: { type: 'integer', description: 'Maximum number of files to include source from.' } },
      (args, root) => ['explore', '--path', root].concat(args.maxFiles ? ['--max-files', String(args.maxFiles)] : []).concat([args.query]),
      { timeoutMs: 60000, callDescription: 'Explore a code area with source + call paths' })

    registerTool('codegraph_files',
      'Show the project file structure from the index as JSON (paths, languages, symbol counts). Supports filtering by directory, glob pattern, and tree/flat/grouped formats. Requires an initialized project.',
      { path: { type: 'string', description: 'Project directory (default: the current session workspace).' }, filter: { type: 'string', description: 'Only files under this directory.' }, pattern: { type: 'string', description: 'Only files matching this glob (e.g. "src/**/*.ts").' }, format: { type: 'string', description: 'Output format: tree, flat, or grouped.' }, maxDepth: { type: 'integer', description: 'Maximum directory depth for the tree format.' }, noMetadata: { type: 'boolean', description: 'Hide file metadata (language, symbol count).' } },
      (args, root) => {
        const argv = ['files', '--json', '--path', root]
        if (args.filter) argv.push('--filter', args.filter)
        if (args.pattern) argv.push('--pattern', args.pattern)
        if (args.format) argv.push('--format', args.format)
        if (args.maxDepth) argv.push('--max-depth', String(args.maxDepth))
        if (args.noMetadata) argv.push('--no-metadata')
        return argv
      },
      { callDescription: 'Show the indexed file structure' })

    // --- relations -----------------------------------------------------------
    registerTool('codegraph_callers',
      'Find all functions/methods that call a specific symbol. Returns JSON callers with name, kind, filePath, startLine. Useful to assess what would be affected by changing a function. Requires an initialized project.',
      { symbol: { type: 'string', required: true, description: 'The symbol to find callers for.' }, path: { type: 'string', description: 'Project directory (default: the current session workspace).' }, limit: { type: 'integer', description: 'Maximum results (default 20).' } },
      (args, root) => ['callers', '--json', '--path', root, '-l', String(args.limit || 20), args.symbol],
      { callDescription: 'Find callers of a symbol' })

    registerTool('codegraph_callees',
      'Find all functions/methods that a specific symbol calls. Returns JSON callees with name, kind, filePath, startLine. Useful to understand what a function depends on. Requires an initialized project.',
      { symbol: { type: 'string', required: true, description: 'The symbol to find callees for.' }, path: { type: 'string', description: 'Project directory (default: the current session workspace).' }, limit: { type: 'integer', description: 'Maximum results (default 20).' } },
      (args, root) => ['callees', '--json', '--path', root, '-l', String(args.limit || 20), args.symbol],
      { callDescription: 'Find callees of a symbol' })

    registerTool('codegraph_impact',
      'Analyze what code is affected by changing a symbol. Returns JSON with the affected nodes traversed up to a depth. Use before refactoring or renaming. Requires an initialized project.',
      { symbol: { type: 'string', required: true, description: 'The symbol to analyze impact for.' }, path: { type: 'string', description: 'Project directory (default: the current session workspace).' }, depth: { type: 'integer', description: 'Traversal depth (default 2).' } },
      (args, root) => ['impact', '--json', '--path', root, '-d', String(args.depth || 2), args.symbol],
      { callDescription: 'Analyze impact of changing a symbol' })

    registerTool('codegraph_affected',
      'Find test files affected by changed source files. Pass one or more changed source paths; returns JSON changedFiles + affectedTests. Use after modifying code to know which tests to run. Requires an initialized project.',
      { files: { type: 'array', required: true, description: 'Changed source file paths (relative to the project root), e.g. ["src/math.ts"].', items: { type: 'string' } }, path: { type: 'string', description: 'Project directory (default: the current session workspace).' }, depth: { type: 'integer', description: 'Max dependency traversal depth (default 5).' }, filter: { type: 'string', description: 'Custom glob filter for test files (e.g. "e2e/*.spec.ts").' } },
      (args, root) => ['affected', '--json', '--path', root, '-d', String(args.depth || 5)].concat(args.filter ? ['--filter', args.filter] : []).concat(args.files),
      { callDescription: 'Find affected test files' })
  }
}