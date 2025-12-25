/**
 * SQL Parser module - Tree-sitter based SQL parsing and context detection.
 */

export {
	treeSitterParser,
	parseSQL,
	offsetToPoint,
	pointToOffset,
	type SyntaxNode,
	type Tree,
	type Point,
	type Query,
	type QueryCapture,
	type QueryMatch,
} from './TreeSitterParser';

export {
	SqlContext,
	createSqlContext,
	type WrappingClause,
	type WrappingNodeKind,
	type MentionedColumn,
	type MentionedRelation,
	type TableAlias,
	type JoinContext,
} from './SqlContext';

