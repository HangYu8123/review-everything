---
name: review-first
description: Stage proposed code, document, configuration, or other changes for approval in an Agent Review Desk HTML page. Use for change requests when the plugin is active and for applying saved review decisions. Answer read-only questions directly.
---

# Review proposed changes

The active plugin routes change requests to `wait-for-review/<review-id>/review.html`. The user's explicit `Just do it: …` directive allows direct execution for that request under normal tool permissions. A request to apply a saved review authorizes only the accepted items and their approved variants.

1. Inspect the current state and identify the decision or decisions the user needs to make. Keep proposed source edits, installs, settings changes, and external actions in the review until the user approves them. Use read-only tools for inspection. If a shell command is blocked, use simple read commands or native read tools.
2. Locate the plugin root two levels above this skill directory. From the target workspace, run `node "<plugin-root>/scripts/review.cjs" new <review-id>` with a fresh lowercase ID. The command creates the review directory at the Git project root, or the current directory for a folder outside Git. It copies the bundled `review.html` intact.
3. Read the data specification at the top of the bundled `review.html`. Write adjacent `review-data.js` as one `window.REVIEW_DATA = { … };` assignment with strict JSON. Set `review_id` to the directory name. Give each card a concrete proposal, its location, and supporting evidence. Write any mockup or preview files under the same review directory and link to them where supported by the template.
4. For each file change that Git can apply, set `format` to `code`, `lang` to `diff`, and put a complete Git diff in `proposed` beginning with `diff --git`. Use the current source as the base with enough unchanged context to identify each hunk. When changes depend on each other or share a hunk, place them in one card. For alternatives, use the same format in each option's `text` and give each option an explicit ID. For work that requires other tools, show the proposed action and its scope on the card.
5. Run `node "<plugin-root>/scripts/review.cjs" check <review-id>`. Fix validation errors and link `review.html` in your response. Tell the user to click **Save decisions** in that page, then say `Apply review <review-id>`. If the browser downloads the decisions JSON, ask the user to move it beside the HTML with the original filename.

## Apply saved decisions

On `Apply review <review-id>`, call `node "<plugin-root>/scripts/review.cjs" apply <review-id>` from the same workspace. It uses the latest saved JSON in the review directory. It checks fingerprints and applies accepted Git diffs, including a selected option or an edit made in the page. Use rework feedback when the user asks for another proposal. If the current source prevents a patch from applying, report the conflict and create a new proposal for any material revision.

For work that requires tools other than Git, the same command reports the accepted manual items and the selected or edited wording. Execute only those actions under the normal tool permissions. Keep any unapproved follow-up in a new review.
