package tree_sitter_pgls_test

import (
	"testing"

	tree_sitter "github.com/smacker/go-tree-sitter"
	"github.com/tree-sitter/tree-sitter-pgls"
)

func TestCanLoadGrammar(t *testing.T) {
	language := tree_sitter.NewLanguage(tree_sitter_pgls.Language())
	if language == nil {
		t.Errorf("Error loading Pgls grammar")
	}
}
