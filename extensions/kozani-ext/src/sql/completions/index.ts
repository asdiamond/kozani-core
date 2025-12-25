/**
 * SQL Completions module - Tree-sitter based context-aware SQL completions.
 */

export { complete } from './complete';
export {
	isRelevant,
	filterCompletions,
	type CompletionRelevanceData,
	type CompletionItemType,
} from './filtering';
export {
	calculateScore,
	sortByScore,
	type ScoredCompletionItem,
} from './scoring';

