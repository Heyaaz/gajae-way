export const SLACK_MESSAGE_LIMIT = 4000;

const CODE_SEGMENTS =
	/(^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[^\n]*(?:\n|$)|^[ \t]*```[^\n]*(?:\n[\s\S]*)?$|`+[^`\n]*`+)/gm;

/** Protect Slack links before parsing code spans; code then retains literal markup and language tags. */
export function markdownToMrkdwn(text: string): string {
	const links: string[] = [];
	const markerPrefix = `\u0000SLACKLINK${crypto.randomUUID()}\u0000`;
	const protectedText = text.replace(SLACK_LINK, (link) => {
		const index = links.push(link) - 1;
		return `${markerPrefix}${index}\u0000`;
	});
	if (links.length === 0) {
		const segments = text.split(CODE_SEGMENTS);
		return segments.map((segment, index) => (index % 2 === 1 ? segment : convertText(segment))).join("");
	}
	const linkMarkers = new RegExp(`${markerPrefix}(\\d+)\\u0000`, "g");
	const keepLink = links.map(() => false);
	const scanSegments = protectedText.split(CODE_SEGMENTS);
	let angleDepth = 0;
	const updateAngleDepth = (segment: string): void => {
		for (const character of segment) {
			if (character === "<") angleDepth++;
			else if (character === ">" && angleDepth > 0) angleDepth--;
		}
	};
	// Ignore literal angle brackets in code while retaining unmatched prose brackets across code segments.
	for (let segmentIndex = 0; segmentIndex < scanSegments.length; segmentIndex++) {
		const segment = scanSegments[segmentIndex] ?? "";
		linkMarkers.lastIndex = 0;
		if (segmentIndex % 2 === 1) {
			for (const match of segment.matchAll(linkMarkers)) keepLink[Number(match[1])] = true;
			continue;
		}
		let last = 0;
		for (const match of segment.matchAll(linkMarkers)) {
			updateAngleDepth(segment.slice(last, match.index));
			keepLink[Number(match[1])] = angleDepth === 0;
			last = match.index + match[0].length;
		}
		updateAngleDepth(segment.slice(last));
	}
	linkMarkers.lastIndex = 0;
	const textForConversion = protectedText.replace(linkMarkers, (marker, index: string) =>
		keepLink[Number(index)] ? marker : (links[Number(index)] ?? marker),
	);
	const escapeProtectedLinks = (value: string): string => {
		linkMarkers.lastIndex = 0;
		return value.replace(linkMarkers, (marker, index: string) => escapeHtml(links[Number(index)] ?? marker));
	};
	const segments = textForConversion.split(CODE_SEGMENTS);
	const converted = segments
		.map((segment, index) => (index % 2 === 1 ? segment : convertText(segment, escapeProtectedLinks)))
		.join("");
	linkMarkers.lastIndex = 0;
	return converted.replace(linkMarkers, (_marker, index: string) => links[Number(index)] ?? _marker);
}

/**
 * Slack's own angle-bracket syntax, which must survive HTML escaping: user
 * mentions, channel links, and broadcast keywords. Everything else in angle
 * brackets is text and is escaped. Until this existed every `<@U\u2026>` the
 * persona wrote went out as `&lt;@U\u2026&gt;` and pinged nobody (2026-09-17).
 */
const SLACK_ENTITY =
	/<(?:@[UW][A-Z0-9]+(?:\|[^>\n]*)?|#C[A-Z0-9]+(?:\|[^>\n]*)?|!(?:here|channel|everyone)(?:\|[^>\n]*)?|!subteam\^[A-Z0-9]+(?:\|[^>\n]*)?)>/g;

/** Slack URLs and labels are protected before code-span and Markdown parsing. */
const SLACK_LINK = /<(?:https?:\/\/|mailto:)[^\s<>|]+(?:\|[^<>\n]*)?>/gi;

function escapeKeepingEntities(text: string): string {
	const parts: string[] = [];
	let last = 0;
	for (const match of text.matchAll(SLACK_ENTITY)) {
		parts.push(escapeHtml(text.slice(last, match.index)), match[0]);
		last = match.index + match[0].length;
	}
	parts.push(escapeHtml(text.slice(last)));
	return parts.join("");
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function convertText(text: string, escapeProtectedLinks?: (value: string) => string): string {
	const escaped = escapeKeepingEntities(text);
	// One pass prevents the bold tokens we emit from being converted again as italics.
	return escaped.replace(
		/\[([^\]\n]+)\]\(([^)\n]+)\)|^(#{1,6})[ \t]+(.+)$|^([ \t]*)[-*][ \t]+|\*\*([^\n]+?)\*\*|__([^\n]+?)__|~~([^\n]+?)~~|\*([^*\n]+)\*|_([^_\n]+)_/gm,
		(
			_match,
			label: string | undefined,
			url: string,
			heading: string | undefined,
			title: string,
			indent: string | undefined,
			bold: string | undefined,
			underBold: string | undefined,
			strike: string | undefined,
			italic: string | undefined,
			underItalic: string | undefined,
		) => {
			if (label !== undefined)
				return `<${escapeProtectedLinks?.(url) ?? url}|${escapeProtectedLinks?.(label) ?? label}>`;
			if (heading !== undefined) return `*${title}*`;
			if (indent !== undefined) return `${indent}• `;
			if (bold !== undefined || underBold !== undefined) return `*${bold ?? underBold}*`;
			if (strike !== undefined) return `~${strike}~`;
			return `_${italic ?? underItalic}_`;
		},
	);
}

type Fence = { readonly start: number; readonly end: number; readonly opener: string; readonly open: boolean };

/** Synthetic fence closers/openers count toward Slack's limit, not just the source text. */
export function chunkSlackMessage(text: string): string[] {
	if (text.length <= SLACK_MESSAGE_LIMIT) return [text];
	const fences: Fence[] = [];
	let open = false;
	for (const match of text.matchAll(/^[ \t]*```[^\n]*(?:\n|$)/gm)) {
		open = !open;
		fences.push({ start: match.index, end: match.index + match[0].length, opener: match[0].trimEnd(), open });
	}
	const stateAt = (position: number): string | undefined => {
		let opener: string | undefined;
		for (const fence of fences) {
			if (fence.end > position) break;
			opener = fence.open ? fence.opener : undefined;
		}
		return opener;
	};
	const chunks: string[] = [];
	let offset = 0;
	let prefix = "";
	while (offset < text.length) {
		const budget = SLACK_MESSAGE_LIMIT - prefix.length;
		if (text.length - offset <= budget) {
			chunks.push(prefix + text.slice(offset));
			break;
		}
		let end = offset + budget;
		// Reserve a closer before selecting a boundary, then avoid cutting a delimiter.
		if (fences.length > 0) end = offset + budget - 4;
		const crossing = fences.find((fence) => fence.start < end && fence.end > end);
		if (crossing && crossing.start > offset) end = crossing.start;
		const newline = text.lastIndexOf("\n", end - 1) + 1;
		let preferred = 0;
		for (let candidate = newline; candidate > offset; candidate = text.lastIndexOf("\n", candidate - 2) + 1) {
			if (!stateAt(candidate)) {
				preferred = candidate;
				break;
			}
		}
		if (preferred > offset) end = preferred;
		else if (newline > offset) end = newline;
		// Avoid cutting a surrogate pair at a forced hard break.
		if (end > offset && /[\uD800-\uDBFF]/.test(text[end - 1] as string) && /[\uDC00-\uDFFF]/.test(text[end] as string))
			end--;
		const opener = stateAt(end);
		chunks.push(prefix + text.slice(offset, end) + (opener ? "\n```" : ""));
		// Reopened fences need no language tag; omitting it also bounds hostile tags.
		prefix = opener ? "```\n" : "";
		offset = end;
	}
	return chunks;
}
