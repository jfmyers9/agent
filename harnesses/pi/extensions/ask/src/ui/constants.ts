export const UI_DIMENSIONS = {
	boxMinWidth: 10,
	callLabelTruncateWidth: 50,
	editorContentPadding: 5,
	editorIndentedPadding: 7,
	editorMinWidth: 8,
	previewWideMinWidth: 90,
	previewMinRightWidth: 24,
	previewLeftMinWidth: 22,
	previewLeftMaxWidth: 34,
	previewLeftRatio: 0.34,
	submitWideMinWidth: 64,
	submitMinReviewWidth: 24,
} as const;

export const UI_TEXT = {
	questionNoteTitle: "Note:",
	reviewTitle: "Review answers",
	unanswered: "→ unanswered",
	footerInput: " Enter submit · Esc close",
	footerNote: " Enter save · Esc close",
	footerSubmit: " 1..3 hotkeys · ↑↓ select · Enter confirm · Esc cancel",
	footerMulti: " ⇆ tab · ↑↓/j/k select · Space toggle · Enter continue · N/Shift+N note · Esc dismiss",
	footerDefault: " ⇆ tab · ↑↓/j/k select · Enter confirm · N/Shift+N note · Esc dismiss",
	footerSingleMulti: " ↑↓/j/k select · Space toggle · Enter submit · N/Shift+N note · Esc dismiss",
	footerSingleDefault: " ↑↓/j/k select · Enter submit · N/Shift+N note · Esc dismiss",
	editorPlaceholderInput: "Type answer...",
	editorPlaceholderNote: "Add a note...",
} as const;
