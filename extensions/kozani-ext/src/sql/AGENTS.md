# SQL Language Service - Agent Guide

This document describes the SQL language features module for Kozani's SQL notebooks.

## Overview

The `sql/` module provides IDE-like language features for PostgreSQL SQL in notebook cells:
- **Completions**: Context-aware table/column/function suggestions
- **Hover**: Rich documentation on hover (table columns, types, descriptions)
- **Go to Definition**: Jump to schema YAML files
- **Diagnostics**: Real-time syntax validation (red squiggles)

## Architecture

```
sql/
├── index.ts                    # Main entry point, registers all providers
├── SqlLanguageService.ts       # Orchestrates all language features
├── types.ts                    # Type definitions and schema conversion
├── parser/                     # Tree-sitter based SQL parsing
│   ├── TreeSitterParser.ts     # WASM parser wrapper (singleton)
│   └── SqlContext.ts           # Context detection (clause, qualifiers, etc.)
├── completions/                # Completion generation and ranking
│   ├── complete.ts             # Main completion entry point
│   ├── filtering.ts            # Context-based filtering
│   └── scoring.ts              # Relevance scoring algorithm
├── validator/                  # libpg_query validation
│   └── SqlValidator.ts         # Async WASM validation
├── providers/                  # VS Code provider implementations
│   ├── HoverProvider.ts
│   ├── DefinitionProvider.ts
│   ├── CompletionProvider.ts
│   └── DiagnosticsProvider.ts
├── schema/                     # Schema data loading
│   └── SchemaLoader.ts         # Loads .kozani/ YAML files with caching
├── grammar/                    # Tree-sitter grammar (pgls)
│   ├── grammar.js              # Grammar definition
│   └── src/                    # Generated parser
└── wasm/                       # Pre-built WASM binaries
    └── tree-sitter-pgls.wasm
```

## Design Decisions

### 1. Two-Parser Strategy

We use **two different parsers** for different purposes:

| Parser | Purpose | Characteristics |
|--------|---------|-----------------|
| **Tree-sitter (pgls)** | Completions, context detection | Error-tolerant, handles incomplete SQL, WASM |
| **libpg_query (pgsql-parser)** | Validation, diagnostics | 100% accurate Postgres parser, only works on complete statements |

**Rationale**: Tree-sitter gracefully handles partial input (e.g., `SELECT * FROM u|` where `|` is cursor), which is essential for completions. libpg_query only works on complete statements but provides exact Postgres parser errors.

### 2. Tree-Sitter Grammar (pgls)

The `grammar/` folder contains a **custom tree-sitter grammar** called "pgls" (PostgreSQL Language Server), forked from the [postgres-language-server](../../../postgres-language-server/) project's grammar.

Key design choices:
- Named identifier nodes (`column_identifier`, `table_identifier`, `schema_identifier`, `any_identifier`) for precise context detection
- Reference nodes (`object_reference`, `table_reference`, `column_reference`) that wrap identifiers with their qualifiers
- Clause-specific nodes (`select`, `from`, `where`, `join`) for clause detection

**The WASM file lives in two places:**
1. `grammar/tree-sitter-pgls.wasm` - source/build output
2. `wasm/tree-sitter-pgls.wasm` - runtime copy loaded by TreeSitterParser

### 3. Context Detection (SqlContext)

The `SqlContext` class analyzes the parsed tree to determine:
- **wrappingClause**: What SQL clause the cursor is in (`select`, `from`, `where`, `join`, etc.)
- **wrappingNodeKind**: Node structure context (`relation`, `binaryExpression`, `list`)
- **identifierQualifiers**: What's before the dot (`schema.table.column` → `[schema, table]`)
- **mentionedRelations**: Tables referenced in FROM/JOIN (for boosting relevant columns)
- **tableAliases**: Alias-to-table mapping (for resolving `t.id` → `users.id`)

This is a **port from postgres-language-server's Rust implementation**. The original Rust uses tree-sitter queries extensively; this TypeScript version uses a mix of tree walking and queries.

### 4. Completion Filtering & Scoring

Completions go through a pipeline:
1. **Generation**: Create candidates (all tables, columns from mentioned tables, functions, keywords)
2. **Filtering** (`filtering.ts`): Remove irrelevant items based on context
3. **Scoring** (`scoring.ts`): Rank remaining items by relevance

Key filtering rules:
- Tables only valid in `FROM`, `JOIN`, `UPDATE`, `DELETE`, `INSERT INTO`
- Columns only valid in `SELECT`, `WHERE`, `JOIN ON`, `GROUP BY`, `ORDER BY`
- Qualifiers must match (if user types `users.`, only show columns from `users`)

Key scoring factors:
- Fuzzy match with current input (prefix match > substring > character match)
- User-defined vs system schemas (boost `public`, penalize `pg_catalog`)
- Mentioned relations (if `users` is in FROM, boost `users.id`)
- Already-mentioned penalty (don't repeat columns already in SELECT)

### 5. Schema Data Source

Schema comes from **local `.kozani/` YAML files**, NOT from live database connections.

```
.kozani/{connection}/schemas/{schema}.yaml
```

The `SchemaLoader` class:
- Caches loaded schemas in memory
- Watches for file changes to invalidate cache
- Builds lookup maps (`tablesByFullName`, `tablesByName`, `columnsByName`)

**This is the source of truth for schema-aware features.**

### 6. Notebook Cell Integration

The language service only works for **notebook cells**, not standalone SQL files:
- Document selector: `{ language: 'pgsql', scheme: 'vscode-notebook-cell' }`
- Connection is read from **notebook metadata** (`notebook.metadata.connectionName`)

Each notebook cell is a separate `TextDocument`. The provider finds the parent notebook to get the connection name.

## Known Issues / Rough Points

### 1. Qualifier Detection Edge Cases

The `extractQualifiers()` function sometimes struggles with:
- Quoted identifiers (`"weird-schema"."weird-table"`)
- Mixed casing during alias resolution

**Workaround**: Qualifiers are sanitized by removing quotes, but this can cause issues with truly unusual names.

### 2. Tree-Sitter Parser Initialization

The parser is **lazily initialized** and async:
```typescript
await treeSitterParser.init();
```

If completions are requested before init completes, it can throw. The `complete()` function handles this, but there might be edge cases.

### 3. Diagnostics for Partial Statements

The `isLikelyCompleteStatement()` heuristic is imperfect. It uses patterns like:
- Ends with `;` → complete
- Ends with `,`, `(`, `=`, `.` → incomplete

This can cause:
- False positives: Showing errors on valid incomplete SQL
- False negatives: Not validating when we should

The 500ms debounce helps, but aggressive typers might see flash errors.

### 4. WASM Path Resolution

Both parsers use WASM and have hardcoded relative paths:

**TreeSitterParser.ts:**
```typescript
const grammarPath = path.join(__dirname, '..', 'wasm', 'tree-sitter-pgls.wasm');
```

**SqlValidator.ts:**
```typescript
const pgsqlParser = require('pgsql-parser');  // Loads its own WASM
```

These work in development but can break depending on bundling/build setup.

### 5. No Cross-Statement Analysis

Context detection is **per-statement**. CTEs, subqueries, and multi-statement scripts have limited support. The `statementRange` helps scope queries to the current statement, but complex CTEs can confuse the context detector.

### 6. Functions are Hardcoded

`PG_FUNCTIONS` in `complete.ts` is a static list of ~30 common Postgres functions. There's no introspection of actual database functions. To add more functions, update the list manually.

## Integration Points

### With Notebook System
- Registered via `registerSqlLanguageFeatures()` in extension activation
- Reads connection from `notebook.metadata.connectionName`
- Only activates for `pgsql` language cells in `kozani-notebook` notebooks

### With Schema System
- Consumes `.kozani/{connection}/schemas/*.yaml` files
- Invalidates on file changes (via FileSystemWatcher)
- Uses types from `../database/kozaniFolder.ts`

### With postgres-language-server
The grammar in `grammar/` is a copy/fork. If updating:
1. Regenerate with `tree-sitter generate`
2. Copy `tree-sitter-pgls.wasm` to `wasm/`
3. Test extensively - node types might change

## Development Tips

### Debugging Completions

Enable verbose logging:
```typescript
// In filtering.ts
const VERBOSE_FILTER_DEBUG = true;

// In scoring.ts
const DEBUG_SCORING = true;
```

Then check Output > "Kozani" for detailed logs.

### Testing Parser

```typescript
import { parseSQL } from './parser';

const tree = await parseSQL('SELECT * FROM users WHERE id = 1');
console.log(tree.rootNode.toString());
```

### Regenerating Grammar

```bash
cd src/sql/grammar
npx tree-sitter generate
npx tree-sitter build --wasm
cp tree-sitter-pgls.wasm ../wasm/
```

## Future Improvements

1. **Semantic Tokens**: Add syntax highlighting via tree-sitter
2. **Signature Help**: Show function parameter hints
3. **Code Actions**: Quick fixes for common errors
4. **Reference Finding**: Find all usages of a table/column
5. **Rename Symbol**: Rename table aliases
6. **Function Introspection**: Load function signatures from schema
7. **CTE Support**: Proper handling of WITH clause column references

